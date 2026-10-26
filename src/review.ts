import { supplementaryChecks } from './data.js';
import type { Run, Review } from './data.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CodeWorkflow } from './code-workflow.js';
import type { CodeDefinition } from './contracts.js';
import { required, isRecord } from './errors.js';
import { assertCode, assertPrepared, assertFileCandidate } from './invariants.js';
import { message } from './errors.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { snapshot, inventory, copyEvaluation, changedFiles, candidateDiff } from './workspace.js';
import { rerank } from './sla-strategy.js';
import { reviewed } from './research-state.js';
import { candidateFrom, publishCriteria } from './kernel.js';
import { fileArtifact } from './file-artifacts.js';

export async function reviewCandidate(engine: CodeWorkflow, run: Run, parent: Agent, signal: AbortSignal, task: CodeDefinition, phase: 'baseline' | 'candidate'): Promise<void> {
  assertPrepared(run); assertCode(run); assertFileCandidate(run.best);
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
  const record: Review = { id, phase, revision: run.revision, criteriaVersion: run.criteriaVersion, targetTrial: target.trial, targetFiles: files, status: 'running' };
  run.reviews.push(record); run.reviewedBest = null;
  run.stage = 'review'; run.message = phase === 'baseline' ? '正在独立检查评价依据是否遗漏保留行为' : '正在检查候选是否有原评价遗漏的回归';
  await engine.save(run);
  try {
    const response = await engine.invoke(run, parent, 'reviewer', setup,
      task.review.prompt(structuredClone(run), { phase, checkDirectory, originalDirectory: originalName, previousFailures: attempts.map(a => a.error ?? a.summary ?? '') }), task.review.schema, signal);
    if (!isRecord(response) || typeof response.hasChecks !== 'boolean' || typeof response.summary !== 'string' || !response.summary.trim()) throw new Error('审查结果格式无效');
    if (changedFiles(source, await inventory(setup)).length) throw new Error('审查修改了源文件或参考项目，未接受检查');
    if (changedFiles(referenceFiles, await inventory(path.join(setup, originalName))).length) throw new Error('审查修改了参考项目，未接受检查');
    const proposedDir = path.join(run.root, 'review-criteria-' + id);
    const proposedFiles = await copyEvaluation(setup, proposedDir);
    if (Object.keys(priorFiles).some(name => priorFiles[name] !== proposedFiles[name])) throw new Error('审查改写了已冻结检查');
    const added = Object.keys(proposedFiles).filter(name => !Object.hasOwn(priorFiles, name));
    if (added.some(name => !name.startsWith(checkDirectory + '/'))) throw new Error('审查在指定补充检查目录之外新增了文件');
    record.summary = response.summary;
    // Display metadata is optional; the executable check remains authoritative.
    for (const [key, limit] of [['title', 60], ['purpose', 300]] as const) {
      if (typeof response[key] === 'string' && response[key].trim() && response[key].length <= limit) record[key] = response[key].trim();
    }
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
      ...run.trials.filter(t => t.revision === run.revision && (t.eligibility?.retain ?? t.valid) && t.changes?.length).map(t => ({ trial: t.number, dir: required(t.dir, '候选目录'), direction: t.direction, files: t.files }))];
    if (run.best.trial && !candidates.some(c => c.trial === run.best.trial)) candidates.push({ trial: run.best.trial, dir: run.best.dir, files: await inventory(run.best.dir) });
    run.pendingReview = { id, revision: run.revision, criteriaVersion: run.criteriaVersion + 1,
      evaluationDir: proposedDir, evaluationFiles: proposedFiles,
      checks: [...run.checks, { id, directory: checkDirectory, summary: response.summary, ...(record.title ? { title: record.title } : {}), ...(record.purpose ? { purpose: record.purpose } : {}) }], candidates, results: [] };
    record.status = 'checking';
    await engine.save(run);
    await finishReview(engine, run, parent, signal, task);
  } catch (error) {
    if (!run.pendingReview) record.status = 'inconclusive';
    record.error = message(error);
    await engine.save(run);
    if (!run.pendingReview && !signal.aborted && attempts.length < 1) return reviewCandidate(engine, run, parent, signal, task, phase);
    throw error;
  }
}

