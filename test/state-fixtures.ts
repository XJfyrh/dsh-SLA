import assert from 'node:assert/strict';
import type { Candidate, Run, Trial, CodePendingReview, Review } from '../dist/src/data.js';
import { isRecord } from '../dist/src/errors.js';

export function present<T>(value: T): NonNullable<T> {
  assert.ok(value !== null && value !== undefined, 'Expected fixture value to be present');
  return value;
}
export function runFixture(overrides: Partial<Run> = {}): Run {
  return {
    formatVersion: 1, id: 'run', sessionId: 'session', root: 'root', cwd: 'workspace', goal: 'goal', notes: [], revision: 1,
    status: 'preparing', stage: 'snapshot', message: 'preparing', createdAt: new Date().toISOString(), adopted: false,
    trials: [], invocations: [], attempts: 0, limit: 8, elapsedMs: 0, timeLimitMs: 1200000,
    criteriaVersion: 1, artifacts: [], observations: [], decisions: [], frontier: [], directions: [], epochs: [],
    assessments: [], reviews: [], checks: [], tranche: { attempt: 0, elapsedMs: 0 },
    settings: { maxTrials: 8, maxMinutes: 20, directions: 2, localTrials: 2, maxStepsPerCall: 24, maxMinutesPerCall: 5 },
    ...overrides,
  };
}
export function trialFixture(overrides: Partial<Trial> = {}): Trial {
  return { id: 'trial', number: 1, revision: 1, criteriaVersion: 1, epoch: 1, direction: 'one', regime: 'test',
    parentTrial: 0, parentArtifactId: 'baseline', hypothesis: 'fixture', status: 'running', invocationIds: [],
    assessmentStatus: 'pending', selection: null, ...overrides };
}
export function candidateFixture(overrides: Partial<Candidate> = {}): Candidate {
  const evaluation = overrides.evaluation ?? { valid: true, summary: 'fixture' };
  return { ...evaluation, evaluation, trial: 0, criteriaVersion: 1, artifactId: 'baseline', observationId: 'observation', ...overrides };
}
export function best(run: Run): Candidate { return present(run.best); }
export function object(value: unknown) { assert.ok(isRecord(value)); return value; }
export function numeric(value: unknown) { assert.ok(typeof value === 'number'); return value; }

export function pendingReviewFixture(overrides: Partial<CodePendingReview> = {}): CodePendingReview {
  return { id: 'review', revision: 1, criteriaVersion: 2, evaluationDir: 'checks', evaluationFiles: {}, checks: [], candidates: [], results: [], ...overrides };
}
export function reviewFixture(overrides: Partial<Review> = {}): Review {
  return { id: 'review', phase: 'candidate', revision: 1, criteriaVersion: 1, targetTrial: 1, targetFiles: {}, status: 'accepted', ...overrides };
}
export function reviewedBestFixture(overrides: Partial<NonNullable<Run['reviewedBest']>> = {}): NonNullable<Run['reviewedBest']> {
  return { trial: 1, revision: 1, criteriaVersion: 1, task: { id: 'fixture', version: '1.0.0' }, files: {}, ...overrides };
}
