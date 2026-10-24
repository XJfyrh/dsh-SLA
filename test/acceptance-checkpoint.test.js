import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { inventory } from '../src/workspace.js';
import { verifyCheckpoint, verifyInvocationChain, summarizeNativeArchive } from '../scripts/verify-long-horizon.mjs';

test('acceptance continuation rejects altered baseline, retained candidate and frozen evaluation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sla-checkpoint-'));
  const baselineDir = path.join(root, 'initial'), dir = path.join(root, 'candidate'), evaluationDir = path.join(root, 'criteria');
  await mkdir(baselineDir); await mkdir(dir); await mkdir(path.join(evaluationDir, '.sla'), { recursive: true });
  await writeFile(path.join(baselineDir, 'value.txt'), 'initial');
  await writeFile(path.join(dir, 'value.txt'), 'candidate');
  const evaluator = path.join(evaluationDir, '.sla/check.js');
  await writeFile(evaluator, 'frozen');
  const run = { baselineDir, sourceFiles: await inventory(baselineDir), best: { trial: 1, dir },
    trials: [{ number: 1, files: await inventory(dir) }], directions: [], evaluationDir,
    evaluationFiles: { 'check.js': createHash('sha256').update('frozen').digest('hex') } };
  await verifyCheckpoint(run);
  await writeFile(path.join(baselineDir, 'value.txt'), 'changed');
  await assert.rejects(verifyCheckpoint(run), /baseline files differ/);
  await writeFile(path.join(baselineDir, 'value.txt'), 'initial');
  await writeFile(path.join(dir, 'value.txt'), 'changed');
  await assert.rejects(verifyCheckpoint(run), /candidate files differ/);
  await writeFile(path.join(dir, 'value.txt'), 'candidate');
  await writeFile(evaluator, 'changed');
  await assert.rejects(verifyCheckpoint(run), /内容被修改/);
});

test('native acceptance export rejects invocation logs belonging to another root', async () => {
  const logs = { child: { session: { parentSession: 'owner' } }, owner: { session: { parentSession: 'root' } } };
  const query = { async readSession(id) { return logs[id]; } };
  assert.equal((await verifyInvocationChain(query, 'root', [{ childId: 'child' }])).get('child'), logs.child);
  await assert.rejects(verifyInvocationChain(query, 'other-root', [{ childId: 'child' }]), /another root/);
  await assert.rejects(verifyInvocationChain(query, 'root', [{ childId: 'missing' }]), /parent is missing/);
});

test('native archive audit preserves interrupted raw events and rejects mismatched roots', async () => {
  const bytes = (id, parentSession, events = []) => new TextEncoder().encode([
    { type: 'session', id, parentSession }, ...events,
  ].map(item => JSON.stringify(item)).join('\n') + '\n');
  const events = [{ seq: 0, type: 'turn/start' }, { seq: 1, type: 'tool/call' }];
  const files = { 'session.v2.jsonl': bytes('root'), 'subagents/owner/session.v2.jsonl': bytes('owner', 'root'),
    'subagents/child/session.v2.jsonl': bytes('child', 'owner', events) };
  const calls = [{ role: 'worker', childId: 'child' }];
  let observed;
  const derive = turn => { observed = turn; return turn.at(-1)?.type === 'turn/end' ? { total: 12 } : undefined; };
  const { usage, observations } = await summarizeNativeArchive(files, 'root', calls, derive);
  assert.deepEqual(observed, events);
  assert.equal(usage[0].complete, false);
  assert.deepEqual(usage[0].exactTurns, [null]);
  assert.equal(observations[0].count, 2);
  assert.equal(observations[0].lastSeq, 1);
  assert.equal(observations[0].entrySha256, createHash('sha256').update(files['subagents/child/session.v2.jsonl']).digest('hex'));
  await assert.rejects(summarizeNativeArchive(files, 'foreign', calls, derive), /root differs/);
  delete files['subagents/owner/session.v2.jsonl'];
  await assert.rejects(summarizeNativeArchive(files, 'root', calls, derive), /another root/);
});
