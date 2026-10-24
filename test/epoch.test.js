import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExplorationEngine } from '../src/engine.js';
import { TaskRegistry } from '../src/task-registry.js';
import { advisorEvidence, settings } from '../src/research-state.js';
import { preservedBehaviorReview } from '../extensions/code-review.js';
const exec = promisify(execFile), parent = { id: 'epoch-test' };
const read = async cwd => JSON.parse(await readFile(path.join(cwd, 'value.json'), 'utf8'));
const write = (cwd, value) => writeFile(path.join(cwd, 'value.json'), JSON.stringify(value));
const assignment = direction => ({ direction, hypothesis: direction + ' method', instructions: 'one change', evidenceTrials: [] });
const settle = async engine => { while (engine.active.size) await Promise.all([...engine.active.values()].map(x => x.promise)); };
async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sla-epoch-')), cwd = path.join(root, 'source'); await mkdir(cwd);
  await write(cwd, options.initial ?? { score: 100, behavior: 'correct' });
  const records = new Map(), calls = [];
  const store = { get: id => records.get(id), entries: () => records.entries(), put: async (id, value) => records.set(id, structuredClone(value)) };
  const task = { id: 'epoch-fixture', version: '1.0.0', name: 'epoch test', description: 'stateful experiment', prepare: { schema: {}, prompt: () => 'prepare' },
    async evaluate({ cwd }) { const v = await read(cwd); return { valid: true, score: v.score, summary: 'measured ' + v.score }; },
    validateBaseline: () => {}, compare: (a, b) => a.score < b.score ? 'better' : a.score === b.score ? 'equal' : 'worse', ...options.task,
    ...(options.review ? { review: preservedBehaviorReview('测试保留行为') } : {}) };
  const tasks = new TaskRegistry(); tasks.register(task);
  let workers = 0, plans = 0;
  const adapter = { authorize: async () => {}, directory: async () => cwd, error: e => { throw e; },
    async invoke(args) {
      calls.push({ role: args.role, cwd: args.cwd, prompt: args.prompt }); await args.onStarted('child-' + calls.length);
      const custom = await options.invoke?.(args); if (custom) return custom;
      if (args.role === 'selector') return { taskId: task.id, reason: 'matches goal' };
      if (args.role === 'scout') return { ready: true, criterion: 'lower score, unchanged behavior' };
      if (args.role === 'advisor') { plans++; return { stop: false, reason: '', assignments: (options.plans?.[plans - 1] ?? ['fast', 'alternative']).map(assignment) }; }
      if (args.role === 'reviewer') return { hasChecks: false, summary: 'no additional concrete check' };
      const value = options.results?.[workers++] ?? { score: 50, behavior: 'correct' };
      await write(args.cwd, value); return { summary: 'changed candidate' };
    },
    async execute({ cwd, command, signal }) {
      const { stdout, stderr } = await exec(process.execPath, [command.slice('node '.length)], { cwd, signal, windowsHide: true });
      return { exitCode: 0, stdout: { text: stdout }, stderr: { text: stderr } };
    },
  };
  const config = { store, adapter, tasks, root: path.join(root, 'runs'), maxTrials: options.maxTrials ?? 8, localTrials: options.localTrials ?? 2 };
  const engine = new ExplorationEngine(config);
  return { engine, config, store, calls, cwd, task, adapter, root };
}
async function addCheck(args, body = `const passed=v.behavior==='correct';`) {
  const directory = args.prompt.match(/只能在 \.sla\/(reviews\/[^/]+)\//)[1];
  await writeFile(path.join(args.cwd, '.sla', directory, 'check.mjs'), `import fs from 'node:fs'; const v=JSON.parse(fs.readFileSync('value.json')); ${body} console.log('SLA_RESULT '+JSON.stringify({passed,summary:passed?'preserved behavior':'behavior regression'}));`);
  return { hasChecks: true, summary: 'behavior is outside the requested score improvement' };
}

test('local 130 -> 95 -> 60 matures across epochs and beats global 80', async () => {
  const f = await fixture({ results: [80, 80, 130, 95, 80, 80, 60, 60].map(score => ({ score, behavior: 'correct' })) });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const r = f.engine.get(parent.id);
  assert.equal(r.status, 'completed'); assert.equal(r.best.score, 60);
  assert.equal(r.epochs.length, 2); assert.equal(f.calls.filter(c => c.role === 'advisor').length, 2);
  assert.deepEqual(r.trials.filter(t => t.direction === 'alternative').map(t => [t.parentTrial, t.score, t.status]), [[0, 130, 'local-kept'], [3, 95, 'local-kept'], [4, 60, 'kept'], [7, 60, 'no-improvement']]);
  assert.match(f.calls.filter(c => c.role === 'worker')[3].prompt, /measured 130/);
  assert.match(f.calls.filter(c => c.role === 'advisor')[1].prompt, /alternative/);
  assert.equal((await read(f.cwd)).score, 100);
});

test('pause/reopen continues the saved assignment without replaying finished local trials', async () => {
  let entered; const waiting = new Promise(r => { entered = r; }); let workers = 0;
  const f = await fixture({ maxTrials: 4, invoke: async args => {
    if (args.role === 'worker' && ++workers === 2) { entered(); await new Promise((_, reject) => args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true })); }
  } });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await waiting;
  await f.engine.action(parent, { action: 'pause' }); await settle(f.engine);
  const saved = f.engine.get(parent.id), plan = structuredClone(saved.epochs[0]);
  await f.engine.dispose(); const reopened = new ExplorationEngine(f.config); await reopened.recover();
  await reopened.action(parent, { action: 'resume' }); await settle(reopened);
  const r = reopened.get(parent.id);
  assert.equal(f.calls.filter(c => c.role === 'advisor').length, 1);
  assert.deepEqual(r.epochs[0].assignments, plan.assignments); assert.equal(r.attempts, 4);
  assert.equal(r.trials[1].status, 'inconclusive'); assert.equal(r.trials[2].direction, 'alternative');
});

