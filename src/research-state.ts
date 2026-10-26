import { planSchema, settingsSchema, runSchema } from './data.js';
import type { Candidate, Evaluation, Run, Settings, Trial } from './data.js';
import type { CodeWorkflowDefinition, EvaluationPolicy } from './contracts.js';
import { isRecord, required } from './errors.js';
import { initializeKernel, jsonValue } from './kernel.js';

export const defaults = Object.freeze({ maxTrials: 8, maxMinutes: 20, directions: 2, localTrials: 2, maxStepsPerCall: 24, maxMinutesPerCall: 5 });
export function settings(value: unknown = {}, base: Settings = defaults): Settings {
  if (!isRecord(value)) throw new Error('探索设置必须为对象');
  const limits: Record<string, readonly [number, number]> = { maxTrials: [1, 100], maxMinutes: [1, 240], directions: [1, 4], localTrials: [1, 5], maxStepsPerCall: [4, 200], maxMinutesPerCall: [1, 60] };
  for (const key of Object.keys(value)) if (!limits[key]) throw new Error('未知探索设置：' + key);
  const result: Record<string, unknown> = { ...base, ...value };
  for (const [key, [min, max]] of Object.entries(limits)) {
    const number = result[key];
    if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) throw new Error(`${key} 必须是 ${min}–${max} 的整数`);
  }
  return settingsSchema.parse(result);
}

type Initialized = 'formatVersion' | 'settings' | 'tranche' | 'directions' | 'epochs' | 'assessments' | 'reviews' | 'checks' | 'criteriaVersion' | 'artifacts' | 'observations' | 'decisions' | 'frontier';
export type ResearchSeed = Omit<Run, Initialized> & Partial<Pick<Run, Initialized>>;
export function initializeResearch(run: ResearchSeed, config: Settings = defaults): asserts run is Run {
  run.artifacts ??= []; run.observations ??= []; run.decisions ??= []; run.frontier ??= [];
  Object.assign(run, { formatVersion: 1, settings: { ...config }, tranche: { attempt: 0, elapsedMs: 0 },
    directions: [], epochs: [], assessments: [], reviews: [], checks: [], criteriaVersion: run.revision });
}

export function validateRun(run: unknown): asserts run is Run {
  if (!isRecord(run) || run.formatVersion !== 1 || !run.id || !run.sessionId || !run.root || !Number.isInteger(run.revision)) throw new Error('探索记录格式无效');
  settings(run.settings);
  if (!run.tranche || !run.settings || !Number.isInteger(run.criteriaVersion)) throw new Error('探索记录状态不完整');
  for (const key of ['trials', 'invocations', 'artifacts', 'observations', 'decisions', 'frontier', 'directions', 'epochs', 'assessments', 'reviews', 'checks']) {
    if (!Array.isArray(run[key])) throw new Error('探索记录缺少 ' + key);
  }
  runSchema.parse(run);
}

const short = (text: unknown, n = 500) => String(text ?? '').slice(0, n);
// Main-chat controls need current state, not every snapshot hash and old output.
// The Web service and persisted report continue to expose the complete record.
export function controlSummary(run: Run | null, now = Date.now()) {
  if (!run) return null;
  const result = (value: Evaluation | Candidate | null | undefined) => value ? { trial: value.trial, valid: value.valid, score: value.score,
    display: value.display === undefined ? undefined : short(value.display, 160), summary: short(value.summary, 800) } : null;
  const directions = (run.directions ?? []).filter(d => d.revision === run.revision);
  const review = run.reviews?.at(-1);
  return { id: run.id, goal: short(run.goal, 1200), status: run.status, stage: run.stage,
    message: short(run.message, 1500), adopted: !!run.adopted, rebuild: !!run.rebuild,
    revision: run.revision, criteriaVersion: run.criteriaVersion, task: run.task,
    settings: run.settings, attempts: run.attempts, limit: run.limit,
    elapsedMs: (run.elapsedMs ?? 0) + (run.activeSince ? Math.max(0, now - run.activeSince) : 0), timeLimitMs: run.timeLimitMs,
    baseline: result(run.baseline), best: result(run.best),
    epochs: run.epochs?.length ?? 0, directionCount: directions.length,
    directions: directions.slice(-8).map(d => ({ id: d.id, best: result(d.best) })),
    reviewSupported: !!run.reviewSupported, reviewPending: !!run.pendingReview,
    latestReview: review ? { phase: review.phase, status: review.status, summary: short(review.summary, 1000), error: short(review.error, 1000) } : null,
    evidenceDirectory: run.root };
}

