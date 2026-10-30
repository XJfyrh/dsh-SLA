import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { z } from 'zod';
import { bugfixWorkflow } from '../dist/extensions/bugfix.js';
import { parseEvaluation, performanceWorkflow } from '../dist/extensions/performance.js';
import type { CodeDefinition } from '../dist/src/contracts.js';
import type { JsonValue, Run } from '../dist/src/data.js';
import { evaluationSchema } from '../dist/src/data.js';
import { ExplorationEngine } from '../dist/src/engine.js';
import { filePayload } from '../dist/src/file-artifacts.js';
import type { InvokeRequest, RunStore, RuntimeAdapter } from '../dist/src/runtime-contracts.js';
import { WorkflowRegistry } from '../dist/src/workflow-registry.js';
import { inventory, snapshot } from '../dist/src/workspace.js';
import { parseJson } from '../scripts/json.ts';
import { getRun, parentAgent, settle, shellResult } from './runtime-fixtures.ts';
import { best, numeric, object, present } from './state-fixtures.ts';
const exec = promisify(execFile);
const parent = parentAgent('session-test');
interface FixtureOptions {
  initial?: { valid: boolean } & Record<string, JsonValue>;
  results?: FixtureOptions['initial'][];
  task?: CodeDefinition; invoke?(request: InvokeRequest): Promise<unknown>;
}
async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sla-test-'));
  const cwd = path.join(root, 'project'); await mkdir(cwd);
  await writeFile(path.join(cwd, 'candidate.json'), JSON.stringify(options.initial ?? { score: 100, valid: true }));
  const records = new Map<string, Run>(), calls: Pick<InvokeRequest, 'role' | 'prompt' | 'cwd'>[] = [];
  let trial = 0;
  const store = { get: key => records.get(key), entries: () => records.entries(), put: async (key, value) => { records.set(key, structuredClone(value)); } } satisfies RunStore;
  const adapter: RuntimeAdapter = {
    authorize: async () => {},
    directory: async () => cwd, error: e => { throw e; },
    invoke: async args => {
      calls.push({ role: args.role, prompt: args.prompt, cwd: args.cwd });
      await args.onStarted('fresh-' + calls.length);
      if (options.invoke) { const result = await options.invoke(args); if (result) return result; }
      if (args.role === 'selector') return { taskId: options.task?.id ?? performanceWorkflow.id, reason: 'fixture selection' };
      if (args.role === 'scout') {
        await mkdir(path.join(args.cwd, '.sla'), { recursive: true });
        await writeFile(path.join(args.cwd, '.sla', 'evaluate.mjs'), `import fs from 'node:fs'; const v=JSON.parse(fs.readFileSync('candidate.json')); console.log('SLA_RESULT '+JSON.stringify({...v,summary:'fixture checks'}));`);
        return { title: 'fixture', criterion: 'lower score with valid checks', unit: 'operations', ready: true, reason: '' };
      }
      if (args.role === 'advisor') return { assignments: [{ direction: 'test-direction', hypothesis: 'direction ' + (trial + 1), instructions: 'change', evidenceTrials: [] }], stop: false, reason: '' };
      const results = options.results ?? [{ score: 90, valid: true }, { score: 1, valid: false }, { score: 110, valid: true }];
      const value = results[trial++ % results.length];
      await writeFile(path.join(args.cwd, 'candidate.json'), JSON.stringify(value));
      return { summary: 'candidate changed' };
    },
    execute: async ({ cwd, signal }) => {
      const { stdout, stderr } = await exec(process.execPath, ['.sla/evaluate.mjs'], { cwd, signal, windowsHide: true });
      return shellResult(stdout, stderr);
    },
  };
  const tasks = new WorkflowRegistry();
  // These existing lifecycle tests exercise a task without the optional review
  // capability. Epoch/review acceptance has its own fixtures and failure cases.
  const { review: _review, ...task } = options.task ?? performanceWorkflow;
  const unregister = tasks.register(task);
  const engine = new ExplorationEngine({ store, adapter, tasks, root: path.join(root, 'runs'), maxTrials: 3, directions: 1, localTrials: 1 });
  return { root, cwd, engine, store, calls, adapter, tasks, unregister };
}

