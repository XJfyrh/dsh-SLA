import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parameterWorkflow } from '../dist/extensions/parameters.js';
import { evaluateRetrieval, validateDataset } from '../dist/extensions/retrieval-evaluator.js';
import { ExplorationEngine } from '../dist/src/engine.js';
import { WorkflowRegistry } from '../dist/src/workflow-registry.js';
import { changePreview } from '../dist/src/change-preview.js';
import { inventory } from '../dist/src/workspace.js';

test('bundled retrieval workflow evaluates JSON candidates, previews content and delivers an exact parameter package', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sla-parameters-')), cwd = path.join(root, 'project');
  await cp(new URL('../examples/retrieval-parameters/', import.meta.url), cwd, { recursive: true });
  const before = await inventory(cwd), records = new Map(), roles = [];
  const tasks = new WorkflowRegistry(); tasks.register(parameterWorkflow);
  const engine = new ExplorationEngine({ root: path.join(root, 'runs'), tasks,
    store: { entries: () => records.entries(), get: id => records.get(id), put: async (id, run) => records.set(id, structuredClone(run)) },
    adapter: { directory: async () => cwd, authorize: async () => {}, error: error => { throw error; },
      async invoke(args) {
        roles.push(args.role); await args.onStarted('child-' + roles.length);
        if (args.role === 'selector') return { taskId: parameterWorkflow.id, reason: 'existing retrieval data' };
        assert.deepEqual(args.blueprint.tools, []);
        if (args.role === 'parameter-advisor') return { stop: false, reason: '', assignments: [{ direction: 'title', lane: 'title-a', hypothesis: 'title terms matter', instructions: 'increase title weight', evidenceTrials: [] }] };
        assert.equal(args.role, 'parameter-proposer'); return { topK: 1, titleWeight: 4 };
      }, execute: async () => { throw new Error('does not invoke a shell evaluator'); } },
  });
  const parent = { id: 'retrieval' };
  await engine.action(parent, { action: 'start', text: '提高检索效果' });
  while (engine.active.size) await Promise.all([...engine.active.values()].map(x => x.promise));
  const run = engine.get(parent.id);
  assert.equal(run.status, 'completed', run.message); assert.equal(run.baseline.recall, 0); assert.equal(run.best.recall, 1);
  assert.deepEqual(roles, ['selector', 'parameter-advisor', 'parameter-proposer']);
  assert.equal(run.trials.length, 1); assert.equal(run.invocations[2].attemptId, run.trials[0].id);
  const preview = await changePreview(run);
  assert.equal(preview.kind, 'artifact'); assert.equal(preview.artifactId, run.best.artifactId);
  assert.deepEqual(JSON.parse(preview.files[0].oldText), { topK: 1, titleWeight: 0 });
  assert.deepEqual(JSON.parse(preview.files[0].newText), { topK: 1, titleWeight: 4 });
  const altered = structuredClone(run); altered.artifacts.find(a => a.id === run.best.artifactId).payload.titleWeight = 999;
  await assert.rejects(changePreview(altered), /内容身份不一致/);
  await engine.action(parent, { action: 'adopt' });
  const delivered = engine.get(parent.id), bytes = await readFile(delivered.delivery.path, 'utf8');
  assert.equal(delivered.adopted, true);
  assert.deepEqual(JSON.parse(bytes), { artifactId: run.best.artifactId, criteriaVersion: run.criteriaVersion, parameters: { topK: 1, titleWeight: 4 } });
  assert.deepEqual(await inventory(cwd), before); assert.equal((await readdir(run.root)).some(n => n.startsWith('candidate-') || n.startsWith('criteria-')), false);
  assert.equal((await parameterWorkflow.recoverDelivery(delivered)).status, 'delivered');
  await writeFile(delivered.delivery.path, 'different output');
  await assert.rejects(parameterWorkflow.recoverDelivery(delivered), /交付内容不一致/);
});

test('retrieval evaluator checks parameters and dataset identities rather than accepting unsupported examples', async () => {
  const dataset = validateDataset(JSON.parse(await readFile(new URL('../examples/retrieval-parameters/retrieval-eval.json', import.meta.url), 'utf8')));
  for (const parameters of [{ topK: 0, titleWeight: 0 }, { topK: 1.5, titleWeight: 2 }, { topK: 1, titleWeight: 99 }]) assert.equal(evaluateRetrieval(parameters, dataset).valid, false);
  assert.throws(() => validateDataset({ ...dataset, documents: [...dataset.documents, dataset.documents[0]] }), /id 重复/);
  assert.throws(() => validateDataset({ ...dataset, queries: [{ text: 'query', relevant: ['missing'] }] }), /relevant/);
});
