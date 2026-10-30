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
  let bundle: unknown;
  vm.runInNewContext(await readFile(new URL('../dist/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(value: unknown) { bundle = value; } } }, setTimeout, clearTimeout, console,
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
  const evaluation = { valid: true, summary: 'measured', score: 1 };
  run.trials.push({ ...trial, id: 'complete', number: 1, status: 'kept', evaluation, artifactId: 'candidate', observationId: 'observation' }, trial);
  run.best = { ...evaluation, evaluation, trial: 1, criteriaVersion: 1, artifactId: 'candidate', observationId: 'observation' };
  run.baseline = { valid: true, summary: 'baseline', score: 2 };
  const ctx = new Context();
  const locale = { register: () => () => {}, bind: () => (key: string) => key } satisfies Pick<Context['locale'], 'register' | 'bind'>;
  const remote = { $mount: async () => async () => {}, sla: {
    get: async () => ({ ok: true, value: JSON.stringify(run) }),
    changes: async () => { throw new Error('Unexpected preview request'); },
    action: async (_id, input) => {
      const action = actionSchema.parse(parseJson(input)); assert.equal(action.action, 'configure');
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
    assert.deepEqual(errors.mock.calls.map(call => call.arguments), [], 'React must not report duplicate keys or render failures');
  } finally {
    if (renderer) await act(async () => present(renderer).unmount());
    await ctx.fiber.dispose();
  }
});
