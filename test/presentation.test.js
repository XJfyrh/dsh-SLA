import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inventory } from '../src/workspace.js';
import { changePreview } from '../src/change-preview.js';
import { evaluationView, currentEvaluation, matchesPreview, candidateBrief, checkPresentation, decisionView } from '../src/presentation.js';

const decisionRun = (evaluation = { valid: true, score: 2 }) => ({
  revision: 1, criteriaVersion: 2, status: 'completed', reviewSupported: true,
  reviewedBest: { trial: 1, revision: 1, criteriaVersion: 2 }, best: { trial: 1 },
  trials: [{ number: 1, revision: 1, criteriaVersion: 1, evaluation: { valid: true, score: 1 }, report: '### 改动说明\n保留输入顺序。\n### 尚未验证\n大型数据尚未验证。' }, { number: 2, revision: 1, criteriaVersion: 1, evaluation: { valid: true, score: 0.1 } }],
  assessments: [{ trial: 1, revision: 1, criteriaVersion: 2, evaluation }, { trial: 2, revision: 1, criteriaVersion: 2, evaluation: { valid: false, score: 0.1 } }],
});

test('decision uses current assessment or adoption recheck, preserves evidence and explains exclusions', () => {
  const run = decisionRun(), before = structuredClone(run);
  const view = decisionView(run);
  assert.equal(view.ready, true); assert.equal(view.evaluation.score, 2);
  assert.deepEqual(view.excluded, [2]); assert.equal(view.brief.change, '保留输入顺序。');
  const adopted = decisionView({ ...run, adopted: true, adoptionCheck: { valid: true, score: 3 } });
  assert.equal(adopted.evaluation.score, 3); assert.equal(adopted.ready, false);
  assert.deepEqual(run, before);
});

test('no actionable or comparable result leaks through rebuild, outdated review, missing or failed evaluation', () => {
  const run = decisionRun();
  for (const patch of [{ rebuild: true }, { status: 'running' }, { pendingReview: { id: 'x' } }, { adoptionPending: true }, { reviewedBest: { trial: 1, revision: 0, criteriaVersion: 2 } }, { assessments: [] }]) assert.equal(decisionView({ ...run, ...patch }).ready, false);
  assert.equal(decisionView({ ...run, rebuild: true }).trial, null);
  assert.equal(decisionView({ ...run, assessments: [] }).evaluation, null);
  assert.equal(decisionView(decisionRun({ valid: true, supplementaryChecks: [{ passed: false }] })).ready, false);
  assert.equal(decisionView(decisionRun({ summary: 'passed' })).ready, false);
});

test('non-numeric tasks retain their own result language without performance assumptions', () => {
  const view = decisionView(decisionRun({ valid: true, display: '修复通过' }));
  assert.equal(view.ready, true); assert.equal(view.evaluation.display, '修复通过'); assert.equal(view.evaluation.score, undefined);
  assert.equal(decisionView({ ...decisionRun(), best: { trial: 1, eligibility: { retain: true, deliver: false } } }).ready, false);
});

test('semantic check metadata and historical finding remain separate from current passed result', () => {
  const check = { id: 'a', passed: true, summary: '当前候选通过' };
  const run = { checks: [{ id: 'a', title: '自定义迭代器语义', purpose: '保持输入的迭代协议。', summary: '旧候选未通过' }], reviews: [{ id: 'a', targetTrial: 4, criteriaVersion: 2, publishedVersion: 3, status: 'confirmed-regression' }] };
  const view = checkPresentation(run, check, 0);
  assert.equal(view.title, '自定义迭代器语义'); assert.equal(view.origin.trial, 4); assert.equal(view.origin.version, 2);
  assert.equal(view.original, '旧候选未通过'); assert.equal(check.passed, true);
  const unnamed = checkPresentation({ checks: [{ id: 'a', summary: 'unnamed' }] }, check, 0);
  assert.equal(unnamed.title, null); assert.equal(unnamed.origin, null);
});

test('only bounded explicit worker sections become user briefs; unstructured logs stay original', () => {
  assert.deepEqual(candidateBrief('all passed; great improvement'), {});
  assert.deepEqual(candidateBrief('```md\n### 改动说明\nThis is a quoted template.\n```'), {});
  assert.deepEqual(candidateBrief('### 改动说明\n' + 'x'.repeat(501)), {});
  assert.deepEqual(candidateBrief('### 改动说明\n调整边界。\n### 尚未验证\n其它平台。\n### 实现记录\nSLA_RESULT {}'), { change: '调整边界。', unverified: '其它平台。' });
});

