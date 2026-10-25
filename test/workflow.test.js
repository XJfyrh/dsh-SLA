import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExplorationEngine } from '../src/engine.js';
import { TaskRegistry } from '../src/task-registry.js';
import { jsonArtifact, verifyJsonArtifact } from '../src/json-artifacts.js';
import { artifactById, acceptSelection } from '../src/kernel.js';

const parent = { id: 'parameters' };
const settle = async engine => { while (engine.active.size) await Promise.all([...engine.active.values()].map(x => x.promise)); };
const assignment = (lane = 'default') => ({ direction: 'tuning', lane, hypothesis: 'reduce the parameter', instructions: 'try a smaller value', evidenceTrials: [] });

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sla-workflow-')), cwd = path.join(root, 'empty-workspace'); await mkdir(cwd);
  const records = new Map(), calls = [], evidence = [];
  const store = { get: id => records.get(id), entries: () => records.entries(), put: async (id, value) => records.set(id, structuredClone(value)) };
  const workflow = {
    id: 'parameter-fixture', version: '1.0.0', name: '参数实验', description: '已有评测器的参数优化',
    artifacts: { verify: verifyJsonArtifact },
    async evaluate({ artifact, criteria }) {
      const x = artifact.payload.x;
      return { valid: x >= 0, score: criteria.reverse ? -x : x, summary: 'measured parameter', diagnostics: { x, category: 'parameter' } };
    },
    validateBaseline: result => assert.ok(result.valid),
    compare: (a, b) => a.score < b.score ? 'better' : a.score === b.score ? 'equal' : 'worse',
    projectEvidence: result => result.diagnostics,
    async run(ctx) {
      await ctx.initialize({ criteria: { ready: true, criterion: 'lower value' }, artifact: jsonArtifact({ x: 100 }) });
      await ctx.search({
        plan: ({ evidence: seen }) => { evidence.push(seen); return { stop: false, reason: '', assignments: options.lanes ? [assignment('a'), assignment('b')] : [assignment()] }; },
        produce: options.produce ?? (async ({ seed }) => jsonArtifact({ x: seed.payload.x - 10 })),
      });
      if (options.reverse && !ctx.state().workflowState?.reversed) {
        await ctx.reviseCriteria({ ready: true, criterion: 'larger value', reverse: true });
        await ctx.saveState({ reversed: true });
      }
    },
    async deliver({ artifact, authorize }) { await authorize(); return { kind: 'parameter-package', value: artifact.payload, artifactId: artifact.id }; },
    ...options.workflow,
  };
  const tasks = new TaskRegistry(), unregister = tasks.registerWorkflow(workflow);
  const adapter = { directory: async () => cwd, authorize: async () => {}, error: error => { throw error; },
    async invoke(args) { calls.push(args.role); await args.onStarted('selector'); assert.equal(args.role, 'selector'); return { taskId: workflow.id, reason: 'parameter task' }; },
    execute: async () => { throw new Error('This workflow has no shell evaluator'); },
  };
  const config = { root: path.join(root, 'runs'), store, tasks, adapter, maxTrials: 4, localTrials: 1 };
  const engine = new ExplorationEngine(config);
  return { engine, config, workflow, store, calls, evidence, unregister, cwd, root };
}

test('JSON workflow uses the same SLA strategy with an existing evaluator and no file candidate', async () => {
  const f = await fixture(); await f.engine.action(parent, { action: 'start', text: 'improve parameters' }); await settle(f.engine);
  const run = f.engine.get(parent.id);
  assert.equal(run.status, 'completed', run.message); assert.equal(run.best.score, 60);
  assert.equal(run.epochs.length, 4); assert.equal(run.trials.length, 4);
  assert.equal(run.sourceFiles, undefined); assert.equal(run.evaluationDir, undefined);
  assert.ok(run.artifacts.every(a => a.kind === 'json')); assert.equal(run.artifacts.length, 5);
  assert.equal(run.observations.length, 5); assert.equal(run.decisions.length, 4);
  assert.equal(run.best.artifactId, run.trials.at(-1).artifactId);
  assert.equal(artifactById(run, run.best.artifactId).parentId, run.trials.at(-2).artifactId);
  assert.deepEqual(f.calls, ['selector']);
  assert.deepEqual(await readdir(f.cwd), []);
  assert.deepEqual((await readdir(run.root)).filter(n => n !== 'report.json').map(n => n.split('-')[0]), ['selection']);
  assert.equal(f.evidence[1][0].evidence[0].detail.x, 90);
  await f.engine.action(parent, { action: 'adopt' });
  const delivered = f.engine.get(parent.id);
  assert.deepEqual(delivered.delivery.value, { x: 60 }); assert.equal(delivered.adopted, true);
});