test('fresh role calls use measured results, reject incorrect faster candidate and retain best', async () => {
  const f = await fixture();
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const run = getRun(f.engine, parent.id);
  assert.equal(run.status, 'completed'); assert.equal(best(run).score, 90);
  assert.deepEqual(run.trials.map(x => x.status), ['kept', 'invalid', 'no-improvement']);
  assert.equal(new Set(run.invocations.map(x => x.childId)).size, 8);
  assert.match(f.calls.filter(x => x.role === 'advisor')[2].prompt, /"valid":false/);
  assert.equal(object(parseJson(await readFile(path.join(f.cwd, 'candidate.json'), 'utf8'))).score, 100);
  await f.engine.action(parent, { action: 'adopt' });
  assert.equal(object(parseJson(await readFile(path.join(f.cwd, 'candidate.json'), 'utf8'))).score, 90);
  await f.engine.action(parent, { action: 'adopt' });
  assert.equal(getRun(f.engine, parent.id).adopted, true);
});
test('source changes block adoption and are preserved', async () => {
  const f = await fixture(); await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  await writeFile(path.join(f.cwd, 'candidate.json'), 'user change');
  await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /原项目已修改/);
  assert.equal(await readFile(path.join(f.cwd, 'candidate.json'), 'utf8'), 'user change');
});
test('changes to other source files also block adoption', async () => {
  const f = await fixture(); await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  await writeFile(path.join(f.cwd, 'new-user-file.txt'), 'keep this');
  await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /原项目已修改/);
  assert.equal(object(parseJson(await readFile(path.join(f.cwd, 'candidate.json'), 'utf8'))).score, 100);
});
test('frozen evaluation helper tampering blocks adoption', async () => {
  const f = await fixture(); await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const run = getRun(f.engine, parent.id);
  await writeFile(path.join(present(run.evaluationDir), '.sla', 'extra.mjs'), 'changed evaluation');
  await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /固定评价依据校验失败/);
});
test('adoption never overwrites an existing Git-ignored file', async () => {
  const f = await fixture({ invoke: async args => {
    if (args.role === 'worker') await writeFile(path.join(args.cwd, 'local.json'), 'candidate data');
  } });
  await exec('git', ['init', f.cwd]);
  await writeFile(path.join(f.cwd, '.gitignore'), 'local.json\n');
  await writeFile(path.join(f.cwd, 'local.json'), 'user data');
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const run = getRun(f.engine, parent.id);
  assert.ok(filePayload(present(run.artifacts.find(artifact => artifact.id === best(run).artifactId))).files['local.json']);
  await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /未纳入快照的文件 local.json/);
  assert.equal(await readFile(path.join(f.cwd, 'local.json'), 'utf8'), 'user data');
  assert.equal(getRun(f.engine, parent.id).adopted, false);
});
test('post-seal file additions are rejected before adoption', async () => {
  const f = await fixture();
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  await writeFile(path.join(present(best(getRun(f.engine, parent.id)).dir), 'unsealed.txt'), 'unsealed data');
  await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /已封存候选内容已改变/);
  assert.equal(object(parseJson(await readFile(path.join(f.cwd, 'candidate.json'), 'utf8'))).score, 100);
  await assert.rejects(readFile(path.join(f.cwd, 'unsealed.txt')), { code: 'ENOENT' });
});
test('recovery reconciles applied files and holds ambiguous partial adoption', async () => {
  const f = await fixture(); await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const saved = getRun(f.engine, parent.id);
  await f.engine.action(parent, { action: 'adopt' });
  await f.store.put(parent.id, saved); await f.engine.recover();
  assert.equal(getRun(f.engine, parent.id).adopted, true);
  await writeFile(path.join(f.cwd, 'candidate.json'), 'partial write');
  await f.engine.recover();
  assert.equal(getRun(f.engine, parent.id).adoptionPending, false, 'later user edits do not invalidate a completed adoption');
  await f.store.put(parent.id, saved); await f.engine.recover();
  assert.equal(getRun(f.engine, parent.id).adoptionPending, true);
  await assert.rejects(f.engine.action(parent, { action: 'resume' }), /采用曾被中断/);
  await writeFile(path.join(saved.root, 'adoption.json'), '{broken');
  await f.store.put(parent.id, saved); await f.engine.recover();
  assert.equal(getRun(f.engine, parent.id).adoptionPending, true);
  assert.match(getRun(f.engine, parent.id).message, /采用记录无法读取/);
});
test('crash recovery retains elapsed budget and interrupted invocation identity', async () => {
  const f = await fixture();
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const saved = getRun(f.engine, parent.id);
  await f.store.put(parent.id, { ...saved, status: 'running', trials: [], invocations: [{ ...saved.invocations[0], status: 'running', childId: 'old' }], elapsedMs: 100, timeLimitMs: 5000, activeSince: Date.now() - 2000 });
  await f.engine.recover(); const run = getRun(f.engine, parent.id);
  assert.ok(run.elapsedMs >= 2100 && run.elapsedMs <= 5000);
  assert.equal(run.activeSince, undefined);
  assert.equal(run.invocations[0].status, 'interrupted');
});
test('shutdown cancels and drains adoption before its storage can close', async () => {
  const f = await fixture(); await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const { promise: waiting, resolve: entered } = Promise.withResolvers<void>();
  f.adapter.execute = async ({ signal }) => {
    entered();
    return new Promise<never>((_, reject) => signal.addEventListener('abort', () => setTimeout(() => reject(signal.reason), 20), { once: true }));
  };
  let settled = false;
  const action = f.engine.action(parent, { action: 'adopt' }).catch(error => { assert.match(error.message, /插件关闭/); }).finally(() => { settled = true; });
  await waiting; await f.engine.dispose(); await action;
  assert.equal(settled, true);
  assert.equal(object(parseJson(await readFile(path.join(f.cwd, 'candidate.json'), 'utf8'))).score, 100);
});
test('steering creates a new evaluation revision and preserves previous experiment evidence', async () => {
  const f = await fixture(); await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  await f.engine.action(parent, { action: 'steer', text: 'memory first' }); await settle(f.engine);
  assert.equal(getRun(f.engine, parent.id).status, 'paused');
  assert.equal(getRun(f.engine, parent.id).limit, 3);
  await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /目标已调整/);
  await f.engine.action(parent, { action: 'resume' }); await settle(f.engine);
  const run = getRun(f.engine, parent.id);
  assert.equal(run.revision, 2); assert.equal(run.trials.length, 6);
  assert.match(f.calls.filter(x => x.role === 'scout')[1].prompt, /memory first/);
  assert.equal(present(run.baseline).score, 100); assert.equal(best(run).trial, 4);
});
test('pause drains active child and resume continues with confirmed evidence', async () => {
  const { promise: waiting, resolve: entered } = Promise.withResolvers<void>(); let blocked = true;
  const f = await fixture({ invoke: async args => {
    if (args.role === 'worker' && blocked) {
      entered();
      await new Promise((_, reject) => args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true }));
    }
  } });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await waiting;
  await f.engine.action(parent, { action: 'pause' }); await settle(f.engine);
  assert.equal(getRun(f.engine, parent.id).status, 'paused');
  assert.equal(getRun(f.engine, parent.id).trials[0].status, 'inconclusive');
  blocked = false; await f.engine.action(parent, { action: 'resume' }); await settle(f.engine);
  assert.equal(getRun(f.engine, parent.id).status, 'completed');
  assert.equal(best(getRun(f.engine, parent.id)).score, 90);
});
test('stop after steering cancels the pending automatic restart', async () => {
  const { promise: waiting, resolve: entered } = Promise.withResolvers<void>();
  const f = await fixture({ invoke: async args => {
    if (args.role === 'worker') {
      entered();
      await new Promise((_, reject) => args.signal.addEventListener('abort', () => setTimeout(() => reject(args.signal.reason), 40), { once: true }));
    }
  } });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await waiting;
  await f.engine.action(parent, { action: 'steer', text: 'new constraint' });
  await f.engine.action(parent, { action: 'stop' }); await settle(f.engine);
  assert.equal(getRun(f.engine, parent.id).status, 'completed');
  assert.equal(f.calls.filter(x => x.role === 'scout').length, 1);
});
test('retrying failed discovery freezes a fresh evaluator without stale helper files', async () => {
  let discovery = 0;
  const f = await fixture({ invoke: async args => {
    if (args.role !== 'scout') return;
    discovery++;
    await mkdir(path.join(args.cwd, '.sla'), { recursive: true });
    if (discovery === 1) await writeFile(path.join(args.cwd, '.sla', 'old-helper.txt'), 'old');
    await writeFile(path.join(args.cwd, '.sla', 'evaluate.mjs'), discovery === 1
      ? `console.log('SLA_RESULT '+JSON.stringify({valid:false,score:100,summary:'baseline failure'}));`
      : `import fs from 'node:fs'; console.log('SLA_RESULT '+JSON.stringify({...JSON.parse(fs.readFileSync('candidate.json')),summary:'new evaluator'}));`);
    return { title: 'fixture', criterion: 'measured score', unit: 'score', ready: true, reason: '' };
  } });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const first = getRun(f.engine, parent.id); assert.equal(first.status, 'blocked');
  await f.engine.action(parent, { action: 'resume' }); await settle(f.engine);
  const second = getRun(f.engine, parent.id);
  assert.equal(second.status, 'completed'); assert.notEqual(second.evaluationDir, first.evaluationDir);
  assert.deepEqual(Object.keys(present(second.evaluationFiles)), ['evaluate.mjs']);
});
test('recovery marks unfinished work inconclusive without replaying it', async () => {
  const f = await fixture();
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const saved = getRun(f.engine, parent.id);
  await f.store.put(parent.id, { ...saved, status: 'running', trials: [{ ...saved.trials[0], status: 'running' }] });
  const callsBeforeRecovery = f.calls.length;
  await f.engine.recover();
  assert.equal(present(f.store.get(parent.id)).status, 'paused');
  assert.equal(present(f.store.get(parent.id)).trials[0].status, 'inconclusive');
  assert.equal(f.calls.length, callsBeforeRecovery);
});
test('invalid and incomplete evaluation outputs never become valid scores', () => {
  const result = (text: string) => shellResult(text);
  assert.throws(() => parseEvaluation(result('done')), /SLA_RESULT/);
  assert.throws(() => parseEvaluation(result('SLA_RESULT {"valid":true,"score":null,"summary":"x"}')), /格式/);
  assert.throws(() => parseEvaluation({ ...result(''), timedOut: true }), /没有完成/);
});
test('snapshot excludes secrets and build artifacts, includes current uncommitted files', async () => {
  const f = await fixture();
  await writeFile(path.join(f.cwd, '.env'), 'SECRET');
  await mkdir(path.join(f.cwd, 'node_modules')); await writeFile(path.join(f.cwd, 'node_modules', 'x'), 'dependency');
  const files = await snapshot(f.cwd, path.join(f.root, 'copy'));
  assert.deepEqual(Object.keys(files), ['candidate.json']);
  assert.deepEqual(await inventory(path.join(f.root, 'copy')), files);
});

