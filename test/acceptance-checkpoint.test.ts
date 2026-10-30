import { Context } from '@deepseek-ai/cordis';
import type { SessionEvent } from '@deepseek-ai/dsh-session/types';
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inventory } from '../dist/src/workspace.js';
import { readJson } from '../scripts/json.ts';
import { apply, campaignInputSchema, summarizeNativeArchive, verifyCheckpoint, verifyInvocationChain } from '../scripts/verify-long-horizon.ts';
import { candidateFixture, object, runFixture, trialFixture } from './state-fixtures.ts';

test('acceptance continuation rejects altered baseline, retained candidate and frozen evaluation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sla-checkpoint-'));
  const baselineDir = path.join(root, 'initial'), dir = path.join(root, 'candidate'), evaluationDir = path.join(root, 'criteria');
  await mkdir(baselineDir); await mkdir(dir); await mkdir(path.join(evaluationDir, '.sla'), { recursive: true });
  await writeFile(path.join(baselineDir, 'value.txt'), 'initial');
  await writeFile(path.join(dir, 'value.txt'), 'candidate');
  const evaluator = path.join(evaluationDir, '.sla/check.js');
  await writeFile(evaluator, 'frozen');
  const run = runFixture({ baselineDir, sourceFiles: await inventory(baselineDir), best: candidateFixture({ trial: 1, dir }),
    trials: [trialFixture({ number: 1, files: await inventory(dir) })], directions: [], evaluationDir,
    evaluationFiles: { 'check.js': createHash('sha256').update('frozen').digest('hex') } });
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
  const logs: Record<string, { session: { parentSession: SessionId } }> = { child: { session: { parentSession: SessionId('owner') } }, owner: { session: { parentSession: SessionId('root') } } };
  const query = { async readSession(id: SessionId) { return logs[id]; } };
  assert.equal((await verifyInvocationChain(query, 'root', [{ childId: 'child' }])).get('child'), logs.child);
  await assert.rejects(verifyInvocationChain(query, 'other-root', [{ childId: 'child' }]), /another root/);
  await assert.rejects(verifyInvocationChain(query, 'root', [{ childId: 'missing' }]), /parent is missing/);
});

test('native archive audit preserves interrupted raw events and rejects mismatched roots', async () => {
  const bytes = (id: string, parentSession?: string, events: SessionEvent[] = []) => new TextEncoder().encode([
    { type: 'session', version: SESSION_FORMAT_VERSION, id, parentSession, createdAt: 0, isSeeded: false, delegationDepth: 0 }, ...events,
  ].map(item => JSON.stringify(item)).join('\n') + '\n');
  const events: SessionEvent[] = [{ seq: SessionSeq(0), time: 0, type: 'turn/start', data: { turn: 1 } }, { seq: SessionSeq(1), time: 1, type: 'step/start', data: { turn: 1, step: 1 } }];
  const files: Record<string, Uint8Array> = { 'session.v4.jsonl': bytes('root'), 'subagents/owner/session.v4.jsonl': bytes('owner', 'root'),
    'subagents/child/session.v4.jsonl': bytes('child', 'owner', events) };
  const calls = [{ role: 'worker', childId: 'child' }];
  let observed: readonly SessionEvent[] | undefined;
  const derive = (turn: readonly SessionEvent[]) => { observed = turn; return turn.at(-1)?.type === 'turn/end' ? { total: 12 } : undefined; };
  const { usage, observations } = await summarizeNativeArchive(files, 'root', calls, derive);
  assert.deepEqual(observed, events);
  assert.equal(usage[0].complete, false);
  assert.deepEqual(usage[0].exactTurns, [null]);
  assert.equal(observations[0].count, 2);
  assert.equal(observations[0].lastSeq, 1);
  assert.equal(observations[0].entrySha256, createHash('sha256').update(files['subagents/child/session.v4.jsonl']).digest('hex'));
  await assert.rejects(summarizeNativeArchive(files, 'foreign', calls, derive), /root differs/);
  delete files['subagents/owner/session.v4.jsonl'];
  await assert.rejects(summarizeNativeArchive(files, 'root', calls, derive), /another root/);
});


test('archive validation rejects malformed durable events before calculating token usage', async () => {
  const header = { type: 'session', version: SESSION_FORMAT_VERSION, id: 'root', createdAt: 0, isSeeded: false, delegationDepth: 0 };
  const bytes = (events: unknown[]) => new TextEncoder().encode([header, ...events].map(value => JSON.stringify(value)).join('\n') + '\n');
  let calls = 0;
  for (const event of [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 'not a number' } },
    { type: 'turn/start', seq: 3, time: 0, data: { turn: 1 } },
  ]) {
    await assert.rejects(summarizeNativeArchive({ 'session.v4.jsonl': bytes([event]) }, 'root', [], () => { calls++; return undefined; }));
  }
  assert.equal(calls, 0);
});

test('campaign configuration distinguishes model runs from archive-only export and rejects incomplete input', () => {
  const campaign = { cwd: 'project', goal: 'improve', output: 'result', settings: { maxTrials: 2 } };
  assert.deepEqual(campaignInputSchema.parse(campaign), campaign);
  const exportOnly = { exportSession: 'root', report: 'report.json', output: 'archive' };
  assert.deepEqual(campaignInputSchema.parse(exportOnly), exportOnly);
  for (const input of [null, {}, { ...campaign, maxTokens: -1 }, { ...campaign, settings: { maxTrials: '2' } },
    { ...campaign, exportSession: 42 }, { exportSession: 'root', output: 'archive' }]) {
    assert.equal(campaignInputSchema.safeParse(input).success, false);
  }
});

test('campaign reports invalid configuration without starting a model run', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sla-campaign-input-'));
  const output = path.join(root, 'result');
  const config = path.join(root, 'input.json');
  await writeFile(config, JSON.stringify({ cwd: 'project', goal: 'improve', output, settings: { maxTrials: '2' } }));
  const ctx = new Context();
  const finished = Promise.withResolvers<void>();
  t.mock.method(ctx.logger, 'info', () => finished.resolve());
  let modelRuns = 0;
  ctx.provide('agents', { async create() { modelRuns++; throw new Error('Unexpected model run'); } } satisfies Pick<Context['agents'], 'create'>);
  const previous = process.env.SLA_CAMPAIGN_INPUT;
  t.after(async () => {
    if (previous === undefined) delete process.env.SLA_CAMPAIGN_INPUT;
    else process.env.SLA_CAMPAIGN_INPUT = previous;
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  });
  process.env.SLA_CAMPAIGN_INPUT = config;
  apply(ctx);
  await finished.promise;
  const report = object(await readJson(path.join(output, 'finished.json')));
  assert.ok(typeof report.error === 'string');
  assert.match(report.error, /maxTrials/);
  assert.match(report.error, /invalid_type/);
  assert.equal(modelRuns, 0);
});
