import { criteriaSchema } from './data.js';
import type { Assignment, Criteria, Direction, Epoch, FileInventory, Run, Trial } from './data.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ExplorationRuntime } from './runtime.js';
import type { CodeDefinition, CommandResult, EvaluationContext, Evaluation } from './contracts.js';
import { required, isRecord, errorFact } from './errors.js';
import { assertBound, assertCode, assertPrepared, assertFileCandidate, assertFileTrial } from './invariants.js';
import { filePayload } from './file-artifacts.js';
import { message } from './errors.js';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { inventory, snapshot, changedFiles, copyEvaluation, verifyEvaluation, adopt, recoverAdoption, candidateDiff } from './workspace.js';
import { advisorSchema, advisorPrompt, workerPrompt } from './prompts.js';
import { compare, qualify, validateEvaluation } from './workflow-registry.js';
import { reviewed } from './research-state.js';
import { reviewCandidate, finishReview } from './review.js';
import { explore, retain, initialFrontier } from './sla-strategy.js';
import { artifactById, beginRevision, candidateFrom, observe, reserveAttempt } from './kernel.js';
import { fileArtifact, verifyFileArtifact } from './file-artifacts.js';

// File-project workflow. The engine owns lifetime and durable writes; this
// composition owns Scout, preserved-behavior review and workspace delivery.
export class CodeWorkflow {
  constructor(readonly engine: ExplorationRuntime) {}
  get adapter() { return this.engine.adapter; }
  get tasks() { return this.engine.tasks; }
  save(run: Run) { return this.engine.save(run); }
  invoke(...args: Parameters<ExplorationRuntime['invoke']>) { return this.engine.invoke(...args); }
  recover(run: Run) { return recoverAdoption(run); }
  async evaluate(run: Run, candidate: string, parent: Agent, signal: AbortSignal, criteria: Criteria = required(run.criteria, '评价依据'), spec: Pick<Run, 'evaluationDir' | 'evaluationFiles' | 'checks' | 'criteriaVersion'> = run) {
    assertBound(run);
    await this.adapter.authorize(parent);
    const entry = this.tasks.code(run.task);
    signal = AbortSignal.any([signal, entry.signal]);
    signal.throwIfAborted();
    const trial = run.trials.find(t => t.dir === candidate && t.revision === run.revision);
    const artifact = await fileArtifact(run, candidate, trial?.number ?? 0, trial?.parentArtifactId);
    const dir = path.join(run.root, 'checks', randomUUID());
    const candidateFiles = await snapshot(candidate, dir);
    if (changedFiles(filePayload(artifact).files, candidateFiles).length) throw new Error('评价副本与封存候选不一致');
    const evaluationFiles = await copyEvaluation(required(spec.evaluationDir, '评价目录'), dir);
    if (spec.evaluationFiles && changedFiles(spec.evaluationFiles, evaluationFiles).length) throw new Error('固定评价依据校验失败');
    const evidence = path.join(run.root, 'evaluation-output-' + randomUUID() + '.json');
    const outputs: Array<{ command: string; result: CommandResult }> = [];
    try {
      const context: EvaluationContext = {
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
      const result: Evaluation & { evidence: string } = { ...parsed, evidence };
      const observation = observe(run, artifact.id, result, { criteriaVersion: spec.criteriaVersion, conditions: { evaluationFiles } });
      return { evaluation: result, artifactId: artifact.id, observationId: observation.id };
    } catch (error) {
      await writeFile(evidence, JSON.stringify({ task: run.task, outputs, error: message(error) }, null, 2));
      if (error instanceof Error) Object.assign(error, { evidence });
      throw error;
    }
  }
  async execute(run: Run, parent: Agent, signal: AbortSignal) {
    assertBound(run);
    run.status = 'running';
    run.workflow = { kind: 'code', id: run.task.id, version: run.task.version };
    if (!run.sourceFiles) {
      run.baselineDir = path.join(run.root, 'initial-' + randomUUID());
      run.sourceFiles = await snapshot(run.cwd, run.baselineDir);
      if (!Object.keys(run.sourceFiles).length) throw new Error('项目中没有可探索的源文件。');
      await this.save(run);
    }
    if (run.rebuild) {
      beginRevision(run);
    }
    const entry = this.tasks.code(run.task), task = entry.task;
    run.reviewSupported = !!task.review;
    signal = AbortSignal.any([signal, entry.signal]);
    signal.throwIfAborted();
    if (!run.criteria) {
      run.stage = 'discover'; run.message = '正在调查项目、建立正确性检查与评价依据'; await this.save(run);
      const setup = path.join(run.root, 'setup-' + randomUUID());
      await snapshot(required(run.baselineDir, '原始目录'), setup);
      await mkdir(path.join(setup, '.sla'), { recursive: true });
      const response = await this.invoke(run, parent, 'scout', setup, task.prepare.prompt(structuredClone(run)), task.prepare.schema, signal);
      if (!isRecord(response)) throw new Error('评价依据格式无效');
      if (!response.ready) throw new Error('尚未建立可靠判断依据：' + response.reason);
      const criteria = criteriaSchema.parse(response);
      if (!criteria.ready) throw new Error('尚未建立可靠判断依据：' + criteria.reason);
      if (typeof criteria.criterion !== 'string' || !criteria.criterion.trim()) throw new Error('扩展没有说明评价依据');
      if (changedFiles(required(run.sourceFiles, '原始清单'), await inventory(setup)).length) throw new Error('调查阶段修改了项目源文件，未接受该评价依据。');
      run.evaluationDir = path.join(run.root, 'criteria-' + run.revision + '-' + randomUUID());
      run.evaluationFiles = await copyEvaluation(setup, run.evaluationDir);
      run.stage = 'baseline'; run.message = '正在实际运行基线检查'; await this.save(run);
      const measured = await this.evaluate(run, required(run.baselineDir, '原始目录'), parent, signal, criteria);
      const baseline = measured.evaluation;
      await task.validateBaseline(structuredClone(baseline), structuredClone(criteria));
      signal.throwIfAborted();
      run.criteria = criteria; run.baseline = baseline;
      run.baselineArtifactId = measured.artifactId; run.baselineObservationId = measured.observationId;
      run.best = candidateFrom(measured, { dir: run.baselineDir, trial: 0, criteriaVersion: run.criteriaVersion });
      run.frontier = initialFrontier(task, run.best, criteria);
      await this.save(run);
    }
    assertPrepared(run); assertCode(run);
    if (run.pendingReview) await finishReview(this, run, parent, signal, task);
    if (task.review && run.baselineReviewed !== run.revision) await reviewCandidate(this, run, parent, signal, task, 'baseline');
    await this.resumeEvaluations(run, parent, signal, task);
    await explore(run, signal, task, () => this.save(run), {
      plan: async () => {
        run.stage = 'plan'; run.message = '正在汇总各方向证据，规划下一轮实验'; await this.save(run);
        const advisoryDir = path.join(run.root, 'advice-' + randomUUID());
        const artifact = artifactById(run, run.best.artifactId);
        await verifyFileArtifact(artifact);
        const before = await snapshot(required(run.best.dir, '候选目录'), advisoryDir);
        if (changedFiles(filePayload(artifact).files, before).length) throw new Error('规划副本与封存候选不一致');
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
  async trial(run: Run, parent: Agent, signal: AbortSignal, task: CodeDefinition, epoch: Epoch, assignment: Assignment, direction: Direction) {
    assertPrepared(run); assertCode(run);
    const seed = direction.best ?? direction.seed;
    assertFileCandidate(seed);
    const trial = reserveAttempt(run, epoch, assignment, direction);
    const number = trial.number, dir = path.join(run.root, 'candidate-' + number);
    // Reserve identity and allowance before any side effect, including copying.
    trial.dir = dir;
    run.stage = 'experiment'; run.message = `第 ${epoch.number} 轮 · ${direction.id} · 第 ${number} 次尝试`; await this.save(run);
    let before: FileInventory | undefined, phase = 'snapshot';
    try {
      const seedArtifact = artifactById(run, seed.artifactId);
      await verifyFileArtifact(seedArtifact);
      before = await snapshot(seed.dir, dir);
      if (changedFiles(filePayload(seedArtifact).files, before).length) throw new Error('起点副本与封存父候选不一致');
      await verifyFileArtifact(seedArtifact);
      trial.startFiles = before;
      phase = 'worker';
      const report = await this.invoke(run, parent, 'worker', dir, workerPrompt(run, assignment, task, direction), undefined, signal, { attempt: trial });
      if (!isRecord(report) || typeof report.summary !== 'string') throw new Error('执行者报告缺少 summary');
      trial.report = report.summary;
      phase = 'evaluation';
      trial.artifactId = (await fileArtifact(run, dir, number, trial.parentArtifactId)).id;
      trial.pendingEvaluation = true; await this.save(run);
      await this.assessTrial(run, parent, signal, task, trial, direction);
    } catch (e) {
      trial.status = 'inconclusive'; trial.summary = message(e); trial.failurePhase = phase;
      (trial.failures ??= []).push({ phase, message: trial.summary, ...(typeof errorFact(e, 'evidence') === 'string' ? { evidence: String(errorFact(e, 'evidence')) } : {}) });
      // A changed file is evidence of work, not an accepted or complete candidate.
      // Capture it even when invocation/evaluation failed; keep the original error.
      if (before) {
        try { trial.changes = changedFiles(before, await inventory(dir)); }
        catch (error) { trial.changeInspectionError = message(error); }
      }
      if (phase === 'worker' && errorFact(e, 'quiescent') === true && before && !trial.changeInspectionError) {
        trial.executionFailure = { message: message(e), quiescent: true };
        try {
          trial.artifactId = (await fileArtifact(run, dir, number, trial.parentArtifactId)).id;
          trial.pendingEvaluation = true;
          await this.save(run);
          if (!signal.aborted) await this.assessTrial(run, parent, signal, task, trial, direction);
        } catch (error) { trial.assessmentError = message(error); }
      }
      if (signal.aborted || phase === 'snapshot') throw e;
    }
  }
  async assessTrial(run: Run, parent: Agent, signal: AbortSignal, task: CodeDefinition, trial: Trial, direction: Direction | undefined) {
    assertCode(run); assertFileTrial(trial);
    if (!direction) throw new Error('待评价候选的分支不存在');
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
  async resumeEvaluations(run: Run, parent: Agent, signal: AbortSignal, task: CodeDefinition) {
    for (const trial of run.trials.filter(t => t.pendingEvaluation)) {
      if (trial.revision !== run.revision || trial.criteriaVersion !== run.criteriaVersion) {
        trial.pendingEvaluation = false; trial.assessmentStatus = 'superseded'; continue;
      }
      signal.throwIfAborted();
      const direction = run.directions.find(d => d.id === trial.direction && d.revision === run.revision);
      try { await this.assessTrial(run, parent, signal, task, trial, direction); }
      catch (error) {
        trial.status = 'inconclusive'; trial.assessmentError = message(error);
        await this.save(run); throw error;
      }
    }
  }
  async deliver(run: Run, parent: Agent, signal: AbortSignal) {
        assertPrepared(run); assertCode(run); assertFileCandidate(run.best);
        if (!run.best || run.best.dir === run.baselineDir) throw new Error('尚无通过评价的改进可采用。');
        const entry = this.tasks.code(run.task);
        if (!reviewed(run, entry.task)) throw new Error('候选尚未完成当前版本的独立审查，请先检查候选。');
        const approvedFiles = await inventory(run.best.dir);
        if (entry.task.review && changedFiles(required(run.reviewedBest, '审查结果').files, approvedFiles).length) throw new Error('审查后候选文件已改变，未采用；请重新检查候选。');
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
