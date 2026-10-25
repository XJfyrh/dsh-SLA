import { randomUUID } from 'node:crypto';

// Domain facts only: no directories, tools, model roles or workflow ordering.
export function initializeKernel(run) {
  run.artifacts ??= [];
  run.observations ??= [];
  run.decisions ??= [];
  run.frontier ??= [];
}

export function jsonValue(value) {
  const text = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('研究事实包含无效数字');
    if (['function', 'symbol', 'bigint'].includes(typeof item)) throw new Error('研究事实必须为 JSON');
    return item;
  });
  if (!text) throw new Error('研究事实缺失');
  return JSON.parse(text);
}

function current(run, fact) {
  if (fact.revision !== run.revision || fact.criteriaVersion !== run.criteriaVersion) throw new Error('研究结果版本已过期，未提交');
}

export function reserveAttempt(run, epoch, assignment, lane) {
  initializeKernel(run);
  current(run, epoch);
  if (run.attempts >= run.limit) throw new Error('尝试额度已用完');
  if (!lane || lane.revision !== run.revision) throw new Error('候选分支不存在或版本过期');
  const seed = lane.best ?? lane.seed;
  const attempt = {
    id: randomUUID(), number: ++run.attempts, revision: run.revision,
    criteriaVersion: run.criteriaVersion, epoch: epoch.number,
    direction: lane.id, regime: lane.regime ?? assignment.direction,
    parentTrial: seed.trial, parentArtifactId: seed.artifactId,
    hypothesis: assignment.hypothesis, status: 'running',
    invocationIds: [], assessmentStatus: 'pending', selection: null,
  };
  run.trials.push(attempt);
  return attempt;
}

export function sealArtifact(run, input) {
  initializeKernel(run);
  const { kind, digest, payload, parentId = null, trial = 0 } = input;
  if (typeof kind !== 'string' || !kind || typeof digest !== 'string' || !digest) throw new Error('制品需要类型与内容身份');
  if (parentId && !run.artifacts.some(a => a.id === parentId)) throw new Error('制品父版本不存在');
  if (trial && !run.trials.some(t => t.number === trial && t.revision === run.revision)) throw new Error('制品没有对应的当前尝试');
  const artifact = { id: randomUUID(), kind, digest, payload: jsonValue(payload), parentId, trial, revision: run.revision, sealedAt: new Date().toISOString() };
  run.artifacts.push(artifact);
  return structuredClone(artifact);
}

export function artifactById(run, id) {
  const artifact = run.artifacts?.find(a => a.id === id);
  if (!artifact) throw new Error('制品身份不存在');
  return structuredClone(artifact);
}

export function candidateFrom(measurement, identity) {
  return { ...structuredClone(measurement.evaluation), evaluation: structuredClone(measurement.evaluation),
    ...identity, artifactId: measurement.artifactId, observationId: measurement.observationId };
}

export function observe(run, artifactId, result, { criteriaVersion = run.criteriaVersion, conditions = {} } = {}) {
  const artifact = artifactById(run, artifactId);
  if (artifact.revision !== run.revision) throw new Error('不能评价旧目标的制品');
  if (criteriaVersion !== run.criteriaVersion && criteriaVersion !== run.pendingReview?.criteriaVersion) throw new Error('评价版本未经声明');
  const observation = {
    id: randomUUID(), artifactId, artifactDigest: artifact.digest,
    revision: run.revision, criteriaVersion, evaluator: jsonValue(run.task),
    result: jsonValue(result), conditions: jsonValue(conditions),
    status: 'completed', observedAt: new Date().toISOString(),
  };
  run.observations.push(observation);
  return structuredClone(observation);
}

