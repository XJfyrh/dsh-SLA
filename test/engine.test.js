import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExplorationEngine, parseEvaluation } from '../src/engine.js';
import { inventory, snapshot, adopt } from '../src/workspace.js';
const exec = promisify(execFile);
const parent = { id: 'session-test' };
async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sla-test-'));
  const cwd = path.join(root, 'project'); await mkdir(cwd);
  await writeFile(path.join(cwd, 'candidate.json'), JSON.stringify({ score: 100, valid: true }));
  const records = new Map(), calls = [];
  let trial = 0;
  const store = { get: key => records.get(key), entries: () => records.entries(), put: async (key, value) => { records.set(key, structuredClone(value)); } };
  const adapter = {
    directory: async () => cwd, error: e => { throw e; },
    invoke: async args => {
      calls.push({ role: args.role, prompt: args.prompt, cwd: args.cwd });
      await args.onStarted('fresh-' + calls.length);
      if (options.invoke) { const result = await options.invoke(args); if (result) return result; }
      if (args.role === 'scout') {
        await mkdir(path.join(args.cwd, '.sla'));
        await writeFile(path.join(args.cwd, '.sla', 'evaluate.mjs'), `import fs from 'node:fs'; const v=JSON.parse(fs.readFileSync('candidate.json')); console.log('SLA_RESULT '+JSON.stringify({...v,summary:'fixture checks'}));`);
        return { title: 'fixture', criterion: 'lower score with valid checks', unit: 'operations', ready: true, reason: '' };
      }
      if (args.role === 'advisor') return { hypothesis: 'direction ' + (trial + 1), instructions: 'change', stop: false, reason: '' };
      const value = (options.results ?? [{ score: 90, valid: true }, { score: 1, valid: false }, { score: 110, valid: true }])[trial++ % 3];
      await writeFile(path.join(args.cwd, 'candidate.json'), JSON.stringify(value));
      return { summary: 'candidate changed', changes: ['candidate.json'] };
    },
    evaluate: async ({ cwd, signal }) => {
      const { stdout, stderr } = await exec(process.execPath, ['.sla/evaluate.mjs'], { cwd, signal, windowsHide: true });
      return { exitCode: 0, stdout: { text: stdout, truncated: false }, stderr: { text: stderr }, aborted: false, timedOut: false };
    },
  };
  const engine = new ExplorationEngine({ store, adapter, root: path.join(root, 'runs') });
  return { root, cwd, engine, store, calls, adapter };
}
async function settle(engine) { while (engine.active.size) await Promise.all([...engine.active.values()].map(x => x.promise)); }