test('grouped evidence retains old negative evidence and separates execution failures', () => {
  const run = { revision: 1, criteriaVersion: 1, directions: [], trials: Array.from({ length: 14 }, (_, i) => ({ number: i+1, revision: 1, direction: i ? 'other' : 'old-method', hypothesis: i ? 'new' : 'negative mechanism', status: i ? 'inconclusive' : 'no-improvement', summary: i ? 'runtime missing' : 'measured worse' })) };
  const evidence = advisorEvidence(run);
  assert.equal(evidence[0].evidence[0].trial, 1); assert.equal(evidence[0].counts['no-improvement'], 1);
  assert.equal(evidence[1].counts.inconclusive, 13); assert.equal(evidence[1].counts['no-improvement'], undefined);
});

test('independent executable counterexample rejects former winner and retains old assessments', async () => {
  let reviews = 0;
  const f = await fixture({ review: true, maxTrials: 2, plans: [['fast']], results: [{ score: 80, behavior: 'correct' }, { score: 10, behavior: 'wrong' }],
    invoke: async args => { if (args.role === 'reviewer' && ++reviews === 2) return { ...await addCheck(args), title: '返回值语义', purpose: '保留目标之外的既有返回行为。' }; } });
  await f.engine.action(parent, { action: 'start', text: 'improve score only' }); await settle(f.engine);
  const r = f.engine.get(parent.id);
  assert.equal(r.status, 'completed', r.message); assert.equal(r.best.score, 80); assert.equal(r.criteriaVersion, 2); assert.equal(r.revision, 1);
  assert.equal(r.trials[1].valid, true, 'historical evaluation preserved');
  assert.equal(r.assessments.find(a => a.trial === 2).evaluation.valid, false);
  assert.equal(r.reviews[1].status, 'confirmed-regression'); assert.equal(r.reviewedBest.trial, 1);
  assert.equal(r.checks[0].title, '返回值语义'); assert.equal(r.reviews[1].title, r.checks[0].title);
  assert.equal(r.checks[0].purpose, '保留目标之外的既有返回行为。');
  const saved = JSON.parse(await readFile(path.join(r.root, 'report.json'), 'utf8'));
  assert.equal(saved.checks[0].title, r.checks[0].title);
  assert.equal(saved.reviews[1].targetTrial, 2); assert.equal(saved.reviews[1].publishedVersion, 2);
  const corrected = advisorEvidence(r).find(d => d.direction === 'fast');
  assert.equal(corrected.counts.invalid, 1); assert.equal(corrected.evidence.find(t => t.trial === 2).valid, false);
  assert.match(corrected.evidence.find(t => t.trial === 2).diagnostic, /behavior regression/);
  await f.engine.action(parent, { action: 'adopt' }); assert.equal((await read(f.cwd)).score, 80);
});