test('same regime has separate lane ancestry and never sees a sibling candidate as its seed', async () => {
  const f = await fixture({ lanes: true }); await f.engine.action(parent, { action: 'start', text: 'two branches' }); await settle(f.engine);
  const run = f.engine.get(parent.id);
  assert.equal(run.status, 'completed', run.message);
  assert.deepEqual(run.directions.map(l => [l.id, l.regime]), [['a', 'tuning'], ['b', 'tuning']]);
  assert.deepEqual(run.trials.map(t => [t.direction, t.parentTrial]), [['a', 0], ['b', 0], ['a', 1], ['b', 2]]);
});

test('non-file workflow pauses, reopens and resumes its saved Epoch without replaying a completed attempt', async () => {
  let entered, block = true, count = 0; const waiting = new Promise(resolve => { entered = resolve; });
  const f = await fixture({ produce: async ({ seed, signal }) => {
    if (++count === 2 && block) { entered(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    return jsonArtifact({ x: seed.payload.x - 10 });
  } });
  await f.engine.action(parent, { action: 'start', text: 'parameters' }); await waiting;
  await f.engine.action(parent, { action: 'pause' }); await settle(f.engine); await f.engine.dispose();
  const saved = f.engine.get(parent.id); assert.equal(saved.trials[1].status, 'inconclusive');
  block = false; const reopened = new ExplorationEngine(f.config); await reopened.recover();
  await reopened.action(parent, { action: 'resume' }); await settle(reopened);
  const run = reopened.get(parent.id); assert.equal(run.status, 'completed', run.message);
  assert.equal(run.attempts, 4); assert.equal(run.best.score, 70); assert.equal(count, 4);
  assert.equal(run.trials[1].status, 'inconclusive');
});

test('new criteria produce new observations without rewriting historical assessments or selecting stale scores', async () => {
  const f = await fixture({ reverse: true }); await f.engine.action(parent, { action: 'start', text: 'parameters' }); await settle(f.engine);
  const run = f.engine.get(parent.id); assert.equal(run.status, 'completed', run.message);
  assert.equal(run.criteriaVersion, 2); assert.equal(run.best.trial, 0); assert.equal(run.best.score, -100);
  assert.deepEqual(run.frontier.map(c => c.trial), [0]);
  assert.equal(run.trials[0].evaluation.score, 90);
  assert.equal(run.assessments.find(a => a.trial === 1).evaluation.score, -90);
  assert.equal(run.observations.filter(o => o.criteriaVersion === 1).length, 5);
  assert.equal(run.observations.filter(o => o.criteriaVersion === 2).length, 5);
  assert.throws(() => acceptSelection(run, run.trials[0], { ...run.trials[0].evaluation }, { local: true, global: true, eligibility: { retain: true, deliver: true } }), /版本已过期/);
  await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /尚无/);
});

test('read snapshots cannot mutate authoritative state and artifact tampering is rejected before delivery', async () => {
  const f = await fixture({ workflow: { async run(ctx) {
    await ctx.initialize({ criteria: { ready: true, criterion: 'lower' }, artifact: jsonArtifact({ x: 100 }) });
    const copy = ctx.state(); copy.best.score = -999; copy.artifacts[0].payload.x = -999;
    await ctx.search({ plan: () => ({ stop: false, reason: '', assignments: [assignment()] }), produce: async ({ seed }) => jsonArtifact({ x: seed.payload.x - 10 }) });
  } } });
  await f.engine.action(parent, { action: 'start', text: 'parameters' }); await settle(f.engine);
  const run = f.engine.get(parent.id); assert.equal(run.baseline.score, 100); assert.equal(run.best.score, 60);
  run.artifacts.find(a => a.id === run.best.artifactId).payload.x = -99; await f.store.put(parent.id, run);
  await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /内容身份不一致/);
  assert.equal(f.engine.get(parent.id).adopted, false);
});