test('independent bugfix extension accepts failing baseline, rejects regressions and adopts without a score', async () => {
  const f = await fixture({ task: bugfixWorkflow,
    initial: { valid: false, reproduced: true, regressionPassed: true },
    results: [{ valid: false, reproduced: false, regressionPassed: false }, { valid: true, reproduced: false, regressionPassed: true }],
  });
  await f.engine.action(parent, { action: 'start', text: 'fix defect' }); await settle(f.engine);
  const run = getRun(f.engine, parent.id);
  assert.equal(run.status, 'completed'); assert.equal(present(run.task).id, bugfixWorkflow.id);
  assert.equal(present(run.baseline).valid, false); assert.equal(best(run).score, undefined);
  assert.equal(best(run).display, '修复通过'); assert.equal(run.attempts, 2);
  z.array(z.record(z.string(), z.json())).parse(run.trials);
  assert.deepEqual(run.trials.map(x => x.status), ['invalid', 'kept']);
  await f.engine.recover();
  await f.engine.action(parent, { action: 'adopt' });
  assert.deepEqual(parseJson(await readFile(path.join(f.cwd, 'candidate.json'), 'utf8')), { valid: true, reproduced: false, regressionPassed: true });
});

test('unloading an extension cancels its active work and same version can resume', async () => {
  const { promise: waiting, resolve: entered } = Promise.withResolvers<void>(); let block = true;
  const f = await fixture({ invoke: async args => {
    if (args.role === 'worker' && block) {
      entered(); await new Promise((_, reject) => args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true }));
    }
  } });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await waiting;
  f.unregister(); await settle(f.engine);
  assert.equal(getRun(f.engine, parent.id).status, 'blocked');
  assert.match(getRun(f.engine, parent.id).message, /扩展已卸载/);
  f.tasks.register({ ...performanceWorkflow, version: '2.0.0' });
  await f.engine.action(parent, { action: 'resume' }); await settle(f.engine);
  assert.match(getRun(f.engine, parent.id).message, /版本不一致/);
  const { review: _review, ...task } = performanceWorkflow;
  const fresh = new WorkflowRegistry(); fresh.register(task); f.engine.tasks = fresh; block = false;
  await f.engine.action(parent, { action: 'resume' }); await settle(f.engine);
  assert.equal(getRun(f.engine, parent.id).status, 'completed');
  assert.equal(f.calls.filter(x => x.role === 'selector').length, 1);
});

