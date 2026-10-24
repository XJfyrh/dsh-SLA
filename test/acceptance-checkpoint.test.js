import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { inventory } from '../src/workspace.js';
import { verifyCheckpoint, verifyInvocationChain } from '../scripts/verify-long-horizon.mjs';

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
