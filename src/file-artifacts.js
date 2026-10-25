import { createHash } from 'node:crypto';
import { inventory, changedFiles } from './workspace.js';
import { sealArtifact } from './kernel.js';

export async function fileArtifact(run, dir, trial = 0, parentId = null) {
  const files = await inventory(dir);
  const digest = createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  const existing = run.artifacts.find(a => a.revision === run.revision && a.trial === trial && a.kind === 'files' && a.payload.directory === dir);
  if (existing) {
    if (existing.digest !== digest) throw new Error('已封存候选内容已改变，未接受结果');
    return structuredClone(existing);
  }
  return sealArtifact(run, { kind: 'files', digest, payload: { directory: dir, files }, parentId, trial });
}

export async function verifyFileArtifact(artifact) {
  if (changedFiles(artifact.payload.files, await inventory(artifact.payload.directory)).length) throw new Error('复验后候选内容已改变，未接受结果');
}