// No active ranking is changed until every retained candidate has an assessment
// under the proposed evaluator. Reopening resumes this transaction by identity.
export async function finishReview(engine: CodeWorkflow, run: Run, parent: Agent, signal: AbortSignal, task: CodeDefinition): Promise<void> {
  assertPrepared(run); assertCode(run);
  const pending = run.pendingReview;
  if (!pending) return;
  if (pending.kind === 'workflow') throw new Error('评价升级不是代码工作流');
  if (pending.revision !== run.revision) throw new Error('待发布评价的目标版本不一致');
  run.stage = 'review'; run.message = '正在用新增检查复验初始项目与各方向候选';
  await engine.save(run);
  try {
  for (const candidate of pending.candidates) {
    signal.throwIfAborted();
    if (candidate.files && changedFiles(candidate.files, await inventory(candidate.dir)).length) throw new Error('待复验候选内容已改变，未发布评价');
    candidate.artifactId ??= (await fileArtifact(run, candidate.dir, candidate.trial)).id;
    if (pending.results.some(r => r.trial === candidate.trial)) continue;
    const measured = await engine.evaluate(run, candidate.dir, parent, signal, run.criteria, pending);
    const evaluation = measured.evaluation;
    if (candidate.trial === 0) {
      if (supplementaryChecks(evaluation).some(c => !c.passed)) throw new Error('新增保留行为检查未通过原始项目，不能据此认定候选回归');
      await task.validateBaseline(structuredClone(evaluation), structuredClone(run.criteria));
    }
    pending.results.push({ ...candidate, ...measured });
    await engine.save(run);
  }
  } catch (error) {
    if (!signal.aborted) {
      const record = required(run.reviews.find(r => r.id === pending.id), '审查记录');
      record.status = 'inconclusive'; record.error = message(error);
      record.failedProposal = pending;
      run.pendingReview = null;
      await engine.save(run);
    }
    throw error;
  }
  signal.throwIfAborted();
  const base = required(pending.results.find(r => r.trial === 0), '基线复验');
  const baseline = candidateFrom(base, { trial: 0, dir: run.baselineDir, criteriaVersion: pending.criteriaVersion });
  const { best, local, frontier } = rerank(task, run.criteria, baseline, pending.results.filter(r => r.trial > 0).map(result => ({
    candidate: candidateFrom(result, { trial: result.trial, dir: result.dir, criteriaVersion: pending.criteriaVersion }), lane: result.direction,
  })));
  if (best.trial) best.diff = await candidateDiff(run.baselineDir, required(best.dir, '候选目录'));
  await writeFile(path.join(run.root, 'best.patch'), best.diff ?? '');
  const record = required(run.reviews.find(r => r.id === pending.id), '审查记录');
  if (record) {
    const target = pending.results.find(r => r.trial === record.targetTrial);
    record.status = supplementaryChecks(target?.evaluation).some(c => !c.passed) ? 'confirmed-regression' : 'accepted';
    if (record.status === 'confirmed-regression') delete run.stopReason;
    record.publishedVersion = pending.criteriaVersion;
  }
  publishCriteria(run, pending, { baseline: base, best, local, frontier });
  run.evaluationDir = pending.evaluationDir; run.evaluationFiles = pending.evaluationFiles; run.checks = pending.checks;
  run.baselineReviewed = run.revision;
  run.reviewedBest = record?.phase === 'candidate' && best.trial === record.targetTrial
    ? { trial: best.trial, criteriaVersion: run.criteriaVersion, revision: run.revision, task: run.task, files: record.targetFiles } : null;
  await engine.save(run);
}
