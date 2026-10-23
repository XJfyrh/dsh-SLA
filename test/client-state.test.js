import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunStore, ownsRun, collapseAdoptedPanel } from '../src/client-state.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('header, result and sidebar share one read and stop after the last unsubscribe', async () => {
  const response = deferred();
  let reads = 0;
  const store = createRunStore(() => { reads++; return response.promise; }, () => {}, 60000);
  const a = store.forSession('a');
  assert.equal(a, store.forSession('a'));
  const stop1 = a.subscribe(() => {});
  const stop2 = a.subscribe(() => {});
  assert.equal(reads, 1);
  stop1(); stop2();
  response.resolve({ id: 'a' });
  await flush();
  assert.equal(a.getSnapshot().run, undefined);
  store.dispose();
});

test('switching sessions cannot display the previous session or its late response', async () => {
  const old = deferred();
  const store = createRunStore(id => id === 'a' ? old.promise : Promise.resolve({ id: 'b' }), () => {}, 60000);
  const a = store.forSession('a');
  const stopA = a.subscribe(() => {});
  stopA();
  const b = store.forSession('b');
  const stopB = b.subscribe(() => {});
  await flush();
  old.resolve({ id: 'a' });
  await flush();
  assert.equal(a.getSnapshot().run, undefined);
  assert.equal(b.getSnapshot().run.id, 'b');
  stopB(); store.dispose();
});

test('a late poll cannot overwrite adoption and duplicate actions are not submitted', async () => {
  const read = deferred(), write = deferred();
  let calls = 0;
  const store = createRunStore(() => read.promise, () => { calls++; return write.promise; }, 60000);
  const entry = store.forSession('a');
  const stop = entry.subscribe(() => {});
  const action = entry.action('adopt');
  await entry.action('adopt');
  assert.equal(calls, 1);
  write.resolve({ adopted: true });
  await action;
  read.resolve({ adopted: false });
  await flush();
  assert.equal(entry.getSnapshot().run.adopted, true);
  assert.equal(entry.getSnapshot().busy, false);
  stop(); store.dispose();
});

test('unloading suppresses late actions and UI navigation', async () => {
  const write = deferred();
  const store = createRunStore(() => {}, () => write.promise);
  const entry = store.forSession('a');
  const action = entry.action('adopt');
  store.dispose();
  write.resolve({ adopted: true });
  assert.equal(await action, undefined);
  assert.equal(entry.getSnapshot().run, undefined);
});

test('failed action retains the current result and reports its reason', async () => {
  const store = createRunStore(async () => ({ id: 'a' }), async () => { throw new Error('source changed'); }, 60000);
  const entry = store.forSession('a');
  const stop = entry.subscribe(() => {});
  await flush();
  await entry.action('adopt');
  assert.equal(entry.getSnapshot().run.id, 'a');
  assert.equal(entry.getSnapshot().error, 'source changed');
  assert.equal(entry.getSnapshot().busy, false);
  stop(); store.dispose();
});

test('result belongs only to the closed turn that started the exploration', () => {
  const run = { createdAt: new Date(1500).toISOString() };
  const turn = { status: 'closed', start: { time: 1000 }, end: { time: 2000 } };
  assert.equal(ownsRun(turn, run), true);
  assert.equal(ownsRun({ ...turn, start: { time: 2001 }, end: { time: 3000 } }, run), false);
  assert.equal(ownsRun({ ...turn, status: 'open' }, run), false);
  assert.equal(ownsRun({ status: 'closed' }, run), false);
  assert.equal(ownsRun(turn, { createdAt: 'invalid' }), false);
});

test('adoption only collapses its own visible sidebar, never another session or tab', () => {
  let session = 'a', tab = 'sla', expanded = true, toggles = 0;
  const sidebar = { mounted: { getSnapshot: () => session }, active: () => ({ id: tab }), isExpanded: () => expanded, toggleExpanded: () => { toggles++; } };
  session = 'b'; collapseAdoptedPanel(sidebar, 'a', 'sla');
  session = 'a'; tab = 'file'; collapseAdoptedPanel(sidebar, 'a', 'sla');
  tab = 'sla'; expanded = false; collapseAdoptedPanel(sidebar, 'a', 'sla');
  assert.equal(toggles, 0);
  expanded = true; collapseAdoptedPanel(sidebar, 'a', 'sla');
  assert.equal(toggles, 1);
});