test('missing extension prevents adoption even when prior candidate is valid', async () => {
  const f = await fixture(); await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  f.unregister(); await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /未安装/);
  assert.equal(object(parseJson(await readFile(path.join(f.cwd, 'candidate.json'), 'utf8'))).score, 100);
});

test('core accepts a separate extension with its own command and no evaluate.mjs or numeric metric', async () => {
  const task: CodeDefinition = { ...bugfixWorkflow, id: 'custom-check', name: 'Custom',
    async evaluate({ execute }) { const raw = await execute('external-check'); return evaluationSchema.parse(parseJson(raw.stdout.text)); },
  };
  const f = await fixture({ task, initial: { valid: false, reproduced: true, regressionPassed: true }, results: [{ valid: true, reproduced: false, regressionPassed: true }],
    invoke: async args => {
      if (args.role === 'scout') return { ready: true, criterion: 'reuse existing checks without generated files' };
    },
  });
  f.adapter.execute = async ({ command, cwd }) => {
    assert.equal(command, 'external-check');
    return shellResult(JSON.stringify({ ...object(parseJson(await readFile(path.join(cwd, 'candidate.json'), 'utf8'))), summary: 'external checks', display: 'checked' }));
  };
  await f.engine.action(parent, { action: 'start', text: 'fix' }); await settle(f.engine);
  assert.equal(best(getRun(f.engine, parent.id)).trial, 1);
  await f.engine.action(parent, { action: 'adopt' }); assert.equal(getRun(f.engine, parent.id).adopted, true);
});