export function acceptSelection(run, attempt, candidate, choice) {
  current(run, attempt);
  const observation = run.observations.find(o => o.id === candidate.observationId);
  if (!observation || observation.artifactId !== candidate.artifactId) throw new Error('保留决定缺少对应的独立观测');
  if (JSON.stringify(jsonValue(candidate.evaluation)) !== JSON.stringify(observation.result)) throw new Error('保留结果与独立观测不一致');
  const artifact = artifactById(run, candidate.artifactId);
  if (artifact.trial !== attempt.number || artifact.parentId !== (attempt.parentArtifactId ?? null)) throw new Error('候选与尝试的血缘不一致');
  current(run, observation);
  if (observation.evaluator.id !== run.task.id || observation.evaluator.version !== run.task.version) throw new Error('评价扩展身份不一致');
  if (typeof choice.local !== 'boolean' || typeof choice.global !== 'boolean' || typeof choice.eligibility?.retain !== 'boolean' || typeof choice.eligibility?.deliver !== 'boolean') throw new Error('保留决定格式无效');
  if (choice.local && !choice.eligibility.retain) throw new Error('没有保留资格的结果不能成为分支候选');
  if (choice.global && (!choice.eligibility.deliver || !observation.result.valid)) throw new Error('没有交付资格的结果不能成为全局交付候选');
  const decision = { ...jsonValue(choice), id: randomUUID(), trial: attempt.number, artifactId: candidate.artifactId,
    observationId: observation.id, revision: run.revision, criteriaVersion: run.criteriaVersion };
  run.decisions.push(decision);
  attempt.selection = decision.id;
  return decision;
}

export function beginRevision(run) {
  run.revision++;
  run.criteriaVersion++;
  run.criteria = null; run.baseline = null; run.best = null;
  run.frontier = [];
  run.checks = []; run.pendingReview = null; run.reviewedBest = null; run.baselineReviewed = null;
  for (const epoch of run.epochs) if (epoch.status === 'running') epoch.status = 'superseded';
  run.rebuild = false;
}

// Publish one complete re-evaluation as a single in-memory transition before
// the Host's durable write. Workflows decide criteria and validation semantics.
export function publishCriteria(run, pending, { baseline, best, local, frontier, criteria = run.criteria }) {
  if (run.pendingReview !== pending || pending.revision !== run.revision || pending.criteriaVersion !== run.criteriaVersion + 1) throw new Error('待发布评价身份或版本已过期');
  const expected = pending.candidates.map(c => typeof c === 'string' ? c : c.artifactId);
  if (expected.some(id => !id) || new Set(expected).size !== expected.length || pending.results.length !== expected.length) throw new Error('评价升级尚未覆盖全部候选');
  for (const id of expected) {
    const result = pending.results.find(r => r.artifactId === id);
    const observation = run.observations.find(o => o.id === result?.observationId);
    if (!observation || observation.artifactId !== id || observation.criteriaVersion !== pending.criteriaVersion || observation.revision !== run.revision
      || observation.evaluator.id !== run.task.id || observation.evaluator.version !== run.task.version
      || JSON.stringify(observation.result) !== JSON.stringify(jsonValue(result.evaluation))) throw new Error('新版评价缺少匹配的完整观测');
  }
  const matches = candidate => {
    const result = pending.results.find(r => r.artifactId === candidate.artifactId && r.observationId === candidate.observationId);
    return result && JSON.stringify(jsonValue(candidate.evaluation)) === JSON.stringify(result.evaluation);
  };
  if (baseline.artifactId !== run.baselineArtifactId || !matches(baseline)) throw new Error('新版基线未绑定基线观测');
  for (const candidate of [best, ...local.values(), ...frontier]) {
    if (!expected.includes(candidate.artifactId) || candidate.criteriaVersion !== pending.criteriaVersion || !matches(candidate)
      || candidate.trial !== artifactById(run, candidate.artifactId).trial) throw new Error('新版候选选择未绑定新版观测');
  }
  if (!run.assessments.some(a => a.trial === 0 && a.criteriaVersion === run.criteriaVersion && a.revision === run.revision)) {
    run.assessments.push({ trial: 0, revision: run.revision, criteriaVersion: run.criteriaVersion, evaluation: structuredClone(run.baseline) });
  }
  run.assessments.push(...pending.results.map(r => ({ trial: artifactById(run, r.artifactId).trial, revision: run.revision,
    criteriaVersion: pending.criteriaVersion, artifactId: r.artifactId, observationId: r.observationId, evaluation: structuredClone(r.evaluation) })));
  run.criteriaVersion = pending.criteriaVersion; run.criteria = jsonValue(criteria);
  run.baseline = structuredClone(baseline.evaluation); run.baselineArtifactId = baseline.artifactId; run.baselineObservationId = baseline.observationId;
  run.best = best; run.frontier = frontier;
  for (const lane of run.directions.filter(d => d.revision === run.revision)) { lane.best = local.get(lane.id) ?? null; lane.seed = structuredClone(best); }
  for (const epoch of run.epochs) if (epoch.status === 'running') epoch.status = 'superseded';
  run.pendingReview = null;
}
