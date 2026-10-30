import assert from 'node:assert/strict';
import test from 'node:test';
import { performanceWorkflow } from '../dist/extensions/performance.js';
import { validateRun } from '../dist/src/research-state.js';
import { WorkflowRegistry } from '../dist/src/workflow-registry.js';
import { researchRun } from './fixtures.ts';

test('current format is initialized once and rejects missing facts instead of manufacturing them on recovery', () => {
  const run = researchRun();
  const saved = structuredClone(run);
  validateRun(run);
  assert.deepEqual(run, saved);
  Reflect.deleteProperty(run, 'observations');
  assert.throws(() => validateRun(run), /observations/);
  assert.equal(run.observations, undefined);
  assert.throws(() => validateRun({ ...saved, formatVersion: 3 }), /格式无效/);
});

test('registration requires an explicit workflow kind', () => {
  const registry = new WorkflowRegistry();
  const { kind, ...definition } = performanceWorkflow;
  // @ts-expect-error Missing workflow kind must also be rejected at runtime.
  assert.throws(() => registry.register(definition), /defineCodeWorkflow/);
  registry.register(performanceWorkflow);
  assert.equal(registry.get(performanceWorkflow).task.kind, 'code');
});