test('runtime cache files are allowed but changing a frozen evaluator still blocks adoption', async () => {
  const f = await fixture();
  const execute = f.adapter.execute;
  f.adapter.execute = async args => {
    await mkdir(path.join(args.cwd, '.dsh', 'cache'), { recursive: true });
    await writeFile(path.join(args.cwd, '.dsh', 'cache', 'helper.pyc'), 'runtime cache');
    return execute(args);
  };
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  assert.equal(best(getRun(f.engine, parent.id)).score, 90);
  f.adapter.execute = async args => {
    const output = await execute(args);
    await writeFile(path.join(args.cwd, '.sla', 'evaluate.mjs'), 'changed');
    return output;
  };
  await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /固定评价依据内容被修改/);
  assert.equal(object(parseJson(await readFile(path.join(f.cwd, 'candidate.json'), 'utf8'))).score, 100);
});

test('evaluation execution cannot add code to the frozen check directory', async () => {
  const f = await fixture();
  const execute = f.adapter.execute;
  f.adapter.execute = async args => {
    const output = await execute(args);
    await writeFile(path.join(args.cwd, '.sla', 'runtime-helper.mjs'), 'export const changed = true;');
    return output;
  };
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const run = getRun(f.engine, parent.id);
  assert.equal(run.status, 'blocked');
  assert.match(run.message, /固定评价依据新增/);
  assert.equal(run.baseline, undefined);
  assert.equal(object(parseJson(await readFile(path.join(f.cwd, 'candidate.json'), 'utf8'))).score, 100);
});

