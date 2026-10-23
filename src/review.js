import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { snapshot, inventory, copyEvaluation, changedFiles, candidateDiff } from './workspace.js';
import { compare } from './task-registry.js';
import { reviewed } from './research-state.js';

export async function reviewCandidate(engine, run, parent, signal, task, phase) {
  if (!task.review) return;
  if (run.pendingReview) return finishReview(engine, run, parent, signal, task);
  if (phase === 'candidate' && reviewed(run, task)) return;
  const target = phase === 'baseline' ? { dir: run.baselineDir, trial: 0 } : run.best;
  const expected = target.trial ? run.trials.find(t => t.number === target.trial)?.files : run.sourceFiles;
  if (expected && changedFiles(expected, await inventory(target.dir)).length) throw new Error('已评价的候选内容发生变化，未启动审查');
  const attempts = run.reviews.filter(r => r.revision === run.revision && r.phase === phase && r.targetTrial === target.trial && r.status === 'inconclusive');
  if (attempts.length >= 2) throw new Error('同一候选的审查两次未完成，请检查失败证据或补充要求后再继续');
  const id = randomUUID(), setup = path.join(run.root, 'review-' + id);
  const files = await snapshot(target.dir, setup);
  const originalName = '.dsh/reference-' + id;
  const referenceFiles = await snapshot(run.baselineDir, path.join(setup, originalName));
  const source = await inventory(setup);
  const priorFiles = await copyEvaluation(run.evaluationDir, setup);
  if (changedFiles(run.evaluationFiles, priorFiles).length) throw new Error('固定评价依据校验失败');
  const checkDirectory = `reviews/${id}`;
  await mkdir(path.join(setup, '.sla', checkDirectory), { recursive: true });
  const record = { id, phase, revision: run.revision, criteriaVersion: run.criteriaVersion, targetTrial: target.trial, targetFiles: files, status: 'running' };
  run.reviews.push(record); run.reviewedBest = null;
  run.stage = 'review'; run.message = phase === 'baseline' ? '正在独立检查评价依据是否遗漏保留行为' : '正在检查候选是否有原评价遗漏的回归';
  await engine.save(run);
  try {
    const response = await engine.invoke(run, parent, 'reviewer', setup,
      task.review.prompt(structuredClone(run), { phase, checkDirectory, originalDirectory: originalName, previousFailures: attempts.map(a => a.error ?? a.summary) }), task.review.schema, signal);
    if (typeof response?.hasChecks !== 'boolean' || typeof response.summary !== 'string' || !response.summary.trim()) throw new Error('审查结果格式无效');
    if (changedFiles(source, await inventory(setup)).length) throw new Error('审查修改了源文件或参考项目，未接受检查');
    if (changedFiles(referenceFiles, await inventory(path.join(setup, originalName))).length) throw new Error('审查修改了参考项目，未接受检查');
    const proposedDir = path.join(run.root, 'review-criteria-' + id);
    const proposedFiles = await copyEvaluation(setup, proposedDir);
    if (Object.keys(priorFiles).some(name => priorFiles[name] !== proposedFiles[name])) throw new Error('审查改写了已冻结检查');
    const added = Object.keys(proposedFiles).filter(name => !Object.hasOwn(priorFiles, name));
    if (added.some(name => !name.startsWith(checkDirectory + '/'))) throw new Error('审查在指定补充检查目录之外新增了文件');
    record.summary = response.summary;
    if (!response.hasChecks) {
      if (attempts.length) throw new Error('此前审查检查未完成，不能用“没有新检查”替代失败检查');
      if (added.length) throw new Error('审查声称没有新检查，但实际新增了评价文件');
      record.status = 'no-checks';
      if (phase === 'baseline') run.baselineReviewed = run.revision;
      else run.reviewedBest = { trial: target.trial, criteriaVersion: run.criteriaVersion, revision: run.revision, task: run.task, files };
      await engine.save(run); return;
    }
    if (!added.length) throw new Error('审查没有生成可执行的补充检查');
    const candidates = [{ trial: 0, dir: run.baselineDir, files: run.sourceFiles },
      ...run.trials.filter(t => t.revision === run.revision && t.valid && t.changes?.length).map(t => ({ trial: t.number, dir: t.dir, direction: t.direction, files: t.files }))];
    if (run.best.trial && !candidates.some(c => c.trial === run.best.trial)) candidates.push({ trial: run.best.trial, dir: run.best.dir, files: await inventory(run.best.dir) });
    run.pendingReview = { id, revision: run.revision, criteriaVersion: run.criteriaVersion + 1,
      evaluationDir: proposedDir, evaluationFiles: proposedFiles,
      checks: [...run.checks, { id, directory: checkDirectory, summary: response.summary }], candidates, results: [] };
    record.status = 'checking';
    await engine.save(run);
    await finishReview(engine, run, parent, signal, task);
  } catch (error) {
    if (!run.pendingReview) record.status = 'inconclusive';
    record.error = String(error.message ?? error);
    await engine.save(run);
    if (!run.pendingReview && !signal.aborted && attempts.length < 1) return reviewCandidate(engine, run, parent, signal, task, phase);
    throw error;
  }
}

