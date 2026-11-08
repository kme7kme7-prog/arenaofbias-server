// Codex Desktop cumulative telemetry only. Never retains or returns conversation text.
import { resolve, relative, isAbsolute } from 'node:path';
const valid = value => Number.isSafeInteger(value) && value >= 0;
const stamp = value => { const time = Date.parse(value); return Number.isFinite(time) ? time : null; };
const unique = values => [...new Set(values)];

function userMessage(payload) {
  if (payload.type !== 'message' || payload.role !== 'user') return false;
  const content = payload.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
  return !text.trimStart().startsWith('<') && Boolean(text.trim() || (Array.isArray(content) && content.length));
}

const tokenFields = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'requests'];
function mapped(counts) {
  const usage = {};
  if (valid(counts.input_tokens) && valid(counts.cached_input_tokens)) {
    if (counts.cached_input_tokens > counts.input_tokens) throw new Error('Codex cached input exceeds total input');
    usage.input = counts.input_tokens - counts.cached_input_tokens;
  }
  for (const [key, field] of [['cached_input_tokens', 'cacheRead'], ['cache_write_input_tokens', 'cacheWrite'], ['output_tokens', 'output'], ['reasoning_output_tokens', 'reasoning']]) {
    if (valid(counts[key])) usage[field] = counts[key];
  }
  return usage;
}
function ownUsage(state) {
  const events = state.tokens.toSorted((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.order - b.order);
  if (!events.some(event => Object.keys(event.counts).length)) return [];
  const segments = [];
  let previous = {}, segment;
  for (const event of events) {
    const changed = Object.entries(event.counts).some(([key, value]) => value !== previous[key]);
    if (!segment || (event.model !== segment.model && changed)) {
      segment = { model: event.model, baseline: previous, last: event.counts, requests: 0 };
      segments.push(segment);
    }
    if (event.model === segment.model || changed) segment.last = event.counts;
    if (valid(event.counts.total_tokens) && event.counts.total_tokens > (previous.total_tokens ?? 0)) segment.requests++;
    previous = event.counts;
  }
  return segments.map(segment => {
    const end = mapped(segment.last), baseline = Object.keys(segment.baseline).length ? mapped(segment.baseline) : Object.fromEntries(tokenFields.map(field => [field, 0]));
    const usage = {};
    for (const [field, value] of Object.entries(end)) if (Object.hasOwn(baseline, field) && value >= baseline[field]) usage[field] = value - baseline[field];
    if (valid(segment.last.total_tokens)) usage.requests = segment.requests;
    return { model: segment.model, usage };
  });
}
function groupedUsage(contributions) {
  const models = new Map();
  for (const item of contributions) {
    if (!models.has(item.model)) models.set(item.model, []);
    models.get(item.model).push(item.usage);
  }
  return [...models].map(([model, parts]) => {
    const usage = { source: 'log' }, incomplete = [];
    for (const field of tokenFields) {
      if (!parts.every(part => Object.hasOwn(part, field))) { incomplete.push(field); continue; }
      const value = parts.reduce((sum, part) => sum + part[field], 0);
      if (!Number.isSafeInteger(value)) throw new Error('Usage total exceeds safe integer range');
      if (field !== 'cacheWrite' || value > 0) usage[field] = value;
    }
    return { ...(model ? { model } : {}), usage, ...(incomplete.length ? { incomplete } : {}) };
  });
}

export function createCodexCollector() {
  const files = new Map();
  let order = 0;
  return {
    add(record, file = 'synthetic-file') {
      const payload = record.payload;
      if (!payload || typeof payload !== 'object') return;
      if (record.type === 'session_meta' && typeof payload.id === 'string') {
        if (files.has(file)) return; // Forked rollouts can replay an ancestor session_meta. First is authoritative.
        files.set(file, { id: payload.id, cwd: payload.cwd,
          parent: payload.source?.subagent?.thread_spawn?.parent_thread_id ?? null,
          at: stamp(record.timestamp), tokens: [], starts: new Map(), completes: new Map(), users: new Set(), models: [], efforts: [] });
        return;
      }
      const state = files.get(file);
      if (!state) return;
      const at = stamp(record.timestamp), key = `${record.timestamp}:${payload.turn_id ?? ''}`;
      if (record.type === 'turn_context') {
        if (typeof payload.model === 'string') { state.models.push(payload.model); state.model = payload.model; }
        if (typeof payload.effort === 'string') state.efforts.push(payload.effort);
      } else if (record.type === 'response_item' && userMessage(payload)) state.users.add(key);
      else if (record.type === 'event_msg') {
        if (payload.type === 'task_started') state.starts.set(key, at);
        else if (payload.type === 'task_complete') state.completes.set(key, at);
        else if (payload.type === 'token_count' && payload.info?.total_token_usage) {
          const counts = Object.fromEntries(['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']
            .filter(key => valid(payload.info.total_token_usage[key])).map(key => [key, payload.info.total_token_usage[key]]));
          state.tokens.push({ at, order: order++, counts, model: state.model ?? null });
        }
      }
    },
    finish({ session, cwd, from, to } = {}) {
      const parse = value => { const at = stamp(value); if (at == null) throw new Error('Invalid ISO time'); return at; };
      const lower = from == null ? -Infinity : parse(from), upper = to == null ? Infinity : parse(to);
      if (lower > upper) throw new Error('--from must not be after --to');
      // Desktop can reuse an id across a tokenless abandoned rollout and a later run.
      // Do not let the abandoned attempt's model, start time or user turn pollute that run.
      const attempts = new Map(), sessions = new Map();
      for (const state of files.values()) {
        if (!attempts.has(state.id)) attempts.set(state.id, []);
        attempts.get(state.id).push(state);
      }
      for (const [id, states] of attempts) {
        const withTokens = states.filter(state => state.tokens.length);
        const active = withTokens.length ? withTokens : states;
        const combined = { ...active[0], emptyAttempts: withTokens.length ? states.length - withTokens.length : 0,
          tokens: active.flatMap(s => s.tokens), starts: new Map(active.flatMap(s => [...s.starts])),
          completes: new Map(active.flatMap(s => [...s.completes])), users: new Set(active.flatMap(s => [...s.users])),
          models: active.flatMap(s => s.models), efforts: active.flatMap(s => s.efforts) };
        sessions.set(id, combined);
      }
      const children = new Map();
      for (const s of sessions.values()) if (s.parent) {
        if (!children.has(s.parent)) children.set(s.parent, []);
        children.get(s.parent).push(s);
      }
      const descendants = root => {
        const result = [], seen = new Set([root.id]);
        function walk(id) { for (const child of children.get(id) ?? []) {
          if (seen.has(child.id)) throw new Error('Codex parent chain contains a cycle');
          seen.add(child.id); result.push(child); walk(child.id);
        } }
        walk(root.id); return result;
      };
      const selected = [...sessions.values()].filter(s => session ? s.id === session : !s.parent).filter(s => {
        if (cwd) {
          if (typeof s.cwd !== 'string') return false;
          const rel = relative(resolve(cwd), resolve(s.cwd));
          if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return false;
        }
        const at = [...s.starts.values()].filter(v => v != null).sort((a, b) => a - b)[0] ?? s.at;
        return (from == null && to == null) || (at != null && at >= lower && at <= upper);
      }).sort((a, b) => a.id.localeCompare(b.id, 'en'));
      const result = [], skipped = [];
      for (const root of selected) {
        const subs = descendants(root), contributions = [], incompleteSessions = [];
        for (const state of [root, ...subs]) {
          for (let i = 0; i < state.emptyAttempts; i++) skipped.push({ sessionId: state.id, reason: 'no-token-records' });
          const own = ownUsage(state);
          if (!own.length) { skipped.push({ sessionId: state.id, reason: 'no-token-records' }); incompleteSessions.push(state.id); }
          else contributions.push(...own);
        }
        if (!contributions.length) continue;
        const groups = groupedUsage(contributions);
        const starts = [...root.starts.values()].filter(v => v != null), completes = [...root.completes.values()].filter(v => v != null);
        let duration;
        const latestToken = Math.max(...root.tokens.map(event => event.at ?? -Infinity));
        if (starts.length && completes.length && Math.max(...completes) >= Math.max(...starts, latestToken)) {
          duration = (Math.max(...completes) - Math.min(...starts)) / 1000;
        }
        if (groups.length === 1 && duration != null) groups[0].usage.durationSec = duration;
        const efforts = unique(root.efforts);
        result.push({ sessionId: root.id, ...(root.cwd ? { cwd: root.cwd } : {}),
          ...(root.efforts.length ? { effort: root.efforts.at(-1), efforts } : {}),
          userMessages: root.users.size, turns: root.starts.size, multiTurn: root.users.size > 1 || root.starts.size > 1,
          subagentIds: subs.map(s => s.id).sort(), subagents: subs.length,
          ...(incompleteSessions.length ? { incompleteSessions } : {}),
          ...(groups.length > 1 ? { mixedModels: true, byModel: groups, ...(duration != null ? { durationSec: duration } : {}) } : groups[0]) });
      }
      return { sessions: result, skipped };
    },
  };
}

export function aggregateCodexUsage(logs, options) {
  const collector = createCodexCollector();
  logs.forEach((records, file) => records.forEach(record => collector.add(record, file)));
  return collector.finish(options);
}
