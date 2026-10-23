import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicates as baseline } from '../examples/duplicates-baseline/index.js';
import { duplicates as adopted } from '../examples/duplicates/index.js';

test('adopted example preserves overridden array iteration', () => {
  const input = [1, 1];
  input[Symbol.iterator] = function* () { yield 2; yield 2; };
  assert.deepEqual(adopted(input), baseline(input));
  assert.deepEqual(adopted(input), [2]);
});
