import { createHash } from 'node:crypto';
import { jsonValue } from './kernel.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function jsonArtifact(value) {
  const payload = canonical(jsonValue(value));
  return { kind: 'json', digest: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), payload };
}

export function verifyJsonArtifact(artifact) {
  if (artifact.kind !== 'json' || jsonArtifact(artifact.payload).digest !== artifact.digest) throw new Error('JSON 制品内容身份不一致');
}
