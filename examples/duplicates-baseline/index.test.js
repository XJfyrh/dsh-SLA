import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicates } from './index.js';
test('retains first repetition order', () => assert.deepEqual(duplicates([2, 1, 1, 2, 3, 1]), [1, 2]));
test('handles empty input', () => assert.deepEqual(duplicates([]), []));
test('uses SameValueZero and identity', () => {
  const a = {}, b = {};
  assert.deepEqual(duplicates([NaN, NaN, 0, -0, a, b, a]), [NaN, -0, a]);
});
