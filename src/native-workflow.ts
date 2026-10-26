import { criteriaSchema } from './data.js';
import type { ArtifactInput, Binding, Criteria, Direction, Run, Trial } from './data.js';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ExplorationRuntime } from './runtime.js';
import type { Invocation, WorkflowContext } from './contracts.js';
import { required } from './errors.js';
import { assertBound, assertPrepared } from './invariants.js';
import { message } from './errors.js';
import { randomUUID } from 'node:crypto';
import { artifactById, beginRevision, candidateFrom, jsonValue, observe, publishCriteria, reserveAttempt, sealArtifact } from './kernel.js';
import { validateEvaluation, compare, qualify } from './workflow-registry.js';
import { explore, retain, initialFrontier, rerank } from './sla-strategy.js';
import { advisorEvidence, feedback } from './research-state.js';

// A workflow receives read snapshots and commands, never the mutable run or
// the Host engine. Registered code is still trusted DSH plugin code.
export class NativeWorkflow {
  constructor(readonly engine: ExplorationRuntime, readonly binding: Binding) {}
  entry() { return this.engine.tasks.native(this.binding); }
  async evaluate(run: Run, artifactId: string, parent: Agent, signal: AbortSignal, criteria: Criteria = required(run.criteria, '评价依据'), version = run.criteriaVersion) {
    const entry = this.entry(), definition = entry.task;
    signal = AbortSignal.any([signal, entry.signal]);
    signal.throwIfAborted(); await this.engine.adapter.authorize(parent);
    const artifact = artifactById(run, artifactId);
    await definition.artifacts.verify(structuredClone(artifact));
    const input = structuredClone(artifact);
    const result = validateEvaluation(await definition.evaluate({ artifact: input, criteria: structuredClone(criteria), signal,
      execute: command => this.engine.adapter.execute({ parent, cwd: run.cwd, command, signal }) }));
    signal.throwIfAborted(); await this.engine.adapter.authorize(parent);
    if (JSON.stringify(input) !== JSON.stringify(artifact)) throw new Error('评价修改了输入制品，未接受结果');
    await definition.artifacts.verify(artifactById(run, artifactId));
    const observation = observe(run, artifactId, result, { criteriaVersion: version });
    await this.engine.save(run);
    return { evaluation: result, artifactId, observationId: observation.id };
  }
  context(run: Run, parent: Agent, signal: AbortSignal): Readonly<WorkflowContext> {
    const definition = this.entry().task;
    const view = () => structuredClone(run);
    const capture = async (input: ArtifactInput, trial = 0, parentId: string | null = null) => {
      signal.throwIfAborted();
      await definition.artifacts.verify(structuredClone(input));
      const artifact = sealArtifact(run, { ...input, trial, parentId });
      await this.engine.save(run);
      return artifact;
    };
    const context: WorkflowContext = {
      state: view,
      signal,
      status: async (stage, message) => {
        signal.throwIfAborted();
        if (typeof stage !== 'string' || typeof message !== 'string') throw new Error('工作流状态格式无效');
        run.stage = stage; run.message = message; await this.engine.save(run);
      },
      saveState: async value => { signal.throwIfAborted(); run.workflowState = jsonValue(value); await this.engine.save(run); },
      evidence: () => advisorEvidence(run, definition.projectEvidence),
      artifact: id => artifactById(run, id),
      invoke: spec => this.engine.invoke(run, parent, spec.role, spec.cwd ?? run.cwd, spec.prompt, spec.schema, signal, { blueprint: spec.blueprint }),
      initialize: async ({ criteria, artifact: input }) => {
        signal.throwIfAborted();
        if (run.criteria) return view();
        if (!criteria?.ready || typeof criteria.criterion !== 'string' || !criteria.criterion.trim()) throw new Error('工作流尚未建立判断依据');
        const artifact = await capture(input);
        const measured = await this.evaluate(run, artifact.id, parent, signal, criteria), baseline = measured.evaluation;
        await definition.validateBaseline(structuredClone(baseline), structuredClone(criteria));
        signal.throwIfAborted();
        run.criteria = criteriaSchema.parse(jsonValue(criteria)); run.baseline = baseline;
        run.baselineArtifactId = artifact.id;
        run.baselineObservationId = measured.observationId;
        run.best = candidateFrom(measured, { trial: 0, criteriaVersion: run.criteriaVersion });
        run.frontier = initialFrontier(definition, run.best, criteria);
        await this.engine.save(run); return view();
      },
      observe: async artifactId => {
        if (!run.criteria) throw new Error('请先建立评价依据');
        return this.evaluate(run, artifactId, parent, signal);
      },
      reviseCriteria: criteria => this.reviseCriteria(run, parent, signal, criteria),
      search: async ({ plan, produce, afterTrial }) => {
        if (!run.criteria || run.pendingReview) throw new Error('评价尚未就绪');
        await this.resumeEvaluations(run, parent, signal);
        await explore(run, signal, definition, () => this.engine.save(run), {
          plan: () => plan({ state: view(), evidence: context.evidence() }),
          trial: async (epoch, assignment, lane) => {
            const trial = reserveAttempt(run, epoch, assignment, lane);
            await this.engine.save(run);
            try {
              const seed = lane.best ?? lane.seed;
              trial.failurePhase = 'worker';
              const invoke = (spec: Invocation) => this.engine.invoke(run, parent, spec.role, spec.cwd ?? run.cwd, spec.prompt, spec.schema, signal, { attempt: trial, blueprint: spec.blueprint });
              const input = await produce({ assignment: structuredClone(assignment), seed: artifactById(run, seed.artifactId),
                feedback: feedback(run.trials.filter(t => t.direction === lane.id && t.number !== trial.number && t.revision === run.revision).at(-1), run, definition.projectEvidence), invoke, signal });
              // Persist artifact identity and pending evaluation together. A
              // restart must not consume another attempt to recover this one.
              await definition.artifacts.verify(structuredClone(input));
              signal.throwIfAborted();
              const artifact = sealArtifact(run, { ...input, trial: trial.number, parentId: seed.artifactId });
              trial.artifactId = artifact.id; trial.pendingEvaluation = true; trial.failurePhase = 'evaluation';
              await this.engine.save(run);
              await this.assessTrial(run, parent, signal, trial, lane);
            } catch (error) {
              trial.status = 'inconclusive'; trial.summary = message(error);
              (trial.failures ??= []).push({ phase: trial.failurePhase, message: trial.summary });
              if (signal.aborted || trial.pendingEvaluation) throw error;
            } finally { await this.engine.save(run); }
            await afterTrial?.({ trial: structuredClone(trial), state: view() });
          },
          review: async () => {}, reviewed: () => !run.pendingReview,
        });
        return view();
      },
    };
    return Object.freeze(context);
  }
  async assessTrial(run: Run, parent: Agent, signal: AbortSignal, trial: Trial, lane: Direction | undefined) {
    signal.throwIfAborted();
    if (trial.revision !== run.revision || trial.criteriaVersion !== run.criteriaVersion) throw new Error('待评价候选版本已过期');
    if (!lane) throw new Error('待评价候选的分支不存在');
    const measured = await this.evaluate(run, required(trial.artifactId, '尝试制品'), parent, signal), result = measured.evaluation;
    Object.assign(trial, { evaluation: result, valid: result.valid, summary: result.summary, display: result.display, observationId: measured.observationId });
    const candidate = candidateFrom(measured, { trial: trial.number, criteriaVersion: run.criteriaVersion });
    retain(run, this.entry().task, trial, lane, candidate, artifactById(run, required(trial.artifactId, '尝试制品')).digest !== artifactById(run, trial.parentArtifactId).digest);
    trial.pendingEvaluation = false; delete trial.failurePhase; delete trial.assessmentError;
    await this.engine.save(run);
  }
  async resumeEvaluations(run: Run, parent: Agent, signal: AbortSignal) {
    for (const trial of run.trials.filter(t => t.pendingEvaluation)) {
      if (trial.revision !== run.revision || trial.criteriaVersion !== run.criteriaVersion) {
        trial.pendingEvaluation = false; trial.assessmentStatus = 'superseded'; continue;
      }
      try { await this.assessTrial(run, parent, signal, trial, run.directions.find(d => d.id === trial.direction && d.revision === run.revision)); }
      catch (error) {
        trial.status = 'inconclusive'; trial.assessmentError = message(error);
        await this.engine.save(run); throw error;
      }
    }
  }
  async execute(run: Run, parent: Agent, signal: AbortSignal) {
    assertBound(run);
    const entry = this.entry();
    signal = AbortSignal.any([signal, entry.signal]); signal.throwIfAborted();
    run.status = 'running';
    if (run.rebuild) { beginRevision(run); run.workflowState = null; run.baselineArtifactId = null; }
    run.workflow = { kind: 'native', id: run.task.id, version: run.task.version };
    await this.engine.save(run);
    if (run.pendingReview) {
      if (run.pendingReview.kind !== 'workflow') throw new Error('评价升级工作流类型不一致');
      await this.reviseCriteria(run, parent, signal, run.pendingReview.criteria);
    }
    await entry.task.run(this.context(run, parent, signal));
    signal.throwIfAborted();
    if (!run.criteria) throw new Error('工作流没有建立评价依据');
    run.status = 'completed'; run.stage = 'result'; run.reviewOnly = false;
    run.message = run.stopReason || (required(run.best, '候选').trial ? '本轮探索结束，候选与依据已保留。' : '本轮探索结束，保留初始结果。');
  }
  async reviseCriteria(run: Run, parent: Agent, signal: AbortSignal, criteria: Criteria) {
    assertPrepared(run);
    const definition = this.entry().task;
    criteria = criteriaSchema.parse(criteria);
    if (!run.criteria) throw new Error('尚无可升级的评价');
    if (!run.pendingReview && JSON.stringify(jsonValue(criteria)) === JSON.stringify(run.criteria)) return structuredClone(run);
    if (!run.pendingReview) {
      if (!criteria?.ready || typeof criteria.criterion !== 'string' || !criteria.criterion.trim()) throw new Error('新版评价依据格式无效');
      run.pendingReview = { id: randomUUID(), kind: 'workflow', revision: run.revision, criteriaVersion: run.criteriaVersion + 1,
        criteria: criteriaSchema.parse(jsonValue(criteria)), candidates: [...new Set([run.baselineArtifactId, ...run.trials.filter(t => t.revision === run.revision && t.artifactId).map(t => required(t.artifactId, '尝试制品'))])], results: [] };
      await this.engine.save(run);
    }
    const pending = required(run.pendingReview, '评价升级');
    if (pending.kind !== 'workflow' || pending.revision !== run.revision) throw new Error('评价升级身份不一致');
    for (const artifactId of pending.candidates) {
      signal.throwIfAborted();
      if (pending.results.some(r => r.artifactId === artifactId)) continue;
      const measured = await this.evaluate(run, artifactId, parent, signal, pending.criteria, pending.criteriaVersion);
      if (artifactId === run.baselineArtifactId) await definition.validateBaseline(measured.evaluation, structuredClone(pending.criteria));
      pending.results.push(measured); await this.engine.save(run);
    }
    signal.throwIfAborted();
    const base = required(pending.results.find(r => r.artifactId === run.baselineArtifactId), '基线观测');
    const baseline = candidateFrom(base, { trial: 0, criteriaVersion: pending.criteriaVersion });
    const entries = pending.results.filter(r => r.artifactId !== run.baselineArtifactId).map(result => {
      const artifact = artifactById(run, result.artifactId), trial = required(run.trials.find(t => t.number === artifact.trial), '尝试');
      const candidate = candidateFrom(result, { trial: trial.number, criteriaVersion: pending.criteriaVersion });
      return { candidate, lane: trial.direction };
    });
    publishCriteria(run, pending, { baseline: base, ...rerank(definition, pending.criteria, baseline, entries), criteria: pending.criteria });
    await this.engine.save(run);
    return structuredClone(run);
  }
  async deliver(run: Run, parent: Agent, signal: AbortSignal) {
    assertPrepared(run);
    const entry = this.entry(), definition = entry.task;
    signal = AbortSignal.any([signal, entry.signal]);
    if (run.pendingReview || !run.best?.trial) throw new Error('尚无完成当前评价的改进可交付');
    if (!definition.deliver) throw new Error('工作流没有提供交付能力');
    const { evaluation } = await this.evaluate(run, run.best.artifactId, parent, signal);
    run.adoptionCheck = evaluation; await this.engine.save(run);
    if (!qualify(definition, evaluation, run.criteria).deliver || compare(definition, evaluation, run.baseline, run.criteria) !== 'better') throw new Error('采用前复验未满足交付资格');
    signal.throwIfAborted();
    run.adoptionPending = true; await this.engine.save(run);
    try {
      const receipt = await definition.deliver({ artifact: artifactById(run, run.best.artifactId), evaluation: structuredClone(evaluation),
        state: structuredClone(run), signal, authorize: async () => { signal.throwIfAborted(); await this.engine.adapter.authorize(parent); } });
      signal.throwIfAborted();
      run.delivery = jsonValue(receipt); run.adopted = true; run.adoptionPending = false;
      run.message = '已交付并保留候选与评价依据。'; await this.engine.save(run);
    } catch (error) {
      run.deliveryError = message(error);
      run.message = '交付中断：' + run.deliveryError;
      await this.engine.save(run);
      try { await this.recover(run); }
      catch (recoveryError) { run.message += '；核对失败：' + message(recoveryError); }
      await this.engine.save(run);
      if (!run.adopted) throw error;
    }
  }
  async recover(run: Run) {
    if (!run.adoptionPending) return;
    const definition = this.entry().task;
    const result = await definition.recoverDelivery?.(structuredClone(run));
    if (result?.status === 'delivered') {
      run.delivery = jsonValue(result.receipt); run.adopted = true; run.adoptionPending = false;
      run.message = '已核对交付内容，候选与评价依据保留。';
    } else if (result?.status === 'absent') {
      run.adoptionPending = false; run.adopted = false;
      run.message = '已确认没有交付副作用，可以重新采用。' + (run.deliveryError ? '上次失败：' + run.deliveryError : '');
    } else run.message = '交付曾被中断，需由原工作流核对副作用后恢复。' + (result?.status === 'unknown' ? result.reason : run.deliveryError ?? '');
  }
}
