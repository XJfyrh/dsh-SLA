export function message(error: unknown): string {
  return String(isRecord(error) ? error.message ?? error : error);
}
export function hasCode(error: unknown, code: string | number): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function errorFact(error: unknown, key: string): unknown {
  return isRecord(error) ? error[key] : undefined;
}
export function required<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null) throw new Error('探索状态缺少 ' + label);
  return value;
}
