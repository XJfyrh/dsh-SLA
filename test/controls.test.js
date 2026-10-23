import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlSummary } from '../src/research-state.js';

test('main-chat controls retain current failures and budgets without replaying the full history', () => {
  const run = { id: 'run', status: 'blocked', stage: 'review', goal: 'fix a bug', message: 'Review dependency missing', revision: 1, criteriaVersion: 3,
    settings: { maxTrials: 8, maxMinutes: 20, directions: 2, localTrials: 2 }, attempts: 7, limit: 8, elapsedMs: 1234, activeSince: 10000, timeLimitMs: 1200000,
    trials: Array.from({ length: 1000 }, (_, number) => ({ number, report: 'private-full-report '.repeat(100), files: { 'x.js': 'hash' } })),
    best: { trial: 7, valid: true, display: 'fixed '.repeat(10000), summary: 'candidate passes initial checks', files: { 'x.js': 'hash' } },
    reviews: [{ phase: 'candidate', status: 'inconclusive', error: 'Review dependency missing', failedProposal: { huge: 'x'.repeat(10000) } }],
    pendingReview: { results: [] }, reviewSupported: true, root: 'evidence/run' };
  const text = JSON.stringify(controlSummary(run, 11000));
  const value = JSON.parse(text);
  assert.equal(value.attempts, 7); assert.equal(value.limit, 8); assert.equal(value.criteriaVersion, 3);
  assert.equal(value.best.trial, 7); assert.equal(value.reviewPending, true); assert.equal(value.best.display.length, 160);
  assert.equal(value.elapsedMs, 2234);
  assert.equal(value.latestReview.error, 'Review dependency missing');
  assert.ok(!text.includes('private-full-report')); assert.ok(!text.includes('failedProposal')); assert.ok(text.length < 5000);
  assert.equal(controlSummary(null), null);
});