test('candidate modified during adoption re-evaluation cannot be copied back', async () => {
  const f = await fixture({ review: true, maxTrials: 1, plans: [['fast']] });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const original = f.config.tasks.entries.get(f.task.id).task;
  f.config.tasks.entries.get(f.task.id).task = { ...original, async evaluate(args) {
    const result = await original.evaluate(args);
    await write(f.engine.get(parent.id).best.dir, { score: 0, behavior: 'unreviewed' });
    return result;
  } };
  await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /复验后候选内容已改变/);
  assert.equal((await read(f.cwd)).score, 100);
});

test('malformed presentation metadata is omitted without changing executable check outcomes', async () => {
  let reviews = 0;
  const f = await fixture({ review: true, maxTrials: 1, plans: [['fast']], invoke: async args => {
    if (args.role === 'reviewer' && ++reviews === 1) return { ...await addCheck(args), title: 'x'.repeat(61), purpose: { invalid: true } };
  } });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const r = f.engine.get(parent.id);
  assert.equal(r.status, 'completed', r.message);
  assert.equal(r.checks[0].title, undefined); assert.equal(r.checks[0].purpose, undefined);
  assert.equal(r.best.supplementaryChecks[0].passed, true);
  assert.equal(r.checks[0].summary, 'behavior is outside the requested score improvement');
});

test('evaluation upgrade resumes after interruption without publishing partial rankings', async () => {
  let reviews = 0, block = true, entered; const waiting = new Promise(r => { entered = r; });
  const f = await fixture({ review: true, maxTrials: 2, plans: [['fast']], results: [{ score: 80, behavior: 'correct' }, { score: 10, behavior: 'wrong' }],
    invoke: async args => { if (args.role === 'reviewer' && ++reviews === 2) return addCheck(args); } });
  const evaluate = f.task.evaluate;
  f.config.tasks.entries.get(f.task.id).task = { ...f.task, async evaluate(args) {
    if (block && args.cwd.includes('checks') && (await read(args.cwd)).score === 80 && f.engine.get(parent.id)?.pendingReview) {
      entered(); await new Promise((_, reject) => args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true }));
    }
    return evaluate(args);
  } };
  await f.engine.action(parent, { action: 'start', text: 'improve score' }); await waiting;
  await f.engine.action(parent, { action: 'pause' }); await settle(f.engine);
  let r = f.engine.get(parent.id); assert.equal(r.criteriaVersion, 1); assert.ok(r.pendingReview); assert.equal(r.pendingReview.results.length, 1);
  await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /独立审查/);
  await f.engine.dispose(); block = false;
  const reopened = new ExplorationEngine(f.config); await reopened.recover();
  await reopened.action(parent, { action: 'review' }); await settle(reopened);
  r = reopened.get(parent.id); assert.equal(r.status, 'completed', r.message); assert.equal(r.best.score, 80); assert.equal(r.pendingReview, null);
  assert.equal(r.assessments.filter(a => a.criteriaVersion === 2).length, 3);
});

test('bugfix failing baseline accepts independent preserved-behavior checks', async () => {
  let reviews = 0;
  const f = await fixture({ review: true, maxTrials: 1, plans: [['repair']], initial: { fixed: false, behavior: 'correct' }, results: [{ fixed: true, behavior: 'correct' }],
    task: { async evaluate({ cwd }) { const v = await read(cwd); return { valid: v.fixed, reproduced: !v.fixed, summary: v.fixed ? 'fixed' : 'reproduced' }; }, validateBaseline(r) { assert.equal(r.reproduced, true); }, compare: (a,b) => a.valid && !b.valid ? 'better' : 'equal', complete: r => r.valid },
    invoke: async args => { if (args.role === 'reviewer' && ++reviews === 1) return addCheck(args); } });
  await f.engine.action(parent, { action: 'start', text: 'fix only target' }); await settle(f.engine);
  const r = f.engine.get(parent.id); assert.equal(r.status, 'completed', r.message); assert.equal(r.baseline.valid, false); assert.equal(r.best.valid, true); assert.equal(r.criteriaVersion, 2);
  await f.engine.action(parent, { action: 'adopt' }); assert.equal((await read(f.cwd)).fixed, true);
});

test('review that protects an already failing original behavior cannot publish new criteria', async () => {
  const f = await fixture({ review: true, invoke: args => args.role === 'reviewer' ? addCheck(args, 'const passed=false;') : undefined });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const r = f.engine.get(parent.id); assert.equal(r.status, 'blocked'); assert.equal(r.criteriaVersion, 1); assert.equal(r.pendingReview, null); assert.match(r.message, /未通过原始项目/);
  assert.equal(r.reviews.length, 2); assert.ok(r.reviews.every(x => x.status === 'inconclusive' && x.failedProposal));
  assert.equal(r.attempts, 0);
});

