import { z } from 'zod';
import { filesSchema } from './data.js';
import type { Artifact, ArtifactInput, Run } from './data.js';
const filePayloadSchema = z.object({ directory: z.string(), files: filesSchema });
export function filePayload(artifact: ArtifactInput) {
  if (artifact.kind !== 'files') throw new Error('需要文件制品');
  return filePayloadSchema.parse(artifact.payload);
}
import { createHash } from 'node:crypto';
import { inventory, changedFiles } from './workspace.js';
import { sealArtifact } from './kernel.js';

export async function fileArtifact(run: Run, dir: string, trial = 0, parentId: string | null = null) {
  const files = await inventory(dir);
  const digest = createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  const existing = run.artifacts.find(a => a.revision === run.revision && a.trial === trial && a.kind === 'files' && filePayload(a).directory === dir);
  if (existing) {
    if (existing.digest !== digest) throw new Error('已封存候选内容已改变，未接受结果');
    return structuredClone(existing);
  }
  return sealArtifact(run, { kind: 'files', digest, payload: { directory: dir, files }, parentId, trial });
}

export async function verifyFileArtifact(artifact: Artifact) {
  if (changedFiles(filePayload(artifact).files, await inventory(filePayload(artifact).directory)).length) throw new Error('复验后候选内容已改变，未接受结果');
}
