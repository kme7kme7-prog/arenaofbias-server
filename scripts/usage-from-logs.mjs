// Reads only usage fields; never emits assistant text, tool arguments or credentials.
import { createReadStream, readdirSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { createCodexCollector } from './codex-log-usage.mjs';

const fields = { input_tokens: 'input', cache_read_input_tokens: 'cacheRead', cache_creation_input_tokens: 'cacheWrite', output_tokens: 'output' };
const valid = n => Number.isSafeInteger(n) && n >= 0;

export function createUsageCollector({ session, from, to } = {}) {
  const time = value => { const n = Date.parse(value); if (!Number.isFinite(n)) throw new Error('Invalid ISO time'); return n; };
  const start = from == null ? -Infinity : time(from), end = to == null ? Infinity : time(to);
  if (start > end) throw new Error('--from must not be after --to');
  const sessions = new Map();
  let anonymous = 0;
  return {
    add(record) {
      const id = record.sessionId;
      if (typeof id !== 'string' || (session && id !== session)) return;
      const at = Date.parse(record.timestamp);
      if ((from != null || to != null) && (!Number.isFinite(at) || at < start || at > end)) return;
      if (!sessions.has(id)) sessions.set(id, { replies: new Map(), first: Infinity, lastReply: -Infinity, timestamps: new Set() });
      const state = sessions.get(id);
      if (Number.isFinite(at)) { state.first = Math.min(state.first, at); state.timestamps.add(at); }
      if (record.type !== 'assistant' || !record.message?.usage) return;
      const usage = {};
      for (const [key, name] of Object.entries(fields)) if (valid(record.message.usage[key])) usage[name] = record.message.usage[key];
      if (!Object.keys(usage).length) return;
      // Multiple content blocks / streaming snapshots of the same reply are one API request.
      const key = record.message.id ?? record.requestId ?? record.uuid ?? `anonymous:${anonymous++}`;
      const model = typeof record.message.model === 'string' ? record.message.model : null;
      const modelKey = JSON.stringify([model, key]);
      const previous = state.replies.get(modelKey) ?? { model, usage: {} };
      for (const [field, value] of Object.entries(usage)) previous.usage[field] = Math.max(previous.usage[field] ?? 0, value);
      state.replies.set(modelKey, previous);
      if (Number.isFinite(at)) state.lastReply = Math.max(state.lastReply, at);
    },
    finish() {
      return [...sessions].filter(([, state]) => state.replies.size).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([sessionId, state]) => {
        const models = new Map();
        for (const reply of state.replies.values()) {
          if (!models.has(reply.model)) models.set(reply.model, []);
          models.get(reply.model).push(reply.usage);
        }
        const groups = [...models].map(([model, replies]) => {
          const usage = { source: 'log', requests: replies.length }, incomplete = [];
          for (const field of Object.values(fields)) {
            if (!replies.every(reply => Object.hasOwn(reply, field))) { incomplete.push(field); continue; }
            usage[field] = replies.reduce((sum, reply) => sum + reply[field], 0);
            if (!Number.isSafeInteger(usage[field])) throw new Error('Usage total exceeds safe integer range');
          }
          return { ...(model ? { model } : {}), usage, ...(incomplete.length ? { incomplete } : {}) };
        });
        const duration = state.timestamps.size > 1 && Number.isFinite(state.lastReply) && state.lastReply >= state.first
          ? { durationSec: (state.lastReply - state.first) / 1000 } : {};
        if (groups.length > 1) return { sessionId, mixedModels: true, byModel: groups, ...duration };
        Object.assign(groups[0].usage, duration);
        return { sessionId, ...groups[0] };
      });
    },
  };
}

export function aggregateClaudeUsage(records, options) {
  const collector = createUsageCollector(options);
  for (const record of records) collector.add(record);
  return collector.finish();
}

function logFiles(root) {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap(entry =>
    entry.isDirectory() ? logFiles(join(root, entry.name)) : entry.isFile() && entry.name.endsWith('.jsonl') ? [join(root, entry.name)] : []);
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    root: { type: 'string' }, file: { type: 'string', multiple: true }, session: { type: 'string' },
    from: { type: 'string' }, to: { type: 'string' }, cwd: { type: 'string' }, format: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) return console.log('node scripts/usage-from-logs.mjs --session ID [--root ~/.claude/projects | --file FILE ...]\nOr --from ISO [--to ISO]. Codex: --format codex --session ID | --cwd DIR [--root CODEX_HOME]. JSON to stdout, no writes.');
  const format = values.format ?? (values.cwd ? 'codex' : 'claude');
  if (!['claude', 'codex'].includes(format)) throw new Error('--format must be claude or codex');
  if (values.cwd && format !== 'codex') throw new Error('--cwd requires Codex format');
  if (!values.session && !values.from && !values.to && !values.cwd) throw new Error('Specify --session, --cwd or --from/--to');
  const collector = format === 'codex' ? createCodexCollector() : createUsageCollector(values);
  let root = values.root ?? (format === 'codex' ? process.env.CODEX_HOME || join(homedir(), '.codex') : join(homedir(), '.claude', 'projects'));
  const roots = format === 'codex' && existsSync(join(root, 'sessions'))
    ? [join(root, 'sessions'), ...(existsSync(join(root, 'archived_sessions')) ? [join(root, 'archived_sessions')] : [])] : [root];
  for (const file of new Set(values.file ?? roots.flatMap(logFiles))) {
    let lineNumber = 0;
    const stream = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let readError;
    stream.on('error', error => { readError = error; lines.close(); });
    try {
      for await (const line of lines) {
        lineNumber++;
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { throw new Error(`Invalid JSONL at line ${lineNumber} (content omitted)`); }
        if (record && typeof record === 'object') collector.add(record, file);
      }
    } finally { lines.close(); stream.destroy(); }
    if (readError) throw readError;
  }
  const result = collector.finish(values);
  if (format === 'codex') return console.log(JSON.stringify(result, null, 2));
  if (values.session) {
    if (!result.length) throw new Error('No matching assistant usage found; no zero-filled record emitted');
    console.log(JSON.stringify(result[0].mixedModels || result[0].incomplete ? result[0] : result[0].usage, null, 2));
  } else console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error('日志回填失败：' + error.message); process.exitCode = 1; });
}