test('evaluators cannot temporarily repair a bad candidate and report success', async () => {
  const f = await fixture({ task: { async evaluate({ cwd }) { await write(cwd, { score: 1 }); return { valid: true, score: 1, summary: 'false pass' }; } } });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  assert.match(f.engine.get(parent.id).message, /评价修改了候选/); assert.equal((await read(f.cwd)).score, 100);
});

test('review checks cannot mutate source while reporting passed', async () => {
  const f = await fixture({ review: true, invoke: args => args.role === 'reviewer' ? addCheck(args, `fs.writeFileSync('value.json',JSON.stringify({score:1})); const passed=true;`) : undefined });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  assert.match(f.engine.get(parent.id).message, /评价修改了候选/); assert.equal(f.engine.get(parent.id).criteriaVersion, 1);
});

test('an evaluator cannot add a missing dependency to make submitted code pass', async () => {
  const f = await fixture({ task: { async evaluate({ cwd }) { await writeFile(path.join(cwd, 'helper.js'), 'export const repaired=true'); return { valid: true, score: 1, summary: 'false pass' }; } } });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  assert.match(f.engine.get(parent.id).message, /评价修改了候选/);
});

test('review reference is checked independently and cannot be modified inside excluded storage', async () => {
  const f = await fixture({ review: true, invoke: async args => {
    if (args.role !== 'reviewer') return;
    const reference = args.prompt.match(/(\.dsh\/reference-[^/]+)\/ 是只读/)[1];
    await write(path.join(args.cwd, reference), { score: 5 });
    return { hasChecks: false, summary: 'false review' };
  } });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  assert.match(f.engine.get(parent.id).message, /审查修改了参考项目/);
});

test('an inapplicable review is corrected once using its actual failure feedback', async () => {
  let count = 0;
  const f = await fixture({ review: true, maxTrials: 1, plans: [['fast']], invoke: async args => {
    if (args.role !== 'reviewer') return;
    if (++count === 1) return addCheck(args, 'const passed=false;');
    if (count === 2) { assert.match(args.prompt, /未通过原始项目/); return addCheck(args); }
  } });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  const r = f.engine.get(parent.id); assert.equal(r.status, 'completed', r.message); assert.equal(r.criteriaVersion, 2); assert.equal(r.reviews[0].status, 'inconclusive');
});

test('per-call settings reach every role and preserve unedited run allowance', async () => {
  const seen = [];
  const f = await fixture({ maxTrials: 1, invoke: async args => { seen.push(structuredClone(args.settings)); } });
  await f.engine.action(parent, { action: 'start', text: 'improve', settings: { maxStepsPerCall: 48, maxMinutesPerCall: 10 } }); await settle(f.engine);
  assert.ok(seen.length >= 4);
  assert.ok(seen.every(s => s.maxStepsPerCall === 48 && s.maxMinutesPerCall === 10));
  const before = f.engine.get(parent.id);
  await f.engine.action(parent, { action: 'configure', settings: { maxMinutesPerCall: 6 } });
  const after = f.engine.get(parent.id);
  assert.equal(after.settings.maxStepsPerCall, 48);
  assert.equal(after.settings.maxMinutesPerCall, 6);
  assert.equal(after.limit, before.limit);
  assert.equal(after.timeLimitMs, before.timeLimitMs);
  assert.throws(() => settings({ maxStepsPerCall: 3 }), /maxStepsPerCall/);
  assert.throws(() => settings({ maxMinutesPerCall: 61 }), /maxMinutesPerCall/);
});

test('review approval binds exact candidate bytes, and settings retain already consumed allowance', async () => {
  const f = await fixture({ review: true, maxTrials: 2, plans: [['fast']] });
  await f.engine.action(parent, { action: 'start', text: 'improve' }); await settle(f.engine);
  await write(f.engine.get(parent.id).best.dir, { score: 1, behavior: 'wrong' });
  await assert.rejects(f.engine.action(parent, { action: 'adopt' }), /审查后候选/);
  await f.engine.action(parent, { action: 'configure', settings: { maxTrials: 1, directions: 1 } });
  const r = f.engine.get(parent.id); assert.equal(r.attempts, 2); assert.equal(r.limit, 1);
  assert.throws(() => settings({ directions: 0 }), /directions/); assert.throws(() => settings({ unknown: 1 }), /未知/);
});
