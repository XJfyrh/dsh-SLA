export const defaults = Object.freeze({ maxTrials: 8, maxMinutes: 20, directions: 2, localTrials: 2, maxStepsPerCall: 24, maxMinutesPerCall: 5 });
export function settings(value = {}, base = defaults) {
  const limits = { maxTrials: [1, 100], maxMinutes: [1, 240], directions: [1, 4], localTrials: [1, 5], maxStepsPerCall: [4, 200], maxMinutesPerCall: [1, 60] };
  for (const key of Object.keys(value)) if (!limits[key]) throw new Error('未知探索设置：' + key);
  const result = { ...base, ...value };
  for (const [key, [min, max]] of Object.entries(limits)) if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw new Error(`${key} 必须是 ${min}–${max} 的整数`);
  return result;
}

export function initializeResearch(run, config = defaults) {
  run.settings ??= { ...config };
  run.settings.maxStepsPerCall ??= 24;
  run.settings.maxMinutesPerCall ??= 5;
  run.tranche ??= { attempt: 0, elapsedMs: 0 };
  run.directions ??= [];
  run.epochs ??= [];
  run.assessments ??= [];
  run.reviews ??= [];
  run.checks ??= [];
  run.criteriaVersion ??= run.revision;
  run.formatVersion = 3;
}

const short = (text, n = 500) => String(text ?? '').slice(0, n);
// Main-chat controls need current state, not every snapshot hash and old output.
// The Web service and persisted report continue to expose the complete record.
export function controlSummary(run, now = Date.now()) {
  if (!run) return null;
  const result = value => value ? { trial: value.trial, valid: value.valid, score: value.score,
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

function currentTrial(trial, run) {
  const assessment = run?.assessments?.filter(a => a.trial === trial.number && a.revision === run.revision && a.criteriaVersion === run.criteriaVersion).at(-1);
  if (assessment) return { ...trial, historicalStatus: trial.status, criteriaVersion: assessment.criteriaVersion, evaluation: assessment.evaluation,
    valid: assessment.evaluation.valid, status: assessment.evaluation.valid ? 'rechecked-valid' : 'invalid', summary: assessment.evaluation.summary, evidence: assessment.evaluation.evidence };
  if (run && (trial.criteriaVersion ?? trial.revision) !== run.criteriaVersion) return { ...trial, historicalStatus: trial.status, status: 'not-rechecked', valid: undefined };
  return trial;
}
export function feedback(trial, run) {
  if (!trial) return null;
  trial = currentTrial(trial, run);
  return { trial: trial.number, epoch: trial.epoch, criteriaVersion: trial.criteriaVersion,
    status: trial.status, historicalStatus: trial.historicalStatus, hypothesis: short(trial.hypothesis), valid: trial.valid,
    result: short(trial.evaluation?.display ?? trial.summary), diagnostic: short(trial.summary),
    evidence: trial.evidence ?? null };
}

// Counts include the complete current-goal record; detail is selected by outcome,
// not by one chronological tail that would erase an inactive direction.
export function advisorEvidence(run) {
  const trials = run.trials.filter(t => t.revision === run.revision).map(t => currentTrial(t, run));
  const groups = new Map(run.directions.filter(d => d.revision === run.revision).map(d => [d.id, { direction: d.id, hypothesis: short(d.hypothesis), localBest: d.best ? { trial: d.best.trial, valid: d.best.evaluation.valid, result: short(d.best.evaluation.display ?? d.best.evaluation.summary), criteriaVersion: d.best.criteriaVersion } : null, trials: [] }]));
  for (const trial of trials) {
    const id = trial.direction ?? 'legacy';
    if (!groups.has(id)) groups.set(id, { direction: id, trials: [] });
    groups.get(id).trials.push(trial);
  }
  return [...groups.values()].map(({ trials: history, ...group }) => {
    const counts = {};
    for (const t of history) counts[t.status] = (counts[t.status] ?? 0) + 1;
    const selected = new Map();
    for (const status of ['kept', 'local-kept', 'no-improvement', 'invalid', 'inconclusive', 'rechecked-valid', 'not-rechecked']) {
      const matches = history.filter(t => t.status === status);
      for (const t of [matches[0], ...matches.slice(-2)].filter(Boolean)) selected.set(t.number, feedback(t));
    }
    return { ...group, counts, evidence: [...selected.values()].sort((a, b) => a.trial - b.trial) };
  });
}

export function validatePlan(plan, run) {
  if (typeof plan?.stop !== 'boolean' || typeof plan.reason !== 'string' || !Array.isArray(plan.assignments)) throw new Error('规划结果格式无效');
  if (plan.stop) {
    if (!plan.reason.trim() || plan.assignments.length) throw new Error('停止规划必须说明理由且不同时分配任务');
    return plan;
  }
  if (!plan.assignments.length || plan.assignments.length > run.settings.directions) throw new Error('规划方向数量超出配置');
  const ids = new Set();
  for (const a of plan.assignments) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(a.direction ?? '') || ids.has(a.direction)) throw new Error('方向 id 无效或重复');
    ids.add(a.direction);
    for (const key of ['hypothesis', 'instructions']) if (typeof a[key] !== 'string' || !a[key].trim()) throw new Error('方向缺少 ' + key);
    if (!Array.isArray(a.evidenceTrials) || a.evidenceTrials.some(n => !Number.isInteger(n) || !run.trials.some(t => t.number === n && t.revision === run.revision))) throw new Error('规划引用了不存在的实验');
  }
  return plan;
}

export function reviewed(run, task) {
  const approval = run.reviewedBest;
  return !task.review || (approval?.trial === run.best?.trial && approval?.criteriaVersion === run.criteriaVersion && approval?.revision === run.revision && approval?.task?.id === run.task.id && approval?.task?.version === run.task.version && !run.pendingReview);
}
