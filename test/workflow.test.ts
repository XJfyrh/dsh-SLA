import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import type { NativeDefinition, WorkflowContext } from '../dist/src/contracts.js';
import type { Run } from '../dist/src/data.js';
import { ExplorationEngine } from '../dist/src/engine.js';
import { isRecord } from '../dist/src/errors.js';
import { jsonArtifact, verifyJsonArtifact } from '../dist/src/json-artifacts.js';
import { acceptSelection, artifactById } from '../dist/src/kernel.js';
import type { RunStore, RuntimeAdapter } from '../dist/src/runtime-contracts.js';
import { WorkflowRegistry } from '../dist/src/workflow-registry.js';
import { parseJson } from '../scripts/json.ts';
import { getRun, parentAgent, settle } from './runtime-fixtures.ts';
import { best, candidateFixture, numeric, object, present } from './state-fixtures.ts';

const parent = parentAgent('parameters');
const assignment = (lane = 'default') => ({ direction: 'tuning', lane, hypothesis: 'reduce the parameter', instructions: 'try a smaller value', evidenceTrials: [] });

interface FixtureOptions { lanes?: boolean; reverse?: boolean;
  produce?: Parameters<WorkflowContext['search']>[0]['produce']; workflow?: Partial<NativeDefinition>;
}
function isParameter(value: unknown): value is { x: number } { return isRecord(value) && typeof value.x === 'number'; }
function parameter(value: unknown) { assert.ok(isParameter(value)); return value; }
async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sla-workflow-')), cwd = path.join(root, 'empty-workspace'); await mkdir(cwd);
  const records = new Map<string, Run>(), calls: string[] = [], evidence: unknown[][] = [];
  const store = { get: id => records.get(id), entries: () => records.entries(), put: async (id, value) => { records.set(id, structuredClone(value)); } } satisfies RunStore;
  const workflow: NativeDefinition = { kind: 'native',
    id: 'parameter-fixture', version: '1.0.0', name: '参数实验', description: '已有评测器的参数优化',
    artifacts: { verify: verifyJsonArtifact },
    async evaluate({ artifact, criteria }) {
      const x = parameter(artifact.payload).x;
      return { valid: x >= 0, score: criteria.reverse ? -x : x, summary: 'measured parameter', diagnostics: { x, category: 'parameter' } };
    },
    validateBaseline: result => assert.ok(result.valid),
    compare: (a, b) => numeric(a.score) < numeric(b.score) ? 'better' : numeric(a.score) === numeric(b.score) ? 'equal' : 'worse',
    projectEvidence: result => result.diagnostics,
    async run(ctx) {
      await ctx.initialize({ criteria: { ready: true, criterion: 'lower value' }, artifact: jsonArtifact({ x: 100 }) });
      await ctx.search({
        plan: ({ evidence: seen }) => { evidence.push(seen); return { stop: false, reason: '', assignments: options.lanes ? [assignment('a'), assignment('b')] : [assignment()] }; },
        produce: options.produce ?? (async ({ seed }) => jsonArtifact({ x: parameter(seed.payload).x - 10 })),
      });
      const state = ctx.state().workflowState;
      if (options.reverse && (!isRecord(state) || !state.reversed)) {
        await ctx.reviseCriteria({ ready: true, criterion: 'larger value', reverse: true });
        await ctx.saveState({ reversed: true });
      }
    },
    async deliver({ artifact, authorize }) { await authorize(); return { kind: 'parameter-package', value: artifact.payload, artifactId: artifact.id }; },
    ...options.workflow,
  };
  const tasks = new WorkflowRegistry(), unregister = tasks.register(workflow);
  const adapter: RuntimeAdapter = { directory: async () => cwd, authorize: async () => {}, error: error => { throw error; },
    async invoke(args) { calls.push(args.role); await args.onStarted('selector'); assert.equal(args.role, 'selector'); return { taskId: workflow.id, reason: 'parameter task' }; },
    execute: async () => { throw new Error('This workflow has no shell evaluator'); },
  };
  const config = { root: path.join(root, 'runs'), store, tasks, adapter, maxTrials: 4, localTrials: 1 };
  const engine = new ExplorationEngine(config);
  return { engine, config, workflow, store, calls, evidence, unregister, cwd, root };
}

