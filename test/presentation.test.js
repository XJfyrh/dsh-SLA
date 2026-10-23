import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inventory } from '../src/workspace.js';
import { changePreview } from '../src/change-preview.js';
import { criteriaMarkdown, evaluationView, currentEvaluation, matchesPreview } from '../src/presentation.js';

test('legacy criteria become paragraphs and lists without rewriting inline code or authored Markdown', () => {
  const text = 'criterion：检查：(1) 运行 `fn();(2)`；(2) 保持行为。性能：重复测量。';
  const formatted = criteriaMarkdown(text);
  assert.match(formatted, /\n\n1\. 运行 `fn\(\);\(2\)`/);
  assert.match(formatted, /\n\n2\. 保持行为/);
  assert.match(formatted, /### 性能/);
  const md = '### 检查\n\n- `code`\n\n```js\nf();\n```\n\n| A | B |\n|---|---|';
  assert.equal(criteriaMarkdown(md), md);
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
  const run = { id: 'a', best: { trial: 2 }, criteriaVersion: 3 };
  const preview = { runId: 'a', trial: 2, criteriaVersion: 3 };
  assert.equal(matchesPreview(preview, run), true);
  for (const patch of [{ runId: 'b' }, { trial: 1 }, { criteriaVersion: 2 }]) assert.equal(matchesPreview({ ...preview, ...patch }, run), false);
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
