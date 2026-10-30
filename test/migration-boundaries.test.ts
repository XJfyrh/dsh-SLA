import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvaluationPolicy } from '../dist/src/contracts.js';
import { filesSchema, jsonSchema, runSchema } from '../dist/src/data.js';
import { message } from '../dist/src/errors.js';
import { jsonArtifact, verifyJsonArtifact } from '../dist/src/json-artifacts.js';
import { jsonValue } from '../dist/src/kernel.js';
import { evaluationView } from '../dist/src/presentation.js';
import { rerank } from '../dist/src/sla-strategy.js';
import { validateEvaluation } from '../dist/src/workflow-registry.js';
import { parseJson } from '../scripts/json.ts';
import { researchRun } from './fixtures.ts';
import { candidateFixture, numeric, object } from './state-fixtures.ts';

test('JSON validation preserves special own keys and artifact identity through durable state', () => {
  const value = parseJson('{"__proto__":{"domain":"kept"},"nested":{"__proto__":7}}');
  assert.deepEqual(jsonValue(value), value);
  const artifact = jsonArtifact(value);
  verifyJsonArtifact(artifact);
  const run = researchRun();
  run.workflowState = jsonValue(value); run.delivery = jsonValue(value);
  run.sourceFiles = filesSchema.parse(parseJson('{"__proto__":"hash","constructor":"hash2"}'));
  run.artifacts.push({ ...artifact, id: 'artifact', parentId: null, trial: 0, revision: 1, sealedAt: run.createdAt });
  const restored = runSchema.parse(jsonValue(run));
  assert.deepEqual(restored.workflowState, value);
  assert.deepEqual(restored.delivery, value);
  assert.deepEqual(restored.sourceFiles, run.sourceFiles);
  assert.equal(filesSchema.safeParse(parseJson('{"__proto__":17}')).success, false);
  assert.deepEqual(restored.artifacts[0].payload, value);
  verifyJsonArtifact(restored.artifacts[0]);
  for (const invalid of [undefined, Infinity, () => {}, new Date(), new Map(), [1, , 3]]) assert.equal(jsonSchema.safeParse(invalid).success, false);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.equal(jsonSchema.safeParse(cyclic).success, false);
});

test('domain evaluations retain JSON fields without imposing code or performance semantics', () => {
  const value = parseJson('{"valid":true,"summary":"domain result","score":"passed","evidence":{"verified":true},"__proto__":{"x":1}}');
  assert.deepEqual(validateEvaluation(value), value);
  assert.throws(() => validateEvaluation({ ...object(value), invalid: Infinity }), /无效数字/);
});

test('malformed check metadata cannot hide another failed check or become passed', () => {
  const result = evaluationView({ valid: true, summary: 'domain result', supplementaryChecks: [
    { id: 'known', passed: false, summary: 'real failure' }, { id: 'domain', passed: true, summary: 17 }, {}, null,
  ] });
  assert.equal(result.status, 'failed'); assert.equal(result.failed, 1); assert.equal(result.total, 4);
  assert.equal(evaluationView({ valid: true, summary: 'unknown check', supplementaryChecks: [null] }).status, 'unknown');
});

test('error normalization preserves plain-object backend failure reasons', () => {
  assert.equal(message({ message: 'backend unavailable' }), 'backend unavailable');
  assert.equal(message(new Error('failed')), 'failed');
  assert.equal(message('interrupted'), 'interrupted');
});

test('a delivery-only candidate can be reranked without a local lane', () => {
  const candidate = (trial: number, score: number) => candidateFixture({ trial, criteriaVersion: 1, evaluation: { valid: true, summary: 'measured', score }, artifactId: String(trial), observationId: String(trial) });
  const task: EvaluationPolicy = { id: 'test', version: '1.0.0', name: 'test', description: 'fixture', validateBaseline() {}, compare: (a, b) => numeric(a.score) < numeric(b.score) ? 'better' : 'worse', qualify: () => ({ retain: false, deliver: true }) };
  const ranked = rerank(task, { ready: true, criterion: 'fixture' }, candidate(0, 10), [{ candidate: candidate(1, 5) }]);
  assert.equal(ranked.best.trial, 1); assert.equal(ranked.local.size, 0);
  assert.deepEqual(ranked.frontier.map(item => item.trial), [1]);
  assert.throws(() => rerank({ ...task, qualify: () => ({ retain: true, deliver: true }) }, { ready: true, criterion: 'fixture' }, candidate(0, 10), [{ candidate: candidate(1, 5) }]), /候选方向/);
});
