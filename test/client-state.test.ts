import { brandString } from '@deepseek-ai/dsh-brand';
import type { TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit';
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types';
import assert from 'node:assert/strict';
import test from 'node:test';
import { collapseAdoptedPanel, createRunStore, latestRunTurn, ownsRun } from '../dist/src/client-state.js';
import type { Run } from '../dist/src/data.js';
import { present, runFixture } from './state-fixtures.ts';

const deferred = () => Promise.withResolvers<Run | null>();
function turnFixture(turn: number, endedAt?: number): TurnLocation {
  return { turn, status: endedAt === undefined ? 'open' : 'closed', start: undefined, steps: [],
    end: endedAt === undefined ? undefined : { type: 'turn/end', seq: SessionSeq(turn), time: endedAt, data: { turn, reason: { kind: 'completed' } } },
    data: { get() { return undefined; }, source() { return { getSnapshot: () => undefined, subscribe: () => () => {} }; } } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('header, result and sidebar share one read and stop after the last unsubscribe', async () => {
  const response = deferred();
  let reads = 0;
  const store = createRunStore(() => { reads++; return response.promise; }, async () => null, 60000);
  const a = store.forSession(SessionId('a'));
  assert.equal(a, store.forSession(SessionId('a')));
  const stop1 = a.subscribe(() => {});
  const stop2 = a.subscribe(() => {});
  assert.equal(reads, 1);
  stop1(); stop2();
  response.resolve(runFixture({ id: 'a' }));
  await flush();
  assert.equal(a.getSnapshot().run, undefined);
  store.dispose();
});

test('switching sessions cannot display the previous session or its late response', async () => {
  const old = deferred();
  const store = createRunStore(id => id === 'a' ? old.promise : Promise.resolve(runFixture({ id: 'b' })), async () => null, 60000);
  const a = store.forSession(SessionId('a'));
  const stopA = a.subscribe(() => {});
  stopA();
  const b = store.forSession(SessionId('b'));
  const stopB = b.subscribe(() => {});
  await flush();
  old.resolve(runFixture({ id: 'a' }));
  await flush();
  assert.equal(a.getSnapshot().run, undefined);
  assert.equal(present(b.getSnapshot().run).id, 'b');
  stopB(); store.dispose();
});

test('a late poll cannot overwrite adoption and duplicate actions are not submitted', async () => {
  const read = deferred(), write = deferred();
  let calls = 0;
  const store = createRunStore(() => read.promise, () => { calls++; return write.promise; }, 60000);
  const entry = store.forSession(SessionId('a'));
  const stop = entry.subscribe(() => {});
  const action = entry.action('adopt');
  await entry.action('adopt');
  assert.equal(calls, 1);
  write.resolve(runFixture({ adopted: true }));
  await action;
  read.resolve(runFixture({ adopted: false }));
  await flush();
  assert.equal(present(entry.getSnapshot().run).adopted, true);
  assert.equal(entry.getSnapshot().busy, false);
  stop(); store.dispose();
});

test('unloading suppresses late actions and UI navigation', async () => {
  const write = deferred();
  const store = createRunStore(async () => null, () => write.promise);
  const entry = store.forSession(SessionId('a'));
  const action = entry.action('adopt');
  store.dispose();
  write.resolve(runFixture({ adopted: true }));
  assert.equal(await action, undefined);
  assert.equal(entry.getSnapshot().run, undefined);
});

test('failed action retains the current result and reports its reason', async () => {
  const store = createRunStore(async () => runFixture({ id: 'a' }), async () => { throw new Error('source changed'); }, 60000);
  const entry = store.forSession(SessionId('a'));
  const stop = entry.subscribe(() => {});
  await flush();
  await entry.action('adopt');
  assert.equal(present(entry.getSnapshot().run).id, 'a');
  assert.equal(entry.getSnapshot().error, 'source changed');
  assert.equal(entry.getSnapshot().busy, false);
  stop(); store.dispose();
});

test('live state moves to the latest completed turn and never appears before launch or twice', () => {
  const run = runFixture({ createdAt: new Date(1500).toISOString() });
  const turns = [turnFixture(0, 1000), turnFixture(1, 2000), turnFixture(2)];
  const timeline = { turnOrder: [0, 1, 2], turns: new Map(turns.map(t => [t.turn, t])) };
  assert.equal(latestRunTurn(timeline, run.createdAt), 1);
  assert.equal(ownsRun(turns[1], run, 1), true);
  Object.assign(turns[2], turnFixture(2, 3000));
  const latest = latestRunTurn(timeline, run.createdAt);
  assert.equal(latest, 2);
  assert.deepEqual(turns.map(t => ownsRun(t, run, latest)), [false, false, true]);
  for (const status of ['running', 'paused', 'blocked', 'completed'] as const) assert.equal(ownsRun(turns[2], { ...run, status }, latest), true);
  assert.equal(latestRunTurn(timeline, new Date(4000).toISOString()), undefined);
  assert.equal(latestRunTurn(undefined, run.createdAt), undefined);
  assert.equal(latestRunTurn(timeline, 'invalid'), undefined);
  assert.equal(ownsRun(turns[1], run, undefined), false);
});

test('adoption only collapses its own visible sidebar, never another session or tab', () => {
  const slaTab = brandString<TabId>('sla'), fileTab = brandString<TabId>('file');
  let tab = slaTab, expanded = true, toggles = 0;
  let session = SessionId('a');
  const mounted = { getSnapshot: () => session, subscribe: () => () => {} };
  const sidebar = { mounted, active: () => ({ id: tab, kind: 'test', contentId: 'test', title: 'test' }),
    isExpanded: () => expanded, toggleExpanded: () => { toggles++; } };
  session = SessionId('b'); collapseAdoptedPanel(sidebar, SessionId('a'), slaTab);
  session = SessionId('a'); tab = fileTab; collapseAdoptedPanel(sidebar, SessionId('a'), slaTab);
  tab = slaTab; expanded = false; collapseAdoptedPanel(sidebar, SessionId('a'), slaTab);
  assert.equal(toggles, 0);
  expanded = true; collapseAdoptedPanel(sidebar, SessionId('a'), slaTab);
  assert.equal(toggles, 1);
});