// No active ranking is changed until every retained candidate has an assessment
// under the proposed evaluator. Reopening resumes this transaction by identity.
export async function finishReview(engine, run, parent, signal, task) {
  const pending = run.pendingReview;
  if (!pending) return;
  if (pending.revision !== run.revision) throw new Error('待发布评价的目标版本不一致');
  run.stage = 'review'; run.message = '正在用新增检查复验初始项目与各方向候选';
  await engine.save(run);
  try {
  for (const candidate of pending.candidates) {
    signal.throwIfAborted();
    if (candidate.files && changedFiles(candidate.files, await inventory(candidate.dir)).length) throw new Error('待复验候选内容已改变，未发布评价');
    if (pending.results.some(r => r.trial === candidate.trial)) continue;
    const evaluation = await engine.evaluate(run, candidate.dir, parent, signal, run.criteria, pending);
    if (candidate.trial === 0) {
      if (evaluation.supplementaryChecks?.some(c => !c.passed)) throw new Error('新增保留行为检查未通过原始项目，不能据此认定候选回归');
      await task.validateBaseline(structuredClone(evaluation), structuredClone(run.criteria));
    }
    pending.results.push({ ...candidate, evaluation });
    await engine.save(run);
  }
  } catch (error) {
    if (!signal.aborted) {
      const record = run.reviews.find(r => r.id === pending.id);
      record.status = 'inconclusive'; record.error = String(error.message ?? error);
      record.failedProposal = pending;
      run.pendingReview = null;
      await engine.save(run);
    }
    throw error;
  }
  signal.throwIfAborted();
  const baseline = pending.results.find(r => r.trial === 0).evaluation;
  let best = { ...baseline, evaluation: baseline, trial: 0, dir: run.baselineDir, criteriaVersion: pending.criteriaVersion };
  const local = new Map();
  for (const result of pending.results.filter(r => r.trial > 0 && r.evaluation.valid)) {
    const candidate = { ...result.evaluation, evaluation: result.evaluation, trial: result.trial, dir: result.dir, criteriaVersion: pending.criteriaVersion };
    if (compare(task, result.evaluation, best.evaluation, run.criteria) === 'better') best = candidate;
    const prior = local.get(result.direction);
    if (!prior || compare(task, result.evaluation, prior.evaluation, run.criteria) === 'better') local.set(result.direction, candidate);
  }
  if (best.trial) best.diff = await candidateDiff(run.baselineDir, best.dir);
  await writeFile(path.join(run.root, 'best.patch'), best.diff ?? '');
  const record = run.reviews.find(r => r.id === pending.id);
  const target = pending.results.find(r => r.trial === record.targetTrial);
  record.status = target?.evaluation.supplementaryChecks?.some(c => !c.passed) ? 'confirmed-regression' : 'accepted';
  if (record.status === 'confirmed-regression') delete run.stopReason;
  record.publishedVersion = pending.criteriaVersion;
  if (!run.assessments.some(a => a.trial === 0 && a.criteriaVersion === run.criteriaVersion)) run.assessments.push({ trial: 0, criteriaVersion: run.criteriaVersion, revision: run.revision, evaluation: run.baseline });
  run.assessments.push(...pending.results.map(r => ({ trial: r.trial, direction: r.direction, revision: run.revision, criteriaVersion: pending.criteriaVersion, evaluation: r.evaluation })));
  run.criteriaVersion = pending.criteriaVersion;
  run.evaluationDir = pending.evaluationDir; run.evaluationFiles = pending.evaluationFiles; run.checks = pending.checks;
  run.baseline = baseline; run.best = best; run.baselineReviewed = run.revision;
  for (const direction of run.directions.filter(d => d.revision === run.revision)) {
    direction.best = local.get(direction.id) ?? null;
    direction.seed = structuredClone(best);
  }
  for (const epoch of run.epochs) if (epoch.status === 'running') epoch.status = 'superseded';
  run.reviewedBest = record.phase === 'candidate' && best.trial === record.targetTrial
    ? { trial: best.trial, criteriaVersion: run.criteriaVersion, revision: run.revision, task: run.task, files: record.targetFiles } : null;
  run.pendingReview = null;
  await engine.save(run);
}
