export function clamp(value, min, max) {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) throw new TypeError('finite numbers required');
  if (min > max) throw new RangeError('min must not exceed max');
  return Math.max(min, Math.min(max, value || min));
}