test('JSON workflow uses the same SLA strategy with an existing evaluator and no file candidate', async () => {
  const f = await fixture(); await f.engine.action(parent, { action: 'start', text: 'improve parameters' }); await settle(f.engine);
  const run = getRun(f.engine, parent.id);
  assert.equal(run.status, 'completed', run.message); assert.equal(best(run).score, 60);
  assert.equal(run.epochs.length, 4); assert.equal(run.trials.length, 4);
  assert.equal(run.sourceFiles, undefined); assert.equal(run.evaluationDir, undefined);
  assert.ok(run.artifacts.every(a => a.kind === 'json')); assert.equal(run.artifacts.length, 5);
  assert.equal(run.observations.length, 5); assert.equal(run.decisions.length, 4);
  assert.equal(best(run).artifactId, present(run.trials.at(-1)).artifactId);
  assert.equal(artifactById(run, best(run).artifactId).parentId, present(run.trials.at(-2)).artifactId);
  assert.deepEqual(f.calls, ['selector']);
  assert.deepEqual(await readdir(f.cwd), []);
  assert.deepEqual((await readdir(run.root)).filter(n => n !== 'report.json').map(n => n.split('-')[0]), ['selection']);
  assert.equal(object(object(z.array(z.unknown()).parse(object(f.evidence[1][0]).evidence)[0]).detail).x, 90);
  await f.engine.action(parent, { action: 'adopt' });
  const delivered = getRun(f.engine, parent.id);
  assert.deepEqual(object(delivered.delivery).value, { x: 60 }); assert.equal(delivered.adopted, true);
});

test('same regime has separate lane ancestry and never sees a sibling candidate as its seed', async () => {
  const f = await fixture({ lanes: true }); await f.engine.action(parent, { action: 'start', text: 'two branches' }); await settle(f.engine);
  const run = getRun(f.engine, parent.id);
  assert.equal(run.status, 'completed', run.message);
  assert.deepEqual(run.directions.map(l => [l.id, l.regime]), [['a', 'tuning'], ['b', 'tuning']]);
  assert.deepEqual(run.trials.map(t => [t.direction, t.parentTrial]), [['a', 0], ['b', 0], ['a', 1], ['b', 2]]);
});

test('non-file workflow pauses, reopens and resumes its saved Epoch without replaying a completed attempt', async () => {
  let block = true, count = 0; const { promise: waiting, resolve: entered } = Promise.withResolvers<void>();
  const f = await fixture({ produce: async ({ seed, signal }) => {
    if (++count === 2 && block) { entered(); await new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    return jsonArtifact({ x: parameter(seed.payload).x - 10 });
  } });
  await f.engine.action(parent, { action: 'start', text: 'parameters' }); await waiting;
  await f.engine.action(parent, { action: 'pause' }); await settle(f.engine); await f.engine.dispose();
  const saved = getRun(f.engine, parent.id); assert.equal(saved.trials[1].status, 'inconclusive');
  block = false; const reopened = new ExplorationEngine(f.config); await reopened.recover();
  await reopened.action(parent, { action: 'resume' }); await settle(reopened);
  const run = getRun(reopened, parent.id); assert.equal(run.status, 'completed', run.message);
  assert.equal(run.attempts, 4); assert.equal(best(run).score, 70); assert.equal(count, 4);
  assert.equal(run.trials[1].status, 'inconclusive');
});

test('new criteria produce new observations without rewriting historical assessments or selecting stale scores', async () => {
  const f = await fixture({ reverse: true }); await f.engine.action(parent, { action: 'start', text: 'parameters' }); await settle(f.engine);
  const run = getRun(f.engine, parent.id); assert.equal(run.status, 'completed', run.message);
  assert.equal(run.criteriaVersion, 2); assert.equal(best(run).trial, 0); assert.equal(best(run).score, -100);
  assert.deepEqual(run.frontier.map(c => c.trial), [0]);
  assert.equal(present(run.trials[0].evaluation).score, 90);
  assert.equal(present(present(run.assessments.find(a => numeric(a.trial) === 1)).evaluation).score, -90);
  assert.equal(run.observations.filter(o => o.criteriaVersion === 1).length, 5);
  assert.equal(run.observations.filter(o => o.criteriaVersion === 2).length, 5);
  assert.throws(() => acceptSelection(run, run.trials[0], candidateFixture({ evaluation: present(run.trials[0].evaluation), criteriaVersion: 1 }), { local: true, global: true, eligibility: { retain: true, deliver: true } }), /版本已过期/);
  await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /尚无/);
});