test('workflow registration binds version, unload cancels work, and old records stay viewable', async () => {
  let entered; const waiting = new Promise(resolve => { entered = resolve; });
  const f = await fixture({ produce: async ({ signal }) => { entered(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  await f.engine.action(parent, { action: 'start', text: 'parameters' }); await waiting; f.unregister(); await settle(f.engine);
  const reopened = new ExplorationEngine(f.config); await reopened.recover();
  assert.equal(reopened.get(parent.id).status, 'blocked');
  assert.throws(() => f.config.tasks.get(f.workflow), /未安装/);
  f.config.tasks.registerWorkflow({ ...f.workflow, version: '2.0.0' });
  await reopened.action(parent, { action: 'resume' }); await settle(reopened);
  assert.match(reopened.get(parent.id).message, /版本不一致/);
});

test('paused evaluation resumes the sealed JSON candidate before producing another attempt', async () => {
  let entered, block = true, productions = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const f = await fixture({ produce: async ({ seed }) => { productions++; return jsonArtifact({ x: seed.payload.x - 10 }); }, workflow: {
    complete: result => result.score <= 90,
    async evaluate({ artifact, signal }) {
      if (artifact.payload.x === 90 && block) {
        entered(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return { valid: true, score: artifact.payload.x, summary: 'measured' };
    },
  } });
  await f.engine.action(parent, { action: 'start', text: 'parameters' }); await waiting;
  await f.engine.action(parent, { action: 'pause' }); await settle(f.engine); await f.engine.dispose();
  const paused = f.engine.get(parent.id); assert.equal(paused.trials[0].pendingEvaluation, true);
  const artifact = paused.trials[0].artifactId; block = false;
  const reopened = new ExplorationEngine(f.config); await reopened.recover();
  await reopened.action(parent, { action: 'resume' }); await settle(reopened);
  const run = reopened.get(parent.id);
  assert.equal(run.status, 'completed', run.message); assert.equal(run.best.artifactId, artifact);
  assert.equal(run.attempts, 1); assert.equal(productions, 1); assert.equal(run.trials[0].pendingEvaluation, false);
});

test('delivery failure reconciles absent and committed side effects, and holds unknown outcomes with their reason', async () => {
  for (const outcome of ['absent', 'delivered', 'unknown']) {
    const f = await fixture({ workflow: {
      deliver: async () => { throw new Error('injected delivery failure'); },
      recoverDelivery: async () => outcome === 'delivered' ? { status: outcome, receipt: { exact: true } } : { status: outcome, reason: 'manual check required' },
    } });
    await f.engine.action(parent, { action: 'start', text: 'parameters' }); await settle(f.engine);
    if (outcome === 'delivered') await f.engine.action(parent, { action: 'adopt' });
    else await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /injected delivery failure/);
    const run = f.engine.get(parent.id);
    assert.equal(run.adoptionPending, outcome === 'unknown'); assert.equal(run.adopted, outcome === 'delivered');
    assert.equal(run.deliveryError, 'injected delivery failure');
    if (outcome === 'unknown') await assert.rejects(f.engine.action(parent, { action: 'resume' }), /manual check required/);
    if (outcome === 'absent') {
      await f.engine.action(parent, { action: 'resume' }); await settle(f.engine);
      assert.equal(f.engine.get(parent.id).status, 'completed');
    }
    const reopened = new ExplorationEngine(f.config); await reopened.recover();
    assert.equal(reopened.get(parent.id).adoptionPending, outcome === 'unknown');
  }
});

test('native criteria publication resumes pending observations and does not republish the same criteria on workflow reentry', async () => {
  let entered, block = true; const waiting = new Promise(resolve => { entered = resolve; });
  const f = await fixture({ reverse: true, workflow: { async evaluate({ artifact, criteria, signal }) {
    if (criteria.reverse && artifact.payload.x === 90 && block) {
      entered(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    return { valid: true, score: criteria.reverse ? -artifact.payload.x : artifact.payload.x, summary: 'measured' };
  } } });
  await f.engine.action(parent, { action: 'start', text: 'parameters' }); await waiting;
  await f.engine.action(parent, { action: 'pause' }); await settle(f.engine); await f.engine.dispose();
  const saved = f.engine.get(parent.id); assert.equal(saved.criteriaVersion, 1); assert.equal(saved.pendingReview.results.length, 1);
  block = false; const reopened = new ExplorationEngine(f.config); await reopened.recover();
  await reopened.action(parent, { action: 'resume' }); await settle(reopened);
  const run = reopened.get(parent.id); assert.equal(run.status, 'completed', run.message); assert.equal(run.criteriaVersion, 2);
  assert.equal(run.pendingReview, null); assert.equal(run.observations.filter(o => o.criteriaVersion === 2 && o.artifactId === run.baselineArtifactId).length, 1);
});

test('native evaluator cannot change its candidate input and claim an independently measured improvement', async () => {
  const f = await fixture({ workflow: { async evaluate({ artifact }) {
    const x = artifact.payload.x; if (x < 100) artifact.payload.x = 0;
    return { valid: true, score: artifact.payload.x, summary: 'claimed improvement' };
  } } });
  await f.engine.action(parent, { action: 'start', text: 'parameters' }); await settle(f.engine);
  const run = f.engine.get(parent.id); assert.equal(run.status, 'blocked'); assert.match(run.message, /修改了输入制品/);
  assert.equal(run.best.score, 100); assert.equal(run.observations.length, 1); assert.equal(run.trials[0].pendingEvaluation, true);
  assert.equal(artifactById(run, run.trials[0].artifactId).payload.x, 90);
});
