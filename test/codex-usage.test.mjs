// Entirely synthetic Codex Desktop records; no user logs are accessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { aggregateCodexUsage } from '../scripts/codex-log-usage.mjs';
const at = second => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
const record = (type, payload, second = 0) => ({ timestamp: at(second), type, payload });
const meta = (id, parent, cwd = '/synthetic/project') => record('session_meta', { id, cwd, cli_version: 'synthetic',
  source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent, depth: parent === 'main' ? 1 : 2 } } } : 'cli' });
const event = (type, second, extra = {}) => record('event_msg', { type, ...extra }, second);
const tokens = (input, cached, output, reasoning, total, second, cacheWrite = 0) => event('token_count', second, { info: { total_token_usage:
  { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: cacheWrite, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: total } } });
const user = (text, second) => record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }, second);
function fixture() {
  return [
    [meta('main'), record('turn_context', { model: 'synthetic-model', effort: 'max' }), event('task_started', 0), user('   <environment injection>', 1), user('SYNTHETIC USER REQUEST', 2),
      tokens(100, 40, 20, 5, 120, 10), tokens(200, 80, 40, 10, 240, 20), tokens(200, 80, 40, 10, 240, 21), event('task_complete', 60),
      event('task_started', 70), record('turn_context', { model: 'synthetic-model', effort: 'ultra' }, 70), user('SYNTHETIC FOLLOW-UP', 71), event('task_complete', 80), event('token_count', 81, { info: null })],
    [meta('child', 'main'), meta('ancestor-replayed'), record('turn_context', {model:'synthetic-model'}), tokens(50, 20, 10, 4, 60, 15, 3)],
    [meta('grandchild', 'child'), record('turn_context', {model:'synthetic-model'}), tokens(30, 10, 5, 2, 35, 17)],
    [meta('empty-child', 'main'), event('task_started', 18), event('turn_aborted', 19)],
    [meta('abandoned', null, '/synthetic/abandoned'), event('task_started', 0), user('SYNTHETIC ABANDONED', 1), event('token_count', 2, { info: null }), event('turn_aborted', 3)],
  ];
}
test('Codex uses final cumulative snapshot and sums two descendant levels without double-counting cache or reasoning', () => {
  const report = aggregateCodexUsage(fixture(), { session: 'main' });
  assert.equal(report.sessions.length, 1);
  const row = report.sessions[0];
  assert.deepEqual(row.usage, { source: 'log', input: 170, cacheRead: 110, output: 55, reasoning: 16, requests: 4, cacheWrite: 3, durationSec: 80 });
  assert.deepEqual(row.subagentIds, ['child', 'empty-child', 'grandchild']); assert.equal(row.subagents, 3);
  assert.equal(row.model, 'synthetic-model'); assert.equal(row.effort, 'ultra');
  assert.equal(row.userMessages, 2); assert.equal(row.turns, 2); assert.equal(row.multiTurn, true);
  assert.deepEqual(row.efforts, ['max', 'ultra']);
  assert.deepEqual(report.skipped, [{ sessionId: 'empty-child', reason: 'no-token-records' }]);
});
test('Codex cwd includes subdirectories, excludes similarly prefixed neighbors and reports abandoned roots', () => {
  const logs = fixture(); logs.push([meta('neighbor', null, '/synthetic/project-other'), tokens(10, 0, 2, 0, 12, 2)]);
  assert.equal(aggregateCodexUsage(logs, { cwd: '/synthetic/project' }).sessions.length, 1);
  const all = aggregateCodexUsage(logs, { cwd: '/synthetic' });
  assert.equal(all.sessions.length, 2); assert.ok(all.skipped.some(s => s.sessionId === 'abandoned'));
});
test('Codex has no fabricated cache write or duration, and reasoning is not added to output', () => {
  const row = aggregateCodexUsage([[meta('a'), tokens(10, 4, 3, 2, 13, 2)]], { session: 'a' }).sessions[0];
  assert.deepEqual(row.usage, { source: 'log', input: 6, cacheRead: 4, output: 3, reasoning: 2, requests: 1 });
  assert.equal(row.multiTurn, false);
  assert.deepEqual(aggregateCodexUsage(fixture(), { session: 'abandoned' }), { sessions: [], skipped: [{ sessionId: 'abandoned', reason: 'no-token-records' }] });
});
test('Codex time bounds select whole main sessions; they do not clip cumulative snapshots or descendants', () => {
  assert.equal(aggregateCodexUsage(fixture(), { from: at(0), to: at(1), session: 'main' }).sessions[0].usage.output, 55);
  assert.equal(aggregateCodexUsage(fixture(), { from: at(1), session: 'main' }).sessions.length, 0);
  assert.throws(() => aggregateCodexUsage([], { from: 'invalid' }), /Invalid/);
});
test('Codex missing fields stay absent and inconsistent cached input rejects', () => {
  const minimal = event('token_count', 1, { info: { total_token_usage: { output_tokens: 7 } } });
  assert.deepEqual(aggregateCodexUsage([[meta('a'), minimal]]).sessions[0].usage, { source: 'log', output: 7 });
  assert.throws(() => aggregateCodexUsage([[meta('a'), tokens(2, 3, 1, 0, 3, 1)]]), /cached input/);
});
test('Codex CLI reads nested rollout files, emits metadata and numbers only, and preserves fixture bytes', t => {
  const root = mkdtempSync(join(tmpdir(), 'codex-usage-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'sessions/2026/01/01'); mkdirSync(dir, { recursive: true });
  const files = fixture().map((log, i) => {
    const path = join(dir, `rollout-synthetic-${i}.jsonl`), content = log.map(r => JSON.stringify(r)).join('\n'); writeFileSync(path, content); return [path, content];
  });
  const run = spawnSync(process.execPath, ['scripts/usage-from-logs.mjs', '--format', 'codex', '--root', root, '--cwd', '/synthetic/project'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); assert.deepEqual(JSON.parse(run.stdout), aggregateCodexUsage(fixture(), { session: 'main' }));
  assert.ok(!run.stdout.includes('SYNTHETIC USER')); assert.ok(!run.stdout.includes('environment injection'));
  for (const [path, content] of files) assert.equal(readFileSync(path, 'utf8'), content);
  const selected = spawnSync(process.execPath, ['scripts/usage-from-logs.mjs', '--format', 'codex', '--root', join(root, 'sessions'), '--session', 'main'], { encoding: 'utf8' });
  assert.equal(selected.status, 0, selected.stderr); assert.deepEqual(JSON.parse(selected.stdout), JSON.parse(run.stdout));
});

test('Codex splits model switches using cumulative deltas and flags incomplete last snapshots', () => {
  const logs = [[meta('a'), record('turn_context',{model:'one'}),tokens(100,40,10,2,110,1),
    record('turn_context',{model:'two'},2),tokens(150,60,30,6,180,3)]];
  const row = aggregateCodexUsage(logs).sessions[0];
  assert.equal(row.mixedModels,true); assert.equal(Object.hasOwn(row,'usage'),false);
  assert.deepEqual(row.byModel.map(g=>[g.model,g.usage.input,g.usage.output,g.usage.requests]),[['one',60,10,1],['two',30,20,1]]);
  logs[0].push(event('token_count',4,{info:{total_token_usage:{output_tokens:40,total_tokens:190}}}));
  const partial = aggregateCodexUsage(logs).sessions[0].byModel[1];
  assert.equal(Object.hasOwn(partial.usage,'input'),false); assert.ok(partial.incomplete.includes('input'));
});
test('Codex excludes model contexts with no token records from mixed-model detection', () => {
  const row = aggregateCodexUsage([[meta('a'),record('turn_context',{model:'unused'}),event('token_count',1,{info:null}),
    record('turn_context',{model:'used'},2),tokens(10,0,2,0,12,3)]]).sessions[0];
  assert.equal(row.model,'used'); assert.equal(row.mixedModels,undefined);
});
test('Codex retains descendants when parent has no token record and omits stale duration', () => {
  const row = aggregateCodexUsage([[meta('a')],[meta('child','a'),tokens(10,0,2,0,12,3)]]).sessions[0];
  assert.equal(row.usage.input,10); assert.deepEqual(row.incompleteSessions,['a']);
  const ongoing = aggregateCodexUsage([[meta('a'),event('task_started',0),tokens(10,0,2,0,12,2),event('task_complete',3),event('task_started',4),tokens(20,0,5,0,25,5),event('turn_aborted',6)]]).sessions[0];
  assert.equal(ongoing.usage.durationSec,undefined);
});

test('Codex home includes archived abandoned sessions, without turning their unused models into mixed usage', t => {
  const root=mkdtempSync(join(tmpdir(),'codex-archive-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'sessions'));mkdirSync(join(root,'archived_sessions'));
  writeFileSync(join(root,'sessions','rollout-used.jsonl'),[meta('used'),record('turn_context',{model:'used-model'}),tokens(10,0,2,0,12,1)].map(r=>JSON.stringify(r)).join('\n'));
  writeFileSync(join(root,'archived_sessions','rollout-abandoned.jsonl'),[meta('unused'),record('turn_context',{model:'unused-model'}),event('task_started',0),event('turn_aborted',1)].map(r=>JSON.stringify(r)).join('\n'));
  const run=spawnSync(process.execPath,['scripts/usage-from-logs.mjs','--format','codex','--root',root,'--cwd','/synthetic/project'],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);const result=JSON.parse(run.stdout);
  assert.equal(result.sessions.length,1);assert.equal(result.sessions[0].model,'used-model');assert.equal(result.sessions[0].mixedModels,undefined);
  assert.deepEqual(result.skipped,[{sessionId:'unused',reason:'no-token-records'}]);
});

test('Codex tokenless rollout with a reused id cannot alter model, turns or start time of the active attempt', () => {
  const abandoned=[meta('same'),record('turn_context',{model:'unused'}),event('task_started',0),user('SYNTHETIC ABANDONED',1),event('turn_aborted',2)];
  const active=[meta('same'),record('turn_context',{model:'used'}),event('task_started',7),user('SYNTHETIC REQUEST',8),tokens(10,0,2,0,12,9),event('task_complete',17)];
  const report=aggregateCodexUsage([abandoned,active]);const row=report.sessions[0];
  assert.equal(row.model,'used');assert.equal(row.multiTurn,false);assert.equal(row.userMessages,1);assert.equal(row.turns,1);assert.equal(row.usage.durationSec,10);
  assert.deepEqual(report.skipped,[{sessionId:'same',reason:'no-token-records'}]);
});

test('Codex an empty final cumulative snapshot cannot reuse older complete fields', () => {
  const row=aggregateCodexUsage([[meta('a'),tokens(10,0,2,0,12,1),event('token_count',2,{info:{total_token_usage:{}}})]]).sessions[0];
  assert.deepEqual(row.usage,{source:'log'});assert.ok(row.incomplete.includes('input'));assert.ok(row.incomplete.includes('requests'));
});

test('Codex decreasing counters start a new epoch, preserve previous consumption and report numeric reset position', () => {
  const row=aggregateCodexUsage([[meta('a'),tokens(100,40,10,2,110,1),tokens(20,5,3,1,23,2),tokens(40,10,6,2,46,3)]]).sessions[0];
  assert.deepEqual(row.usage,{source:'log',input:90,cacheRead:50,output:16,reasoning:4,requests:3});
  assert.equal(row.counterReset.length,1);assert.equal(row.counterReset[0].sessionId,'a');assert.equal(row.counterReset[0].snapshot,2);
  assert.equal(row.counterReset[0].before.total_tokens,110);assert.equal(row.counterReset[0].after.total_tokens,23);
  assert.ok(row.counterReset[0].fields.includes('input_tokens'));assert.equal(row.incomplete,undefined);
});
test('Codex empty or partial intermediate snapshots do not clear the last known request baseline', () => {
  for(const counts of [{},{output_tokens:10}]) {
    const row=aggregateCodexUsage([[meta('a'),tokens(100,40,10,2,110,1),event('token_count',2,{info:{total_token_usage:counts}}),tokens(100,40,10,2,110,3)]]).sessions[0];
    assert.equal(row.usage.requests,1);assert.equal(row.usage.input,60);assert.equal(row.usage.output,10);
    assert.equal(row.counterReset,undefined);assert.equal(row.incomplete,undefined);
  }
});
test('Codex reset across reused-id rollouts counts epochs instead of taking the maximum', () => {
  const row=aggregateCodexUsage([[meta('same'),tokens(100,40,10,2,110,1)],
    [meta('same'),tokens(20,5,3,1,23,2),tokens(40,10,6,2,46,3)]]).sessions[0];
  assert.equal(row.usage.input,90);assert.equal(row.usage.cacheRead,50);assert.equal(row.usage.output,16);assert.equal(row.usage.requests,3);
  assert.equal(row.counterReset.length,1);
});
test('Codex stale-looking decrease and recovery is explicitly flagged as an epoch assumption', () => {
  const row=aggregateCodexUsage([[meta('a'),tokens(100,40,10,2,110,1),tokens(20,5,3,1,23,2),tokens(100,40,10,2,110,3)]]).sessions[0];
  assert.equal(row.counterReset.length,1);assert.equal(row.usage.input,120);assert.equal(row.usage.cacheRead,80);
  assert.equal(row.usage.output,20);assert.equal(row.usage.requests,3);
});
test('Codex reset plus empty snapshot plus duplicate retains request baseline; final empty stays incomplete', () => {
  const logs=[[meta('a'),tokens(100,40,10,2,110,1),tokens(20,5,3,1,23,2),event('token_count',3,{info:{total_token_usage:{}}}),tokens(20,5,3,1,23,4)]];
  const row=aggregateCodexUsage(logs).sessions[0];
  assert.equal(row.usage.requests,2);assert.equal(row.usage.input,75);assert.equal(row.counterReset.length,1);
  logs[0].push(event('token_count',5,{info:{total_token_usage:{}}}));
  const incomplete=aggregateCodexUsage(logs).sessions[0];
  assert.deepEqual(incomplete.usage,{source:'log'});assert.ok(incomplete.incomplete.includes('requests'));
  assert.equal(incomplete.counterReset.length,1);
});
test('Codex reset with unknown boundary fields omits those fields even when later filled', () => {
  const logs=[[meta('a'),tokens(100,40,10,2,110,1),event('token_count',2,{info:{total_token_usage:{output_tokens:3,total_tokens:23}}}),tokens(40,10,6,2,46,3)]];
  const row=aggregateCodexUsage(logs).sessions[0];
  assert.equal(row.usage.input,undefined);assert.equal(row.usage.cacheRead,undefined);assert.equal(row.usage.output,16);assert.equal(row.usage.requests,3);
  assert.ok(row.incomplete.includes('input'));assert.ok(row.incomplete.includes('cacheRead'));assert.equal(row.counterReset.length,1);
  // Per-field last-known values can come from different snapshots; do not treat them as one complete input/cache pair.
  const partialBefore=aggregateCodexUsage([[meta('b'),tokens(100,40,10,2,110,1),event('token_count',2,{info:{total_token_usage:{cached_input_tokens:120}}}),tokens(20,5,3,1,23,3)]]).sessions[0];
  assert.equal(partialBefore.usage.input,undefined);assert.ok(partialBefore.incomplete.includes('input'));assert.equal(partialBefore.counterReset.length,1);
});
test('Codex model switch and reset are reported separately, including descendant reset diagnostics', () => {
  const report=aggregateCodexUsage([[meta('a'),record('turn_context',{model:'one'}),tokens(100,40,10,2,110,1),
    record('turn_context',{model:'two'},2),tokens(20,5,3,1,23,3),tokens(40,10,6,2,46,4)]]);
  const row=report.sessions[0];assert.equal(row.mixedModels,true);assert.equal(row.counterReset.length,1);
  assert.deepEqual(row.byModel.map(g=>[g.model,g.usage.input,g.usage.requests]),[['one',60,1],['two',30,2]]);
  const child=aggregateCodexUsage([[meta('a'),tokens(1,0,1,0,2,1)],[meta('c','a'),tokens(100,40,10,2,110,1),tokens(20,5,3,1,23,2)]]).sessions[0];
  assert.equal(child.counterReset[0].sessionId,'c');
});

test('Codex empty snapshots on a tokenless model switch do not erase the previous model boundary', () => {
  const logs=[[meta('a'),record('turn_context',{model:'one'}),tokens(100,40,10,2,110,1),
    record('turn_context',{model:'two'},2),event('token_count',3,{info:{total_token_usage:{}}})]];
  const unused=aggregateCodexUsage(logs).sessions[0];
  assert.equal(unused.model,'one');assert.equal(unused.usage.input,60);assert.equal(unused.incomplete,undefined);
  logs[0].push(tokens(150,60,30,6,180,4));
  const row=aggregateCodexUsage(logs).sessions[0];
  assert.equal(row.mixedModels,true);assert.deepEqual(row.byModel.map(g=>[g.model,g.usage.input,g.usage.output,g.usage.requests]),[['one',60,10,1],['two',30,20,1]]);
  assert.ok(row.byModel.every(g=>!g.incomplete));assert.equal(row.counterReset,undefined);
});
