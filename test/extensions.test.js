import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowRegistry, validateEvaluation, compare } from '../dist/src/workflow-registry.js';
import { performanceWorkflow } from '../dist/extensions/performance.js';
import { bugfixWorkflow } from '../dist/extensions/bugfix.js';
import { parseResult } from '../dist/src/evaluation.js';

test('registry rejects duplicates, binds exact version, disposes one registration only', () => {
  const tasks = new WorkflowRegistry();
  const dispose = tasks.register(performanceWorkflow);
  const first = tasks.get(performanceWorkflow);
  assert.throws(() => tasks.register(performanceWorkflow), /重复/);
  assert.throws(() => tasks.get({ ...performanceWorkflow, version: '2.0.0' }), /版本/);
  dispose();
  assert.equal(first.signal.aborted, true);
  assert.throws(() => tasks.get(performanceWorkflow), /未安装/);
  tasks.register(performanceWorkflow); dispose();
  assert.equal(tasks.get(performanceWorkflow).signal.aborted, false);
});

test('evaluation accepts categorical results, refuses contradictory bugfix evidence', async () => {
  assert.equal(validateEvaluation({ valid: true, summary: 'tests passed', display: '修复通过' }).score, undefined);
  assert.throws(() => validateEvaluation({ valid: true, summary: 'x', score: NaN }), /数字/);
  assert.throws(() => compare({ compare: () => true }, {}, {}, {}), /扩展比较/);
  const execute = async () => ({ exitCode: 0, stdout: { text: 'SLA_RESULT '+JSON.stringify({ valid: true, reproduced: true, regressionPassed: true, summary: 'false success' }), truncated: false }, stderr: { text: '' } });
  await assert.rejects(bugfixWorkflow.evaluate({ execute }), /相互矛盾/);
});

test('completed negative checks stay distinct from evaluation process failures', () => {
  const result = { exitCode: 0, stdout: { text: 'SLA_RESULT {"valid":false,"summary":"target bug reproduced"}', truncated: false }, stderr: { text: '' } };
  assert.equal(parseResult(result).valid, false);
  assert.throws(() => parseResult({ ...result, exitCode: 1 }), /exit=1.*target bug reproduced/);
  assert.throws(() => parseResult({ ...result, timedOut: true }), /评价没有完成/);
});