test('reentering unchanged criteria does not spend another evaluation or advance its version', async () => {
  const criteria = { criterion: 'same evaluator', ready: true };
  const f = await fixture({ workflow: { async run(ctx) {
    await ctx.initialize({ criteria, artifact: jsonArtifact({ x: 100 }) });
    await ctx.reviseCriteria(criteria);
  } } });
  await f.engine.action(parent, { action: 'start', text: 'parameters' }); await settle(f.engine);
  const run = getRun(f.engine, parent.id);
  assert.equal(run.status, 'completed', run.message);
  assert.equal(run.criteriaVersion, 1); assert.equal(run.observations.length, 1);
});

test('read snapshots cannot mutate authoritative state and artifact tampering is rejected before delivery', async () => {
  const f = await fixture({ workflow: { async run(ctx) {
    await ctx.initialize({ criteria: { ready: true, criterion: 'lower' }, artifact: jsonArtifact({ x: 100 }) });
    const copy = ctx.state(); present(copy.best).score = -999; parameter(copy.artifacts[0].payload).x = -999;
    await ctx.search({ plan: () => ({ stop: false, reason: '', assignments: [assignment()] }), produce: async ({ seed }) => jsonArtifact({ x: parameter(seed.payload).x - 10 }) });
  } } });
  await f.engine.action(parent, { action: 'start', text: 'parameters' }); await settle(f.engine);
  const run = getRun(f.engine, parent.id); assert.equal(present(run.baseline).score, 100); assert.equal(best(run).score, 60);
  parameter(present(run.artifacts.find(a => a.id === best(run).artifactId)).payload).x = -99; await f.store.put(parent.id, run);
  await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /内容身份不一致/);
  assert.equal(getRun(f.engine, parent.id).adopted, false);
});

