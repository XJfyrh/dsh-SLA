import { Context } from '@deepseek-ai/cordis';
import { brandString } from '@deepseek-ai/dsh-brand';
import type { PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit';
import type { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale, PropsRuntime, SlotMap } from '@deepseek-ai/dsh-client-ui-slots';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import * as React from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import { act, create } from 'react-test-renderer';
import { actionSchema } from '../dist/src/data.js';
import { parseJson } from '../scripts/json.ts';
import { object, present, runFixture, trialFixture } from './state-fixtures.ts';

test('the shipped client renders unmeasured trials and keeps one settings form across updates', async t => {
  const errors = t.mock.method(console, 'error', () => {});
  const copiedPaths: string[] = [];
  let copyFails = false;
  let bundle: unknown;
  vm.runInNewContext(await readFile(new URL('../dist/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(value: unknown) { bundle = value; } } }, setTimeout, clearTimeout, console,
    navigator: { clipboard: { async writeText(value: string) { if (copyFails) throw new Error('clipboard unavailable'); copiedPaths.push(value); } } },
  });
  const loaded = object(bundle); assert.equal(loaded.id, 'dsh-sla');
  const factory = loaded.factory; assert.ok(typeof factory === 'function');
  const plugin: unknown = factory((name: string) => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: ({ text }: React.ComponentProps<typeof MarkdownText>) => React.createElement('span', null, text), DiffBlock: () => null };
    throw new Error(`Unexpected browser dependency: ${name}`);
  });
  const components = new Map<string, unknown>();
  const run = runFixture({ status: 'paused' });
  const trial = trialFixture({ id: 'pending', number: 2, revision: 1, criteriaVersion: 1, epoch: 1, direction: 'one', regime: 'test', parentTrial: 0, parentArtifactId: 'baseline', status: 'inconclusive', hypothesis: 'interrupted before evaluation', invocationIds: [], assessmentStatus: 'pending', selection: null });
  const evaluation = { valid: true, summary: 'measured', score: 1, display: '1' };
  run.trials.push({ ...trial, id: 'complete', number: 1, status: 'kept', evaluation, artifactId: 'candidate', observationId: 'observation' }, trial);
  run.best = { ...evaluation, evaluation, trial: 1, criteriaVersion: 1, artifactId: 'candidate', observationId: 'observation' };
  run.baseline = { valid: true, summary: 'baseline', score: 2 };
  run.criteria = { ready: true, title: 'Timing', criterion: 'Measure runtime', unit: 'ms' };
  const ctx = new Context();
  let configureCalls = 0;
  let configureGate: Promise<void> | undefined;
  const locale = { register: () => () => {}, bind: () => (key: string) => key } satisfies Pick<Context['locale'], 'register' | 'bind'>;
  const remote = { $mount: async () => async () => {}, sla: {
    get: async () => ({ ok: true, value: JSON.stringify(run) }),
    changes: async () => { throw new Error('Unexpected preview request'); },
    action: async (_id, input) => {
      const action = actionSchema.parse(parseJson(input)); assert.equal(action.action, 'configure');
      configureCalls++;
      await configureGate;
      Object.assign(run.settings, action.settings); return { ok: true, value: JSON.stringify(run) };
    },
  } } satisfies Pick<Context['remote'], '$mount' | 'sla'>;
  const slots = {
    inject(_name, callback) { return ctx.effect(callback); },
    register({ name }: { name: keyof SlotMap & string }, component: unknown) { components.set(name, component); return () => { components.delete(name); }; },
  } satisfies Pick<Context['slots'], 'inject' | 'register'>;
  const tabs = { register: () => () => {} } satisfies Pick<Context['sidebarRightTabs'], 'register'>;
  ctx.provide('locale', locale); ctx.provide('remote', remote); ctx.provide('remote.sla', remote.sla);
  ctx.provide('slots', slots); ctx.provide('sidebarRightTabs', tabs);
  const apply = object(plugin).apply; assert.ok(typeof apply === 'function'); await apply(ctx);
  const panel = components.get('sidebar.right.pane.tab'); assert.ok(typeof panel === 'function');
  const unexpected = (): never => { throw new Error('Unexpected client fixture capability'); };
  const props: PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'sla'> = {
    sessionId: SessionId(run.sessionId), t: key => key,
    useTabInfo: () => ({ sidebar: { expanded: true, fullscreen: false }, panel: { id: brandString<PaneId>('pane') },
      tab: { id: brandString<TabId>('test'), kind: 'test', contentId: 'test', title: 'test', visible: true,
        navigation: { address: 'test', params: undefined, revision: 0 }, signal: new AbortController().signal,
        actions: { bindCommands: unexpected, openResource: unexpected, openTab: unexpected, close: unexpected } } }),
    useSessions: unexpected, useSessionStatus: unexpected, useSessionRetainInfo: unexpected, useSessionAccess: unexpected,
    useSession: unexpected, useProjection: unexpected, useAccess: unexpected, useWorkspaces: unexpected,
    useConversation: unexpected, useInput: unexpected, get inputActions() { return unexpected(); },
    useChat: unexpected, usePanelInfo: unexpected, useRemoteAccess: unexpected,
  };
  const renderPanel = panel;
  function Panel() {
    const rendered: unknown = renderPanel(props);
    assert.ok(rendered === null || React.isValidElement(rendered));
    return rendered;
  }
  let renderer: ReactTestRenderer | undefined;

  try {
    await act(async () => {
      renderer = create(React.createElement(Panel));
    });
    const rendered = JSON.stringify(present(renderer).toJSON());
    assert.match(rendered, /#2 · inconclusive/);
    assert.match(rendered, /unknownCheck/);
    assert.doesNotMatch(rendered, /Invalid input/);
    assert.deepEqual(present(renderer).root.findByProps({ className: 'sla-comparison' }).findAllByType('dd').map(node => node.children.join('')), ['2 ms', '1 ms']);
    for (const value of ['9', '10', '11']) {
      assert.equal(present(renderer).root.findAllByProps({ className: 'sla-section sla-settings' }).length, 1);
      const onChange: unknown = present(renderer).root.findByProps({ name: 'maxTrials' }).props.onChange;
      assert.ok(typeof onChange === 'function');
      await act(async () => { await onChange({ target: { value } }); });
      const onSubmit: unknown = present(renderer).root.findByType('form').props.onSubmit;
      assert.ok(typeof onSubmit === 'function');
      await act(async () => { await onSubmit({ preventDefault() {} }); });
      assert.equal(run.settings.maxTrials, Number(value));
    }
    assert.equal(present(renderer).root.findAllByProps({ className: 'sla-section sla-settings' }).length, 1);
    await t.test('invalid settings stay local and expose errors, including collapsed advanced fields', async () => {
      const callsBefore = configureCalls;
      for (const [name, value] of [['maxTrials', ''], ['maxMinutes', '241'], ['maxStepsPerCall', '3.5']]) {
        const onChange: unknown = present(renderer).root.findByProps({ name }).props.onChange;
        assert.ok(typeof onChange === 'function');
        await act(async () => { onChange({ target: { value } }); });
      }
      const onSubmit: unknown = present(renderer).root.findByType('form').props.onSubmit;
      assert.ok(typeof onSubmit === 'function');
      await act(async () => { await onSubmit({ preventDefault() {} }); });
      assert.equal(configureCalls, callsBefore, 'invalid fields must not reach the Host');
      for (const name of ['maxTrials', 'maxMinutes', 'maxStepsPerCall']) {
        const input = present(renderer).root.findByProps({ name });
        assert.equal(input.props['aria-invalid'], true);
        assert.ok(present(renderer).root.findByProps({ id: input.props['aria-describedby'] }));
      }
      const advanced = present(renderer).root.findAllByType('details').find(node => node.findAllByType('input').some(input => input.props.name === 'maxStepsPerCall') && node.props.className === 'sla-details');
      assert.equal(present(advanced).props.open, true, 'save reveals invalid advanced fields');
      assert.equal(present(renderer).root.findByProps({ name: 'maxTrials' }).props.value, '', 'keep the draft for correction');
      for (const [name, value] of [['maxTrials', '12'], ['maxMinutes', '30'], ['maxStepsPerCall', '48']]) {
        const onChange: unknown = present(renderer).root.findByProps({ name }).props.onChange;
        assert.ok(typeof onChange === 'function');
        await act(async () => { onChange({ target: { value } }); });
      }
      // Submit through the latest handler after editing the draft.
      const correctedSubmit: unknown = present(renderer).root.findByType('form').props.onSubmit;
      assert.ok(typeof correctedSubmit === 'function');
      await act(async () => { await correctedSubmit({ preventDefault() {} }); });
      assert.equal(configureCalls, callsBefore + 1);
      assert.equal(run.settings.maxStepsPerCall, 48);
      assert.equal(run.settings.maxTrials, 12);
      assert.equal(run.settings.maxMinutes, 30);
    });
    await t.test('saving reports progress, keeps a failed draft, and lets users discard it', async () => {
      const callsBefore = configureCalls;
      const gate = Promise.withResolvers<void>();
      configureGate = gate.promise;
      const change: unknown = present(renderer).root.findByProps({ name: 'maxTrials' }).props.onChange;
      assert.ok(typeof change === 'function');
      await act(async () => { change({ target: { value: '13' } }); });
      const submit: unknown = present(renderer).root.findByType('form').props.onSubmit;
      assert.ok(typeof submit === 'function');
      let saving: Promise<unknown> | undefined;
      await act(async () => { saving = submit({ preventDefault() {} }); });
      assert.equal(present(renderer).root.findByType('fieldset').props.disabled, true);
      assert.ok(present(renderer).root.findByType('form').findAllByType('button').some(button => button.children.includes('savingSettings')));
      gate.reject(new Error('Settings could not be saved'));
      await act(async () => { await saving; });
      configureGate = undefined;
      assert.equal(configureCalls, callsBefore + 1);
      assert.equal(run.settings.maxTrials, 12, 'failed save must not change persisted settings');
      assert.equal(present(renderer).root.findByProps({ name: 'maxTrials' }).props.value, '13');
      const settings = present(renderer).root.findByProps({ className: 'sla-section sla-settings' });
      assert.equal(settings.findByProps({ role: 'alert' }).children.join(''), 'Settings could not be saved');
      const discard = settings.findAllByType('button').find(button => button.children.includes('resetSettings'));
      const onClick: unknown = present(discard).props.onClick;
      assert.ok(typeof onClick === 'function');
      await act(async () => { onClick(); });
      assert.equal(present(renderer).root.findByProps({ name: 'maxTrials' }).props.value, 12);
      assert.equal(settings.findAllByProps({ role: 'alert' }).length, 0);
      assert.equal(configureCalls, callsBefore + 1, 'discard is local');
    });
    await t.test('delivery exposes the exact output path and handles clipboard failures', async () => {
      const path = 'C:\\work\\result files\\parameters.json';
      run.adopted = true;
      run.delivery = { kind: 'parameter-package', path, artifactId: 'candidate' };
      props.sessionId = SessionId('receipt-session');
      await act(async () => { present(renderer).update(React.createElement(Panel)); });
      assert.ok(present(renderer).root.findAllByProps({ className: 'sla-path' }).some(node => node.children.join('') === path));
      const copy = present(renderer).root.findAllByType('button').find(button => button.children.includes('copyPath'));
      const onClick: unknown = present(copy).props.onClick;
      assert.ok(typeof onClick === 'function');
      await act(async () => { await onClick(); });
      assert.deepEqual(copiedPaths, [path]);
      assert.ok(present(renderer).root.findAllByProps({ role: 'status' }).some(node => node.children.includes('pathCopied')));
      copyFails = true;
      await act(async () => { await onClick(); });
      assert.ok(present(renderer).root.findAllByProps({ role: 'status' }).some(node => node.children.includes('copyPathFailed')));
      assert.deepEqual(copiedPaths, [path]);
    });
    assert.deepEqual(errors.mock.calls.map(call => call.arguments), [], 'React must not report duplicate keys or render failures');
  } finally {
    if (renderer) await act(async () => present(renderer).unmount());
    await ctx.fiber.dispose();
  }
});