function currentTrial(trial: Trial, run?: Run): Trial {
  const assessment = run?.assessments?.filter(a => a.trial === trial.number && a.revision === run.revision && a.criteriaVersion === run.criteriaVersion).at(-1);
  if (assessment?.evaluation) return { ...trial, historicalStatus: trial.status, criteriaVersion: assessment.criteriaVersion, evaluation: assessment.evaluation,
    valid: assessment.evaluation.valid, status: assessment.evaluation.valid ? 'rechecked-valid' : 'invalid', summary: assessment.evaluation.summary, evidence: assessment.evaluation.evidence };
  if (run && trial.criteriaVersion !== run.criteriaVersion) return { ...trial, historicalStatus: trial.status, status: 'not-rechecked', valid: undefined };
  return trial;
}
export function feedback(trial: Trial | undefined, run?: Run, project?: EvaluationPolicy['projectEvidence']) {
  if (!trial) return null;
  trial = currentTrial(trial, run);
  const projected = project && trial.evaluation ? project(structuredClone(trial.evaluation)) : undefined;
  const detail = projected === undefined ? undefined : jsonValue(projected);
  if (detail !== undefined && JSON.stringify(detail).length > 12000) throw new Error('领域证据摘要过大');
  return { trial: trial.number, parentTrial: trial.parentTrial, epoch: trial.epoch, criteriaVersion: trial.criteriaVersion,
    status: trial.status, historicalStatus: trial.historicalStatus, hypothesis: short(trial.hypothesis), valid: trial.valid,
    result: short(trial.evaluation?.display ?? trial.summary), diagnostic: short(trial.summary),
    failurePhase: trial.failurePhase, workerReport: trial.report === undefined ? undefined : short(trial.report, 1200),
    executionFailure: trial.executionFailure, assessmentStatus: trial.assessmentStatus,
    changedFiles: trial.changes?.slice(0, 20), changedFileCount: trial.changes?.length,
    changeInspectionError: trial.changeInspectionError === undefined ? undefined : short(trial.changeInspectionError),
    evidence: trial.evidence ?? null, ...(detail === undefined ? {} : { detail: structuredClone(detail) }) };
}

function candidateEvidence(candidate: Candidate | null | undefined) {
  if (!candidate) return null;
  const result = candidate.evaluation ?? candidate;
  return { trial: candidate.trial, valid: result.valid, result: short(result.display ?? result.summary), criteriaVersion: candidate.criteriaVersion };
}

// Counts include the complete current-goal record; detail is selected by outcome,
// not by one chronological tail that would erase an inactive direction.
export function advisorEvidence(run: Run, project?: EvaluationPolicy['projectEvidence']) {
  const trials = run.trials.filter(t => t.revision === run.revision).map(t => currentTrial(t, run));
  const groups = new Map<string, { direction: string; regime?: string; hypothesis?: string; localBest?: ReturnType<typeof candidateEvidence>; startCandidate?: ReturnType<typeof candidateEvidence>; trials: Trial[] }>(run.directions.filter(d => d.revision === run.revision).map(d => [d.id, { direction: d.id, regime: d.regime ?? d.id, hypothesis: short(d.hypothesis), localBest: candidateEvidence(d.best), startCandidate: candidateEvidence(d.best ?? d.seed), trials: [] }]));
  for (const trial of trials) {
    const id = trial.direction;
    if (!groups.has(id)) groups.set(id, { direction: id, trials: [] });
    required(groups.get(id), '方向证据').trials.push(trial);
  }
  return [...groups.values()].map(({ trials: history, ...group }) => {
    const counts: Record<string, number> = {};
    for (const t of history) counts[t.status] = (counts[t.status] ?? 0) + 1;
    const selected = new Map<number, NonNullable<ReturnType<typeof feedback>>>();
    for (const status of ['kept', 'local-kept', 'no-improvement', 'invalid', 'inconclusive', 'rechecked-valid', 'not-rechecked']) {
      const matches = history.filter(t => t.status === status);
      for (const t of [matches[0], ...matches.slice(-2)]) {
        if (t) selected.set(t.number, required(feedback(t, undefined, project), '尝试反馈'));
      }
    }
    return { ...group, counts, evidence: [...selected.values()].sort((a, b) => a.trial - b.trial) };
  });
}

export function validatePlan(input: unknown, run: Pick<Run, 'settings' | 'directions' | 'revision' | 'trials'>) {
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) throw new Error('规划结果格式无效');
  const plan = parsed.data;
  if (typeof plan?.stop !== 'boolean' || typeof plan.reason !== 'string' || !Array.isArray(plan.assignments)) throw new Error('规划结果格式无效');
  if (plan.stop) {
    if (!plan.reason.trim() || plan.assignments.length) throw new Error('停止规划必须说明理由且不同时分配任务');
    return plan;
  }
  if (!plan.assignments.length || plan.assignments.length > run.settings.directions) throw new Error('规划方向数量超出配置');
  const ids = new Set();
  for (const a of plan.assignments) {
    const lane = a.lane ?? a.direction;
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(a.direction ?? '') || !/^[a-z][a-z0-9-]{0,63}$/.test(lane ?? '') || ids.has(lane)) throw new Error('方向或分支 id 无效或重复');
    const existing = run.directions?.find(d => d.id === lane && d.revision === run.revision);
    if (existing && (existing.regime ?? existing.id) !== a.direction) throw new Error('已有分支不能更换方向，请创建新分支');
    ids.add(lane);
    for (const key of ['hypothesis', 'instructions'] as const) if (typeof a[key] !== 'string' || !a[key].trim()) throw new Error('方向缺少 ' + key);
    if (!Array.isArray(a.evidenceTrials) || a.evidenceTrials.some(n => !Number.isInteger(n) || !run.trials.some(t => t.number === n && t.revision === run.revision))) throw new Error('规划引用了不存在的实验');
  }
  return plan;
}

export function reviewed(run: Run, task: Pick<CodeWorkflowDefinition, 'review'>) {
  const approval = run.reviewedBest;
  return !task.review || (approval?.trial === run.best?.trial && approval?.criteriaVersion === run.criteriaVersion && approval?.revision === run.revision && approval?.task?.id === required(run.task, '工作流').id && approval?.task?.version === required(run.task, '工作流').version && !run.pendingReview);
}
