import assert from 'node:assert/strict';
import test from 'node:test';
import type { EvaluationPolicy } from '../dist/src/contracts.js';
import type { Candidate, NativePendingReview } from '../dist/src/data.js';
import { candidateFrom, observe, publishCriteria, sealArtifact } from '../dist/src/kernel.js';
import { rerank } from '../dist/src/sla-strategy.js';
import { researchRun } from './fixtures.ts';
import { candidateFixture, present, trialFixture } from './state-fixtures.ts';

function pendingFixture() {
  const run = researchRun({ task: { id: 'test', version: '1.0.0' }, trials: [trialFixture({ number: 1, revision: 1 })], baseline: { valid: true, summary: 'before' } });
  const base = sealArtifact(run, { kind: 'test', digest: 'base', payload: {} }), child = sealArtifact(run, { kind: 'test', digest: 'child', payload: {}, parentId: base.id, trial: 1 });
  run.baselineArtifactId = base.id;
  const pending: NativePendingReview = { kind: 'workflow', id: 'review', criteria: { ready: true, criterion: 'v2' }, revision: 1, criteriaVersion: 2, candidates: [base.id, child.id], results: [] };
  run.pendingReview = pending;
  for (const artifact of [base, child]) {
    const evaluation = { valid: true, summary: artifact.digest }, observation = observe(run, artifact.id, evaluation, { criteriaVersion: 2 });
    pending.results.push({ evaluation, artifactId: artifact.id, observationId: observation.id });
  }
  const baseline = present(pending).results[0], best = candidateFrom(present(pending).results[1], { trial: 1, criteriaVersion: 2 });
  return { run, pending, selection: { baseline, best, local: new Map<string, Candidate>(), frontier: [best], criteria: { ready: true, criterion: 'v2' } } };
}

test('criteria publication rejects cross-wired observations, altered results and missing coverage atomically', () => {
  const tampers: Array<(f: ReturnType<typeof pendingFixture>) => void> = [
    f => { f.selection.best.observationId = f.selection.baseline.observationId; },
    f => { f.selection.best.evaluation.summary = 'invented'; },
    f => { f.selection.best.trial = 0; },
    f => { f.selection.baseline = f.pending.results[1]; },
    f => { f.pending.results.pop(); },
  ];
  for (const tamper of tampers) {
    const f = pendingFixture(); tamper(f); const before = structuredClone(f.run);
    assert.throws(() => publishCriteria(f.run, present(f.pending), f.selection), /观测|全部候选/);
    assert.deepEqual(f.run, before);
  }
  const f = pendingFixture(); publishCriteria(f.run, present(f.pending), f.selection);
  assert.equal(f.run.criteriaVersion, 2); assert.equal(f.run.pendingReview, null);
});

test('policy retains incomparable candidates and respects separate retention and delivery qualification', () => {
  const candidate = (trial: number, category: string, valid = true) => candidateFixture({ trial, evaluation: { valid, summary: category, category }, artifactId: String(trial), observationId: String(trial), criteriaVersion: 1 });
  const task: EvaluationPolicy = { id: 'test', version: '1.0.0', name: 'test', description: 'fixture', validateBaseline() {}, compare: (a, b) => a.category === b.category ? 'equal' : 'incomparable', qualify: result => ({ retain: true, deliver: result.valid }) };
  const ranked = rerank(task, { ready: true, criterion: 'fixture' }, candidate(0, 'base'), [{ lane: 'a', candidate: candidate(1, 'alternative') }, { lane: 'b', candidate: candidate(2, 'unfinished', false) }, { lane: 'c', candidate: candidate(3, 'alternative') }]);
  assert.deepEqual(ranked.frontier.map(c => c.trial), [0, 1]);
  assert.equal(ranked.best.trial, 0); assert.equal(present(ranked.local.get('b')).trial, 2);
  const blockedBaseline = rerank({ ...task, qualify: () => ({ retain: true, deliver: false }) }, { ready: true, criterion: 'fixture' }, candidate(0, 'base'), []);
  assert.deepEqual(blockedBaseline.frontier, []);
});
