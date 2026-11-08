// Reads only usage fields; never emits assistant text, tool arguments or credentials.
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

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
      const previous = state.replies.get(key) ?? {};
      for (const [field, value] of Object.entries(usage)) previous[field] = Math.max(previous[field] ?? 0, value);
      state.replies.set(key, previous);
      if (Number.isFinite(at)) state.lastReply = Math.max(state.lastReply, at);
    },
    finish() {
      return [...sessions].filter(([, state]) => state.replies.size).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([sessionId, state]) => {
        const usage = { source: 'log', requests: state.replies.size };
        for (const reply of state.replies.values()) for (const [field, value] of Object.entries(reply)) {
          usage[field] = (usage[field] ?? 0) + value;
          if (!Number.isSafeInteger(usage[field])) throw new Error('Usage total exceeds safe integer range');
        }
        if (state.timestamps.size > 1 && Number.isFinite(state.lastReply) && state.lastReply >= state.first) usage.durationSec = (state.lastReply - state.first) / 1000;
        return { sessionId, usage };
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
    from: { type: 'string' }, to: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) return console.log('node scripts/usage-from-logs.mjs --session ID [--root ~/.claude/projects | --file FILE ...]\nOr --from ISO [--to ISO]. Claude Code only; Codex format pending verification. JSON to stdout, no writes.');
  if (!values.session && !values.from && !values.to) throw new Error('Specify --session or --from/--to');
  const collector = createUsageCollector(values);
  for (const file of values.file ?? logFiles(values.root ?? join(homedir(), '.claude', 'projects'))) {
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
        if (record && typeof record === 'object') collector.add(record);
      }
    } finally { lines.close(); stream.destroy(); }
    if (readError) throw readError;
  }
  const result = collector.finish();
  if (values.session) {
    if (!result.length) throw new Error('No matching assistant usage found; no zero-filled record emitted');
    console.log(JSON.stringify(result[0].usage, null, 2));
  } else console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error('日志回填失败：' + error.message); process.exitCode = 1; });
}