test('extension metadata cannot overwrite core trial identity or remove advisor feedback', async () => {
  const f = await fixture({ results: [{ valid: true, score: 90, revision: 99, number: 700, dir: 'wrong', status: 'invented', hypothesis: 'wrong' }] });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const trial = getRun(f.engine, parent.id).trials[0];
  assert.equal(trial.number, 1); assert.equal(trial.revision, 1); assert.equal(trial.status, 'kept');
  assert.equal(trial.hypothesis, 'direction 1'); assert.match(present(trial.dir), /candidate-1$/);
  assert.equal(present(trial.evaluation).revision, 99);
  assert.match(f.calls.filter(x => x.role === 'advisor')[1].prompt, /fixture checks/);
});

test('native evaluator cannot bypass read-only adoption checks by omitting execute', async () => {
  const task: CodeDefinition = { ...performanceWorkflow, async evaluate({ cwd }) { return evaluationSchema.parse({ ...object(parseJson(await readFile(path.join(cwd, 'candidate.json'), 'utf8'))), summary: 'native checks' }); } };
  const f = await fixture({ task });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  f.adapter.authorize = async () => { throw new Error('只读模式'); };
  await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /只读模式/);
  assert.equal(object(parseJson(await readFile(path.join(f.cwd, 'candidate.json'), 'utf8'))).score, 100);
  assert.equal(getRun(f.engine, parent.id).adopted, false);
  let checks = 0;
  f.adapter.authorize = async () => { if (++checks === 3) throw new Error('写回前切换为只读'); };
  await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /写回前切换为只读/);
  assert.equal(object(parseJson(await readFile(path.join(f.cwd, 'candidate.json'), 'utf8'))).score, 100);
});

test('comparison and completion receive pure evaluation data even when fields overlap best metadata', async () => {
  const seen: unknown[] = [];
  const task: CodeDefinition = { ...performanceWorkflow,
    async evaluate({ cwd }) { return evaluationSchema.parse({ ...object(parseJson(await readFile(path.join(cwd, 'candidate.json'), 'utf8'))), summary: 'custom trial metric' }); },
    compare(candidate, reference) { seen.push([numeric(candidate.trial), numeric(reference.trial)]); return numeric(candidate.trial) < numeric(reference.trial) ? 'better' : 'equal'; },
    complete(result) { return numeric(result.trial) === 9; },
  };
  const f = await fixture({ task, initial: { valid: true, trial: 10 }, results: [{ valid: true, trial: 9 }] });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const run = getRun(f.engine, parent.id);
  assert.equal(best(run).trial, 1); assert.equal(best(run).evaluation.trial, 9); assert.equal(run.attempts, 1);
  assert.deepEqual(seen, [[9, 10]]);
  await f.engine.action(parent, { action: 'adopt' }); assert.equal(getRun(f.engine, parent.id).adopted, true);
});