test('fresh role calls use measured results, reject incorrect faster candidate and retain best', async () => {
  const f = await fixture();
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const run = f.engine.get(parent.id);
  assert.equal(run.status, 'completed'); assert.equal(run.best.score, 90);
  assert.deepEqual(run.trials.map(x => x.status), ['kept', 'invalid', 'no-improvement']);
  assert.equal(new Set(run.invocations.map(x => x.childId)).size, 7);
  assert.match(f.calls.filter(x => x.role === 'advisor')[2].prompt, /"valid":false/);
  assert.equal(JSON.parse(await readFile(path.join(f.cwd, 'candidate.json'))).score, 100);
  await f.engine.action(parent, { action: 'adopt' });
  assert.equal(JSON.parse(await readFile(path.join(f.cwd, 'candidate.json'))).score, 90);
  await f.engine.action(parent, { action: 'adopt' });
  assert.equal(f.engine.get(parent.id).adopted, true);
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
  assert.equal(JSON.parse(await readFile(path.join(f.cwd, 'candidate.json'))).score, 100);
});
test('frozen evaluation helper tampering blocks adoption', async () => {
  const f = await fixture(); await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const run = f.engine.get(parent.id);
  await writeFile(path.join(run.evaluationDir, '.sla', 'extra.mjs'), 'changed evaluation');
  await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /固定评价依据校验失败/);
});
test('adoption never overwrites an existing Git-ignored file', async () => {
  const f = await fixture();
  await exec('git', ['init', f.cwd]);
  await writeFile(path.join(f.cwd, '.gitignore'), 'local.json\n');
  await writeFile(path.join(f.cwd, 'local.json'), 'user data');
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  await writeFile(path.join(f.engine.get(parent.id).best.dir, 'local.json'), 'candidate data');
  await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /未纳入快照/);
  assert.equal(await readFile(path.join(f.cwd, 'local.json'), 'utf8'), 'user data');
});
test('recovery reconciles applied files and holds ambiguous partial adoption', async () => {
  const f = await fixture(); await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const saved = f.engine.get(parent.id);
  await f.engine.action(parent, { action: 'adopt' });
  await f.store.put(parent.id, saved); await f.engine.recover();
  assert.equal(f.engine.get(parent.id).adopted, true);
  await writeFile(path.join(f.cwd, 'candidate.json'), 'partial write');
  await f.engine.recover();
  assert.equal(f.engine.get(parent.id).adoptionPending, false, 'later user edits do not invalidate a completed adoption');
  await f.store.put(parent.id, saved); await f.engine.recover();
  assert.equal(f.engine.get(parent.id).adoptionPending, true);
  await assert.rejects(f.engine.action(parent, { action: 'resume' }), /采用曾被中断/);
  await writeFile(path.join(saved.root, 'adoption.json'), '{broken');
  await f.store.put(parent.id, saved); await f.engine.recover();
  assert.equal(f.engine.get(parent.id).adoptionPending, true);
  assert.match(f.engine.get(parent.id).message, /采用记录无法读取/);
});
test('crash recovery retains elapsed budget and interrupted invocation identity', async () => {
  const f = await fixture();
  await f.store.put(parent.id, { status: 'running', trials: [], invocations: [{ status: 'running', childId: 'old' }], elapsedMs: 100, timeLimitMs: 5000, activeSince: Date.now() - 2000 });
  await f.engine.recover(); const run = f.engine.get(parent.id);
  assert.ok(run.elapsedMs >= 2100 && run.elapsedMs <= 5000);
  assert.equal(run.activeSince, undefined);
  assert.equal(run.invocations[0].status, 'interrupted');
});
test('shutdown cancels and drains adoption before its storage can close', async () => {
  const f = await fixture(); await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  let entered; const waiting = new Promise(resolve => { entered = resolve; });
  f.adapter.evaluate = async ({ signal }) => {
    entered();
    await new Promise((_, reject) => signal.addEventListener('abort', () => setTimeout(() => reject(signal.reason), 20), { once: true }));
  };
  let settled = false;
  const action = f.engine.action(parent, { action: 'adopt' }).catch(error => { assert.match(error.message, /插件关闭/); }).finally(() => { settled = true; });
  await waiting; await f.engine.dispose(); await action;
  assert.equal(settled, true);
  assert.equal(JSON.parse(await readFile(path.join(f.cwd, 'candidate.json'))).score, 100);
});
test('steering creates a new evaluation revision and preserves previous experiment evidence', async () => {
  const f = await fixture(); await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  await f.engine.action(parent, { action: 'steer', text: 'memory first' }); await settle(f.engine);
  assert.equal(f.engine.get(parent.id).status, 'paused');
  assert.equal(f.engine.get(parent.id).limit, 3);
  await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /目标已调整/);
  await f.engine.action(parent, { action: 'resume' }); await settle(f.engine);
  const run = f.engine.get(parent.id);
  assert.equal(run.revision, 2); assert.equal(run.trials.length, 6);
  assert.match(f.calls.filter(x => x.role === 'scout')[1].prompt, /memory first/);
  assert.equal(run.baseline.score, 100); assert.equal(run.best.trial, 4);
});
test('pause drains active child and resume continues with confirmed evidence', async () => {
  let entered; const waiting = new Promise(resolve => { entered = resolve; }); let blocked = true;
  const f = await fixture({ invoke: async args => {
    if (args.role === 'worker' && blocked) {
      entered();
      await new Promise((_, reject) => args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true }));
    }
  } });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await waiting;
  await f.engine.action(parent, { action: 'pause' }); await settle(f.engine);
  assert.equal(f.engine.get(parent.id).status, 'paused');
  assert.equal(f.engine.get(parent.id).trials[0].status, 'inconclusive');
  blocked = false; await f.engine.action(parent, { action: 'resume' }); await settle(f.engine);
  assert.equal(f.engine.get(parent.id).status, 'completed');
  assert.equal(f.engine.get(parent.id).best.score, 90);
});
test('stop after steering cancels the pending automatic restart', async () => {
  let entered; const waiting = new Promise(resolve => { entered = resolve; });
  const f = await fixture({ invoke: async args => {
    if (args.role === 'worker') {
      entered();
      await new Promise((_, reject) => args.signal.addEventListener('abort', () => setTimeout(() => reject(args.signal.reason), 40), { once: true }));
    }
  } });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await waiting;
  await f.engine.action(parent, { action: 'steer', text: 'new constraint' });
  await f.engine.action(parent, { action: 'stop' }); await settle(f.engine);
  assert.equal(f.engine.get(parent.id).status, 'completed');
  assert.equal(f.calls.filter(x => x.role === 'scout').length, 1);
});
test('retrying failed discovery freezes a fresh evaluator without stale helper files', async () => {
  let discovery = 0;
  const f = await fixture({ invoke: async args => {
    if (args.role !== 'scout') return;
    discovery++;
    await mkdir(path.join(args.cwd, '.sla'));
    if (discovery === 1) await writeFile(path.join(args.cwd, '.sla', 'old-helper.txt'), 'old');
    await writeFile(path.join(args.cwd, '.sla', 'evaluate.mjs'), discovery === 1
      ? `console.log('SLA_RESULT '+JSON.stringify({valid:false,score:100,summary:'baseline failure'}));`
      : `import fs from 'node:fs'; console.log('SLA_RESULT '+JSON.stringify({...JSON.parse(fs.readFileSync('candidate.json')),summary:'new evaluator'}));`);
    return { title: 'fixture', criterion: 'measured score', unit: 'score', ready: true, reason: '' };
  } });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const first = f.engine.get(parent.id); assert.equal(first.status, 'blocked');
  await f.engine.action(parent, { action: 'resume' }); await settle(f.engine);
  const second = f.engine.get(parent.id);
  assert.equal(second.status, 'completed'); assert.notEqual(second.evaluationDir, first.evaluationDir);
  assert.deepEqual(Object.keys(second.evaluationFiles), ['evaluate.mjs']);
});
test('recovery marks unfinished work inconclusive without replaying it', async () => {
  const f = await fixture();
  await f.store.put(parent.id, { status: 'running', trials: [{ status: 'running' }] });
  await f.engine.recover();
  assert.equal(f.store.get(parent.id).status, 'paused');
  assert.equal(f.store.get(parent.id).trials[0].status, 'inconclusive');
  assert.equal(f.calls.length, 0);
});
test('invalid and incomplete evaluation outputs never become valid scores', () => {
  const result = text => ({ exitCode: 0, stdout: { text, truncated: false }, stderr: { text: '' } });
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
