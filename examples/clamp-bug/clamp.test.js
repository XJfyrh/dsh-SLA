import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from './clamp.js';
test('retains numbers inside range', () => assert.equal(clamp(3, -5, 5), 3));
test('limits numbers outside range', () => { assert.equal(clamp(-9, -5, 5), -5); assert.equal(clamp(9, -5, 5), 5); });
test('rejects invalid bounds', () => assert.throws(() => clamp(2, 4, 1), RangeError));
test('rejects nonfinite input', () => assert.throws(() => clamp(NaN, -5, 5), TypeError));
