// Synthetic records only. No real session files are accessed by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { aggregateClaudeUsage } from '../scripts/usage-from-logs.mjs';
const reply = (id, usage, timestamp = '2026-01-01T00:00:10Z', sessionId = 'synthetic-session') =>
  ({ type: 'assistant', sessionId, timestamp, message: { id, content: [{ text: 'SYNTHETIC BODY MUST NOT BE EXPORTED' }], usage } });
const start = { type: 'user', sessionId: 'synthetic-session', timestamp: '2026-01-01T00:00:00Z' };

test('Claude usage sums disjoint input/cache/output fields and observed duration per session', () => {
  const result = aggregateClaudeUsage([start, reply('r1', { input_tokens: 10, cache_read_input_tokens: 40, cache_creation_input_tokens: 20, output_tokens: 5 }),
    reply('r2', { input_tokens: 7, cache_read_input_tokens: 80, output_tokens: 9 }, '2026-01-01T00:00:25Z')]);
  assert.deepEqual(result, [{ sessionId: 'synthetic-session', usage: { source: 'log', requests: 2, input: 17, cacheRead: 120, output: 14, durationSec: 25 }, incomplete: ['cacheWrite'] }]);
});
test('streaming and repeated file snapshots are counted once per message id', () => {
  const a = reply('r1', { input_tokens: 10, output_tokens: 1 });
  assert.deepEqual(aggregateClaudeUsage([a, a, reply('r1', { input_tokens: 10, output_tokens: 8 })])[0].usage,
    { source: 'log', requests: 1, input: 10, output: 8 });
});
test('missing fields remain absent, explicit zero retained, invalid numbers and missing usage excluded', () => {
  const result = aggregateClaudeUsage([reply('r1', { output_tokens: 0, input_tokens: -1, cache_read_input_tokens: null }), reply('r2', {}), { ...start, type: 'assistant' }]);
  assert.deepEqual(result[0].usage, { source: 'log', requests: 1, output: 0, durationSec: 10 });
  assert.deepEqual(aggregateClaudeUsage([start]), []);
});
test('session and time bounds select records without mixing sessions or inventing duration', () => {
  const records = [start, reply('a', { output_tokens: 1 }), reply('b', { output_tokens: 2 }, '2026-01-01T00:00:20Z'), reply('a', { output_tokens: 8 }, undefined, 'other')];
  assert.equal(aggregateClaudeUsage(records).length, 2);
  assert.deepEqual(aggregateClaudeUsage(records, { session: 'synthetic-session', from: '2026-01-01T00:00:11Z', to: '2026-01-01T00:00:21Z' })[0].usage,
    { source: 'log', requests: 1, output: 2 });
  assert.throws(() => aggregateClaudeUsage([], { from: 'bad' }), /Invalid ISO/);
  assert.throws(() => aggregateClaudeUsage([], { from: '2026-02-01', to: '2026-01-01' }), /after/);
});
test('missing timestamp preserves usage and does not fabricate a duration', () => {
  const a = reply('a', { output_tokens: 2 }); delete a.timestamp;
  assert.deepEqual(aggregateClaudeUsage([a])[0].usage, { source: 'log', requests: 1, output: 2 });
});
test('CLI emits directly pasteable usage, leaves synthetic logs unchanged and never exports body', t => {
  const root = mkdtempSync(join(tmpdir(), 'usage-logs-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'sample.jsonl'), contents = [start, reply('a', { input_tokens: 3, output_tokens: 8 })].map(r => JSON.stringify(r)).join('\n');
  writeFileSync(path, contents);
  const command = ['scripts/usage-from-logs.mjs', '--file', path, '--session', 'synthetic-session'];
  const run = spawnSync(process.execPath, command, { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); assert.deepEqual(JSON.parse(run.stdout).usage, { source: 'log', requests: 1, input: 3, output: 8, durationSec: 10 });
  assert.deepEqual(JSON.parse(run.stdout).incomplete, ['cacheRead', 'cacheWrite']);
  assert.equal(readFileSync(path, 'utf8'), contents); assert.ok(!run.stdout.includes('BODY'));
  writeFileSync(path, '{malformed SYNTHETIC BODY');
  const invalid = spawnSync(process.execPath, command, { encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.ok(!invalid.stderr.includes('BODY')); assert.equal(invalid.stdout, '');
});

test('CLI reports a missing file without unhandled stream errors or a fabricated record', () => {
  const run = spawnSync(process.execPath, ['scripts/usage-from-logs.mjs', '--file', '/nonexistent/synthetic-usage.jsonl', '--session', 'synthetic-session'], { encoding: 'utf8' });
  assert.equal(run.status, 1); assert.equal(run.stdout, ''); assert.match(run.stderr, /日志回填失败/);
  assert.ok(!run.stderr.includes('Unhandled'));
});

test('Claude splits models and never exposes a merged pasteable usage', () => {
  const a = reply('a', { input_tokens: 10, output_tokens: 2 }); a.message.model = 'fictional-one';
  const b = reply('b', { input_tokens: 100, output_tokens: 20 }); b.message.model = 'fictional-two';
  const row = aggregateClaudeUsage([a,b])[0];
  assert.equal(row.mixedModels, true); assert.equal(Object.hasOwn(row,'usage'), false);
  assert.deepEqual(row.byModel.map(g=>[g.model,g.usage.input,g.usage.output]), [['fictional-one',10,2],['fictional-two',100,20]]);
});
test('Claude incomplete coverage omits a partial field after reply deduplication', () => {
  const row = aggregateClaudeUsage([reply('a',{input_tokens:100,output_tokens:10}), reply('a',{input_tokens:100,output_tokens:10}), reply('b',{output_tokens:20})])[0];
  assert.equal(Object.hasOwn(row.usage,'input'),false); assert.equal(row.usage.output,30);
  assert.equal(row.usage.requests,2); assert.ok(row.incomplete.includes('input'));
});
