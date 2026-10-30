import assert from 'node:assert/strict';
import { test } from 'node:test';
import { object } from './state-fixtures.ts';

async function loadExample(directory: string) {
  const module: unknown = await import(new URL(`../examples/${directory}/index.js`, import.meta.url).href);
  const duplicates = object(module).duplicates;
  assert.ok(typeof duplicates === 'function');
  return (values: number[]): unknown => duplicates(values);
}
const baseline = await loadExample('duplicates-baseline');
const adopted = await loadExample('duplicates');

test('adopted example preserves overridden array iteration', () => {
  const input = [1, 1];
  input[Symbol.iterator] = function* () { yield 2; yield 2; return undefined; };
  assert.deepEqual(adopted(input), baseline(input));
  assert.deepEqual(adopted(input), [2]);
});