test('unknown and failed checks cannot become a passed presentation', () => {
  assert.equal(evaluationView({ summary: 'all passed' }).status, 'unknown');
  assert.equal(evaluationView({ valid: false, summary: 'all passed' }).status, 'failed');
  assert.equal(evaluationView({ valid: true, supplementaryChecks: [{ passed: false }] }).status, 'failed');
  assert.equal(evaluationView({ valid: true, supplementaryChecks: [{}] }).status, 'unknown');
  const view = evaluationView({ valid: true, score: 0, supplementaryChecks: [{ passed: true }, { passed: true }] });
  assert.equal(view.status, 'passed'); assert.equal(view.passed, 2); assert.equal(view.total, 2);
});

test('current failed assessment supersedes historical success without rewriting evidence', () => {
  const trial = { number: 1, revision: 1, criteriaVersion: 1, evaluation: { valid: true, score: 0.1 } };
  const run = { revision: 1, criteriaVersion: 2, assessments: [{ trial: 1, revision: 1, criteriaVersion: 2, evaluation: { valid: false, summary: 'regression' } }] };
  assert.equal(currentEvaluation(run, trial).evaluation.valid, false);
  assert.equal(trial.evaluation.valid, true);
  assert.equal(currentEvaluation({ ...run, assessments: [] }, trial).historical, true);
  assert.equal(currentEvaluation({ ...run, revision: 2 }, trial).historical, true);
});

test('late change previews cannot be shown for a different run, candidate or evaluation version', () => {
  const run = { id: 'a', best: { trial: 2, artifactId: 'sealed' }, criteriaVersion: 3 };
  const preview = { runId: 'a', trial: 2, artifactId: 'sealed', criteriaVersion: 3 };
  assert.equal(matchesPreview(preview, run), true);
  for (const patch of [{ runId: 'b' }, { trial: 1 }, { criteriaVersion: 2 }, { artifactId: 'changed' }, { artifactId: undefined }]) assert.equal(matchesPreview({ ...preview, ...patch }, run), false);
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sla-preview-'));
  const before = path.join(root, 'before'), after = path.join(root, 'after');
  await mkdir(before); await mkdir(after);
  return { root, before, after, async run() {
    return { id: 'preview', baselineDir: before, sourceFiles: await inventory(before), best: { trial: 1, dir: after },
      criteriaVersion: 1, trials: [{ number: 1, files: await inventory(after) }] };
  } };
}

test('preview reads actual added, deleted and modified files with relative Unicode names, leaving bytes intact', async () => {
  const f = await fixture();
  await writeFile(path.join(f.before, '中文 name.js'), 'old\n'); await writeFile(path.join(f.after, '中文 name.js'), 'new\n');
  await writeFile(path.join(f.before, 'gone.js'), 'deleted\n'); await writeFile(path.join(f.after, 'added.js'), 'added\n');
  const run = await f.run(); const preview = await changePreview(run);
  assert.equal(preview.files.length, 3);
  assert.deepEqual(preview.files.find(f => f.path === '中文 name.js'), { path: '中文 name.js', kind: 'modified', oldText: 'old\n', newText: 'new\n' });
  assert.equal(preview.files.find(f => f.path === 'gone.js').newText, '');
  assert.equal(preview.files.find(f => f.path === 'added.js').oldText, null);
  assert.deepEqual(await inventory(f.before), run.sourceFiles);
  assert.deepEqual(await inventory(f.after), run.trials[0].files);
});

test('preview refuses altered snapshots and missing historical hashes', async () => {
  const f = await fixture();
  await writeFile(path.join(f.before, 'a.js'), 'before'); await writeFile(path.join(f.after, 'a.js'), 'after');
  const run = await f.run();
  await writeFile(path.join(f.after, 'a.js'), 'changed after validation');
  await assert.rejects(changePreview(run), /快照内容已改变/);
  await assert.rejects(changePreview({ ...run, trials: [] }), /缺少文件校验/);
});

test('binary and large files stay listed with explicit omissions, never decoded or silently truncated', async () => {
  const f = await fixture();
  await writeFile(path.join(f.after, 'binary.bin'), Buffer.from([0, 255, 34]));
  await writeFile(path.join(f.after, 'large.txt'), 'a'.repeat(129 * 1024));
  const preview = await changePreview(await f.run());
  assert.deepEqual(preview.files.map(f => f.omitted), ['binary', 'large']);
  assert.equal(preview.files.some(f => 'newText' in f), false);
});