test('workflow registration binds version, unload cancels work, and old records stay viewable', async () => {
  const { promise: waiting, resolve: entered } = Promise.withResolvers<void>();
  const f = await fixture({ produce: async ({ signal }) => { entered(); return new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  await f.engine.action(parent, { action: 'start', text: 'parameters' }); await waiting; f.unregister(); await settle(f.engine);
  const reopened = new ExplorationEngine(f.config); await reopened.recover();
  assert.equal(getRun(reopened, parent.id).status, 'blocked');
  assert.throws(() => f.config.tasks.get(f.workflow), /未安装/);
  f.config.tasks.register({ ...f.workflow, version: '2.0.0' });
  await reopened.action(parent, { action: 'resume' }); await settle(reopened);
  assert.match(getRun(reopened, parent.id).message, /版本不一致/);
});

test('paused evaluation resumes the sealed JSON candidate before producing another attempt', async () => {
  let block = true, productions = 0;
  const { promise: waiting, resolve: entered } = Promise.withResolvers<void>();
  const f = await fixture({ produce: async ({ seed }) => { productions++; return jsonArtifact({ x: parameter(seed.payload).x - 10 }); }, workflow: {
    complete: result => numeric(result.score) <= 90,
    async evaluate({ artifact, signal }) {
      if (parameter(artifact.payload).x === 90 && block) {
        entered(); await new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return { valid: true, score: parameter(artifact.payload).x, summary: 'measured' };
    },
  } });
  await f.engine.action(parent, { action: 'start', text: 'parameters' }); await waiting;
  await f.engine.action(parent, { action: 'pause' }); await settle(f.engine); await f.engine.dispose();
  const paused = getRun(f.engine, parent.id); assert.equal(paused.trials[0].pendingEvaluation, true);
  const artifact = paused.trials[0].artifactId; block = false;
  const reopened = new ExplorationEngine(f.config); await reopened.recover();
  await reopened.action(parent, { action: 'resume' }); await settle(reopened);
  const run = getRun(reopened, parent.id);
  assert.equal(run.status, 'completed', run.message); assert.equal(best(run).artifactId, artifact);
  assert.equal(run.attempts, 1); assert.equal(productions, 1); assert.equal(run.trials[0].pendingEvaluation, false);
});

test('delivery failure reconciles absent and committed side effects, and holds unknown outcomes with their reason', async () => {
  for (const outcome of ['absent', 'delivered', 'unknown'] as const) {
    const f = await fixture({ workflow: {
      deliver: async () => { throw new Error('injected delivery failure'); },
      recoverDelivery: async () => outcome === 'delivered' ? { status: outcome, receipt: { exact: true } } : { status: outcome, reason: 'manual check required' },
    } });
    await f.engine.action(parent, { action: 'start', text: 'parameters' }); await settle(f.engine);
    if (outcome === 'delivered') await f.engine.action(parent, { action: 'adopt' });
    else await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /injected delivery failure/);
    const run = getRun(f.engine, parent.id);
    assert.equal(run.adoptionPending, outcome === 'unknown'); assert.equal(run.adopted, outcome === 'delivered');
    assert.equal(run.deliveryError, 'injected delivery failure');
    if (outcome === 'unknown') await assert.rejects(f.engine.action(parent, { action: 'resume' }), /manual check required/);
    if (outcome === 'absent') {
      await f.engine.action(parent, { action: 'resume' }); await settle(f.engine);
      assert.equal(getRun(f.engine, parent.id).status, 'completed');
    }
    const reopened = new ExplorationEngine(f.config); await reopened.recover();
    assert.equal(getRun(reopened, parent.id).adoptionPending, outcome === 'unknown');
  }
});

test('delivery failure is durable before reconciliation and survives reopening while recovery is interrupted', async () => {
  let recoveries = 0;
  const { promise: waiting, resolve: entered } = Promise.withResolvers<void>();
  const { promise: blocked, resolve: release } = Promise.withResolvers<void>();
  const f = await fixture({ workflow: {
    deliver: async () => { throw new Error('delivery failed before reconciliation'); },
    recoverDelivery: async () => {
      if (++recoveries === 1) { entered(); await blocked; }
      return { status: 'unknown', reason: 'delivery needs inspection' };
    },
  } });
  await f.engine.action(parent, { action: 'start', text: 'parameters' }); await settle(f.engine);
  const pending = assert.rejects(f.engine.action(parent, { action: 'adopt' }), /delivery failed before reconciliation/);
  await waiting;
  try {
    const saved = f.store.get(parent.id);
    const report = object(parseJson(await readFile(path.join(present(saved).root, 'report.json'), 'utf8')));
    const reopened = new ExplorationEngine(f.config); await reopened.recover();
    for (const record of [present(saved), report, getRun(reopened, parent.id)]) {
      assert.equal(record.adoptionPending, true);
      assert.equal(record.adopted, false);
      assert.equal(record.deliveryError, 'delivery failed before reconciliation');
    }
    await assert.rejects(reopened.action(parent, { action: 'adopt' }), /delivery needs inspection/);
    await reopened.dispose();
  } finally { present(release)(); await pending; await f.engine.dispose(); }
});

test('native criteria publication resumes pending observations and does not republish the same criteria on workflow reentry', async () => {
  let block = true; const { promise: waiting, resolve: entered } = Promise.withResolvers<void>();
  const f = await fixture({ reverse: true, workflow: { async evaluate({ artifact, criteria, signal }) {
    if (criteria.reverse && parameter(artifact.payload).x === 90 && block) {
      entered(); await new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return { valid: true, score: criteria.reverse ? -parameter(artifact.payload).x : parameter(artifact.payload).x, summary: 'measured' };
  } } });
  await f.engine.action(parent, { action: 'start', text: 'parameters' }); await waiting;
  await f.engine.action(parent, { action: 'pause' }); await settle(f.engine); await f.engine.dispose();
  const saved = getRun(f.engine, parent.id); assert.equal(saved.criteriaVersion, 1); assert.equal(present(saved.pendingReview).results.length, 1);
  block = false; const reopened = new ExplorationEngine(f.config); await reopened.recover();
  await reopened.action(parent, { action: 'resume' }); await settle(reopened);
  const run = getRun(reopened, parent.id); assert.equal(run.status, 'completed', run.message); assert.equal(run.criteriaVersion, 2);
  assert.equal(run.pendingReview, null); assert.equal(run.observations.filter(o => o.criteriaVersion === 2 && o.artifactId === run.baselineArtifactId).length, 1);
});

test('native evaluator cannot change its candidate input and claim an independently measured improvement', async () => {
  const f = await fixture({ workflow: { async evaluate({ artifact }) {
    const x = parameter(artifact.payload).x; if (x < 100) parameter(artifact.payload).x = 0;
    return { valid: true, score: parameter(artifact.payload).x, summary: 'claimed improvement' };
  } } });
  await f.engine.action(parent, { action: 'start', text: 'parameters' }); await settle(f.engine);
  const run = getRun(f.engine, parent.id); assert.equal(run.status, 'blocked'); assert.match(run.message, /修改了输入制品/);
  assert.equal(best(run).score, 100); assert.equal(run.observations.length, 1); assert.equal(run.trials[0].pendingEvaluation, true);
  assert.equal(parameter(artifactById(run, present(run.trials[0].artifactId)).payload).x, 90);
});
