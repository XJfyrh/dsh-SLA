import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { researchRun } from './fixtures.js';

test('the shipped client renders unmeasured trials and keeps one settings form across updates', async t => {
  const errors = t.mock.method(console, 'error', () => {});
  let bundle;
  vm.runInNewContext(await readFile(new URL('../dist/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { bundle = value; } } }, setTimeout, clearTimeout, console,
  });
  assert.equal(bundle.id, 'dsh-sla');
  const plugin = bundle.factory(name => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: ({ text }) => React.createElement('span', null, text), DiffBlock: () => null };
    throw new Error(`Unexpected browser dependency: ${name}`);
  });
  const components = new Map(), disposers = [];
  const run = researchRun({ status: 'paused' });
  const trial = { id: 'pending', number: 2, revision: 1, criteriaVersion: 1, epoch: 1, direction: 'one', regime: 'test', parentTrial: 0, parentArtifactId: 'baseline', status: 'inconclusive', hypothesis: 'interrupted before evaluation', invocationIds: [], assessmentStatus: 'pending', selection: null };
  const evaluation = { valid: true, summary: 'measured', score: 1 };
  run.trials.push({ ...trial, id: 'complete', number: 1, status: 'kept', evaluation, artifactId: 'candidate', observationId: 'observation' }, trial);
  run.best = { ...evaluation, evaluation, trial: 1, criteriaVersion: 1, artifactId: 'candidate', observationId: 'observation' };
  run.baseline = { valid: true, summary: 'baseline', score: 2 };
  const ctx = {
    effect(callback) { const dispose = callback(); if (dispose) disposers.push(dispose); },
    inject(_services, callback) { callback(ctx); },
    locale: { register() {}, bind: () => key => key },
    remote: { $mount: async () => {}, sla: {
      get: async () => ({ ok: true, value: JSON.stringify(run) }),
      action: async (_id, input) => {
        const action = JSON.parse(input); assert.equal(action.action, 'configure');
        Object.assign(run.settings, action.settings); return { ok: true, value: JSON.stringify(run) };
      },
    } },
    sidebarRightTabs: { register() {} },
    slots: { inject(_name, callback) { callback(); }, register({ name }, component) { components.set(name, component); } },
  };
  await plugin.apply(ctx);
  let renderer;
  try {
    await act(async () => {
      renderer = create(React.createElement(components.get('sidebar.right.pane.tab'), { sessionId: run.sessionId, t: key => key, useTabInfo: () => ({ tab: { id: 'test' } }) }));
    });
    const rendered = JSON.stringify(renderer.toJSON());
    assert.match(rendered, /#2 · inconclusive/);
    assert.match(rendered, /unknownCheck/);
    assert.doesNotMatch(rendered, /Invalid input/);
    for (const value of ['9', '10', '11']) {
      assert.equal(renderer.root.findAllByProps({ className: 'sla-section sla-settings' }).length, 1);
      await act(async () => renderer.root.findByProps({ name: 'maxTrials' }).props.onChange({ target: { value } }));
      await act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
      assert.equal(run.settings.maxTrials, Number(value));
    }
    assert.equal(renderer.root.findAllByProps({ className: 'sla-section sla-settings' }).length, 1);
    assert.deepEqual(errors.mock.calls.map(call => call.arguments), [], 'React must not report duplicate keys or render failures');
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    for (const dispose of disposers) dispose();
  }
});
