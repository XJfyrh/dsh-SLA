import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { inventory, snapshot, changedFiles, copyEvaluation, verifyEvaluation, adopt, recoverAdoption, candidateDiff } from './workspace.js';
import { advisorSchema, advisorPrompt, workerPrompt } from './prompts.js';
import { compare, qualify, validateEvaluation } from './task-registry.js';
import { reviewed } from './research-state.js';
import { reviewCandidate, finishReview } from './review.js';
import { explore, retain, initialFrontier } from './sla-strategy.js';
import { artifactById, beginRevision, candidateFrom, observe, reserveAttempt } from './kernel.js';
import { fileArtifact, verifyFileArtifact } from './file-artifacts.js';

// File-project workflow. The engine owns lifetime and durable writes; this
// composition owns Scout, preserved-behavior review and workspace delivery.
export class CodeWorkflow {
  constructor(engine) { this.engine = engine; }
  get adapter() { return this.engine.adapter; }
  get tasks() { return this.engine.tasks; }
  save(run) { return this.engine.save(run); }
  invoke(...args) { return this.engine.invoke(...args); }
  recover(run) { return recoverAdoption(run); }
  async evaluate(run, candidate, parent, signal, criteria = run.criteria, spec = run) {
    await this.adapter.authorize(parent);
    const entry = this.tasks.get(run.task);
    signal = AbortSignal.any([signal, entry.signal]);
    signal.throwIfAborted();
    const trial = run.trials.find(t => t.dir === candidate && t.revision === run.revision);
    const artifact = await fileArtifact(run, candidate, trial?.number ?? 0, trial?.parentArtifactId);
    const dir = path.join(run.root, 'checks', randomUUID());
    const candidateFiles = await snapshot(candidate, dir);
    if (changedFiles(artifact.payload.files, candidateFiles).length) throw new Error('评价副本与封存候选不一致');
    const evaluationFiles = await copyEvaluation(spec.evaluationDir, dir);
    if (spec.evaluationFiles && changedFiles(spec.evaluationFiles, evaluationFiles).length) throw new Error('固定评价依据校验失败');
    const evidence = path.join(run.root, 'evaluation-output-' + randomUUID() + '.json');
    const outputs = [];
    try {
      const context = {
        cwd: dir, signal, criteria: structuredClone(criteria),
        execute: async command => {
          signal.throwIfAborted();
          if (typeof command !== 'string' || !command.trim()) throw new Error('评价命令不能为空');
          const result = await this.adapter.execute({ parent, cwd: dir, signal, command });
          outputs.push({ command, result });
          await writeFile(evidence, JSON.stringify({ outputs }, null, 2));
          return result;
        },
      };
      const parsed = validateEvaluation(await entry.task.evaluate(context));
      const supplementary = [];
      for (const check of spec.checks ?? []) {
        if (!entry.task.review) throw new Error('当前任务扩展无法执行已冻结的补充检查');
        const result = await entry.task.review.evaluate({ ...context, check: structuredClone(check) });
        if (typeof result?.passed !== 'boolean' || typeof result.summary !== 'string' || !result.summary.trim()) throw new Error('补充检查结果格式无效');
        supplementary.push({ id: check.id, passed: result.passed, summary: result.summary });
      }
      signal.throwIfAborted();
      await this.adapter.authorize(parent);
      // Evaluators run in a throwaway copy, but may not rewrite their own checks.
      await verifyEvaluation(dir, evaluationFiles);
      const after = await inventory(dir);
      if (changedFiles(candidateFiles, after).length) throw new Error('评价修改了候选源文件或已有测试，未接受结果');
      await verifyFileArtifact(artifact);
      if (supplementary.length) {
        parsed.supplementaryChecks = supplementary;
        parsed.valid = parsed.valid && supplementary.every(x => x.passed);
        parsed.summary += '\n补充检查：' + supplementary.map(x => `${x.id}: ${x.passed ? '通过' : '失败'} ${x.summary}`).join('; ');
      }
      await writeFile(evidence, JSON.stringify({ task: run.task, outputs, result: parsed }, null, 2));
      const result = { ...parsed, evidence };
      const observation = observe(run, artifact.id, result, { criteriaVersion: spec.criteriaVersion, conditions: { evaluationFiles } });
      return { evaluation: result, artifactId: artifact.id, observationId: observation.id };
    } catch (error) {
      await writeFile(evidence, JSON.stringify({ task: run.task, outputs, error: String(error.message ?? error) }, null, 2));
      error.evidence = evidence;
      throw error;
    }
  }
  async execute(run, parent, signal) {
    run.status = 'running';
    run.workflow = { kind: 'code', id: 'file-code', version: '1.0.0' };
    if (!run.sourceFiles) {
      run.baselineDir = path.join(run.root, 'initial-' + randomUUID());
      run.sourceFiles = await snapshot(run.cwd, run.baselineDir);
      if (!Object.keys(run.sourceFiles).length) throw new Error('项目中没有可探索的源文件。');
      await this.save(run);
    }
    if (run.rebuild) {
      beginRevision(run);
    }
    const entry = this.tasks.get(run.task), task = entry.task;
    run.reviewSupported = !!task.review;
    signal = AbortSignal.any([signal, entry.signal]);
    signal.throwIfAborted();
    if (!run.criteria) {
      run.stage = 'discover'; run.message = '正在调查项目、建立正确性检查与评价依据'; await this.save(run);
      const setup = path.join(run.root, 'setup-' + randomUUID());
      await snapshot(run.baselineDir, setup);
      await mkdir(path.join(setup, '.sla'), { recursive: true });
      const criteria = await this.invoke(run, parent, 'scout', setup, task.prepare.prompt(structuredClone(run)), task.prepare.schema, signal);
      if (!criteria.ready) throw new Error('尚未建立可靠判断依据：' + criteria.reason);
      if (typeof criteria.criterion !== 'string' || !criteria.criterion.trim()) throw new Error('扩展没有说明评价依据');
      if (changedFiles(run.sourceFiles, await inventory(setup)).length) throw new Error('调查阶段修改了项目源文件，未接受该评价依据。');
      run.evaluationDir = path.join(run.root, 'criteria-' + run.revision + '-' + randomUUID());
      run.evaluationFiles = await copyEvaluation(setup, run.evaluationDir);
      run.stage = 'baseline'; run.message = '正在实际运行基线检查'; await this.save(run);
      const measured = await this.evaluate(run, run.baselineDir, parent, signal, criteria);
      const baseline = measured.evaluation;
      await task.validateBaseline(structuredClone(baseline), structuredClone(criteria));
      signal.throwIfAborted();
      run.criteria = criteria; run.baseline = baseline;
      run.baselineArtifactId = measured.artifactId; run.baselineObservationId = measured.observationId;
      run.best = candidateFrom(measured, { dir: run.baselineDir, trial: 0, criteriaVersion: run.criteriaVersion });
      run.frontier = initialFrontier(task, run.best, criteria);
      await this.save(run);
    }
    await this.bindLegacyArtifacts(run);
    if (run.pendingReview) await finishReview(this, run, parent, signal, task);
    if (task.review && run.baselineReviewed !== run.revision) await reviewCandidate(this, run, parent, signal, task, 'baseline');
    await this.resumeEvaluations(run, parent, signal, task);
    await explore(run, signal, task, () => this.save(run), {
      plan: async () => {
        run.stage = 'plan'; run.message = '正在汇总各方向证据，规划下一轮实验'; await this.save(run);
        const advisoryDir = path.join(run.root, 'advice-' + randomUUID());
        const artifact = artifactById(run, run.best.artifactId);
        await verifyFileArtifact(artifact);
        const before = await snapshot(run.best.dir, advisoryDir);
        if (changedFiles(artifact.payload.files, before).length) throw new Error('规划副本与封存候选不一致');
        await verifyFileArtifact(artifact);
        const plan = await this.invoke(run, parent, 'advisor', advisoryDir, advisorPrompt(run, task), advisorSchema, signal);
        if (changedFiles(before, await inventory(advisoryDir)).length) throw new Error('规划阶段修改了候选，未接受计划');
        return plan;
      },
      trial: (epoch, assignment, direction) => this.trial(run, parent, signal, task, epoch, assignment, direction),
      review: () => reviewCandidate(this, run, parent, signal, task, 'candidate'),
      reviewed: () => reviewed(run, task),
    });
    // A failed new check can replace the winner. Review that replacement before
    // offering adoption; a bounded pass never silently accepts an unknown review.
    for (let i = 0; i < 3 && run.best.trial && !reviewed(run, task); i++) await reviewCandidate(this, run, parent, signal, task, 'candidate');
    if (run.best.trial && !reviewed(run, task)) throw new Error('审查连续发现候选问题；已保留证据，请继续探索或补充要求');
    signal.throwIfAborted();
    run.status = 'completed'; run.stage = 'result';
    run.reviewOnly = false;
    run.reviewSupported = !!task.review;
    run.message = run.stopReason || (run.best.trial ? '本轮探索结束，已保留通过检查的最佳候选。' : '本轮没有找到通过检查且更好的候选，保留原项目。');
  }
  async trial(run, parent, signal, task, epoch, assignment, direction) {
    const seed = direction.best ?? direction.seed;
    const trial = reserveAttempt(run, epoch, assignment, direction);
    const number = trial.number, dir = path.join(run.root, 'candidate-' + number);
    // Reserve identity and allowance before any side effect, including copying.
    trial.dir = dir;
    run.stage = 'experiment'; run.message = `第 ${epoch.number} 轮 · ${direction.id} · 第 ${number} 次尝试`; await this.save(run);
    let before, phase = 'snapshot';
    try {
      const seedArtifact = artifactById(run, seed.artifactId);
      await verifyFileArtifact(seedArtifact);
      before = await snapshot(seed.dir, dir);
      if (changedFiles(seedArtifact.payload.files, before).length) throw new Error('起点副本与封存父候选不一致');
      await verifyFileArtifact(seedArtifact);
      trial.startFiles = before;
      phase = 'worker';
      const report = await this.invoke(run, parent, 'worker', dir, workerPrompt(run, assignment, task, direction), undefined, signal, { attempt: trial });
      trial.report = report.summary;
      phase = 'evaluation';
      trial.artifactId = (await fileArtifact(run, dir, number, trial.parentArtifactId)).id;
      trial.pendingEvaluation = true; await this.save(run);
      await this.assessTrial(run, parent, signal, task, trial, direction);
    } catch (e) {
      trial.status = 'inconclusive'; trial.summary = String(e.message ?? e); trial.failurePhase = phase;
      (trial.failures ??= []).push({ phase, message: trial.summary, ...(e.evidence ? { evidence: e.evidence } : {}) });
      // A changed file is evidence of work, not an accepted or complete candidate.
      // Capture it even when invocation/evaluation failed; keep the original error.
      if (before) {
        try { trial.changes = changedFiles(before, await inventory(dir)); }
        catch (error) { trial.changeInspectionError = String(error.message ?? error); }
      }
      if (phase === 'worker' && e.quiescent === true && before && !trial.changeInspectionError) {
        trial.executionFailure = { message: String(e.message ?? e), quiescent: true };
        try {
          trial.artifactId = (await fileArtifact(run, dir, number, trial.parentArtifactId)).id;
          trial.pendingEvaluation = true;
          await this.save(run);
          if (!signal.aborted) await this.assessTrial(run, parent, signal, task, trial, direction);
        } catch (error) { trial.assessmentError = String(error.message ?? error); }
      }
      if (signal.aborted || phase === 'snapshot') throw e;
    }
  }
  async bindLegacyArtifacts(run) {
    run.baselineArtifactId ??= (await fileArtifact(run, run.baselineDir)).id;
    for (const candidate of [run.best, ...run.directions.filter(d => d.revision === run.revision).flatMap(d => [d.seed, d.best])].filter(Boolean)) {
      if (candidate.artifactId) continue;
      const trial = candidate.trial ? run.trials.find(t => t.number === candidate.trial) : null;
      const expected = trial?.files ?? (candidate.trial ? candidate.files : run.sourceFiles);
      if (!expected || changedFiles(expected, await inventory(candidate.dir)).length) throw new Error('历史候选缺少可核对的内容身份，请重新建立探索');
      candidate.artifactId = (await fileArtifact(run, candidate.dir, candidate.trial, trial?.parentArtifactId)).id;
      if (trial) trial.artifactId = candidate.artifactId;
    }
    if (!run.best.observationId && !run.pendingReview) {
      const candidates = [{ trial: 0, dir: run.baselineDir, files: run.sourceFiles, artifactId: run.baselineArtifactId },
        ...run.trials.filter(t => t.revision === run.revision && (t.eligibility?.retain ?? t.valid) && t.changes?.length)
          .map(t => ({ trial: t.number, dir: t.dir, files: t.files, direction: t.direction }))];
      if (run.best.trial && !candidates.some(c => c.trial === run.best.trial)) candidates.push({ ...run.best, files: run.best.files ?? run.trials.find(t => t.number === run.best.trial)?.files });
      if (candidates.some(c => !c.files)) throw new Error('历史候选缺少文件校验信息，无法迁移评价');
      // Historical values are retained, never relabeled as new observations.
      // Reuse the complete re-evaluation transaction before resuming search.
      run.pendingReview = { id: randomUUID(), kind: 'migration', revision: run.revision, criteriaVersion: run.criteriaVersion + 1,
        evaluationDir: run.evaluationDir, evaluationFiles: run.evaluationFiles, checks: run.checks, candidates, results: [] };
    }
    await this.save(run);
  }
  async assessTrial(run, parent, signal, task, trial, direction) {
    signal.throwIfAborted();
    if (trial.revision !== run.revision || trial.criteriaVersion !== run.criteriaVersion) throw new Error('待评价候选版本已过期');
    run.stage = 'evaluate'; run.message = '正在用固定依据检查候选 ' + trial.number; await this.save(run);
    const measured = await this.evaluate(run, trial.dir, parent, signal), result = measured.evaluation;
    const files = await inventory(trial.dir), changed = changedFiles(trial.startFiles, files);
    Object.assign(trial, { artifactId: measured.artifactId, observationId: measured.observationId,
      evaluation: result, valid: result.valid, ...(result.display !== undefined ? { display: result.display } : {}),
      ...(result.score !== undefined ? { score: result.score } : {}), evidence: result.evidence, summary: result.summary, changes: changed, files });
    const candidate = candidateFrom(measured, { dir: trial.dir, trial: trial.number, criteriaVersion: run.criteriaVersion });
    const choice = retain(run, task, trial, direction, candidate, changed.length > 0);
    if (choice.global) {
      candidate.diff = await candidateDiff(run.baselineDir, trial.dir);
      await writeFile(path.join(run.root, 'best.patch'), candidate.diff);
    }
    trial.pendingEvaluation = false; delete trial.assessmentError;
    await this.save(run);
  }
  async resumeEvaluations(run, parent, signal, task) {
    for (const trial of run.trials.filter(t => t.pendingEvaluation)) {
      if (trial.revision !== run.revision || trial.criteriaVersion !== run.criteriaVersion) {
        trial.pendingEvaluation = false; trial.assessmentStatus = 'superseded'; continue;
      }
      signal.throwIfAborted();
      const direction = run.directions.find(d => d.id === trial.direction && d.revision === run.revision);
      try { await this.assessTrial(run, parent, signal, task, trial, direction); }
      catch (error) {
        trial.status = 'inconclusive'; trial.assessmentError = String(error.message ?? error);
        await this.save(run); throw error;
      }
    }
  }
  async deliver(run, parent, signal) {
        if (!run.best || run.best.dir === run.baselineDir) throw new Error('尚无通过评价的改进可采用。');
        const entry = this.tasks.get(run.task);
        if (!reviewed(run, entry.task)) throw new Error('候选尚未完成当前版本的独立审查，请先检查候选。');
        const approvedFiles = await inventory(run.best.dir);
        if (entry.task.review && changedFiles(run.reviewedBest.files, approvedFiles).length) throw new Error('审查后候选文件已改变，未采用；请重新检查候选。');
        const { evaluation: eligible } = await this.evaluate(run, run.best.dir, parent, signal);
        signal.throwIfAborted();
        run.adoptionCheck = eligible; await this.save(run);
        if (!eligible.valid) throw new Error('采用前复验未通过：' + eligible.summary);
        if (!qualify(entry.task, eligible, run.criteria).deliver) throw new Error('候选尚不满足交付资格');
        if (compare(entry.task, eligible, run.baseline, run.criteria) !== 'better') throw new Error('采用前复验未显示优于基线，未写回。结果已保存在证据目录。');
        run.adoptionPending = true; await this.save(run);
        try {
          entry.signal.throwIfAborted();
          run.adoptedFiles = await adopt(run, async () => {
            entry.signal.throwIfAborted(); signal.throwIfAborted();
            await this.adapter.authorize(parent);
          }, approvedFiles);
        }
        catch (error) {
          run.adoptionPending = false;
          await recoverAdoption(run);
          await this.save(run);
          throw error;
        }
        run.adopted = true;
        run.adoptionPending = false;
        run.message = '已采用并校验文件内容；原始快照保留在证据目录。';
        await this.save(run);
  }
}
