import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeResearch, validateRun } from '../dist/src/research-state.js';
import { WorkflowRegistry } from '../dist/src/workflow-registry.js';
import { performanceWorkflow } from '../dist/extensions/performance.js';
import { researchRun } from './fixtures.js';

test('current format is initialized once and rejects missing facts instead of manufacturing them on recovery', () => {
  const run = researchRun();
  const saved = structuredClone(run);
  validateRun(run);
  assert.deepEqual(run, saved);
  delete run.observations;
  assert.throws(() => validateRun(run), /observations/);
  assert.equal(run.observations, undefined);
  assert.throws(() => validateRun({ ...saved, formatVersion: 3 }), /格式无效/);
});

test('registration requires an explicit workflow kind', () => {
  const registry = new WorkflowRegistry();
  const { kind, ...definition } = performanceWorkflow;
  assert.throws(() => registry.register(definition), /defineCodeWorkflow/);
  registry.register(performanceWorkflow);
  assert.equal(registry.get(performanceWorkflow).task.kind, 'code');
});
