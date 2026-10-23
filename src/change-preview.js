import { readFile, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { inventory, changedFiles } from './workspace.js';

// Read only the run's retained snapshots. The browser never supplies file paths.
export async function changePreview(run) {
  const identity = { runId: run?.id, trial: run?.best?.trial, criteriaVersion: run?.criteriaVersion ?? run?.revision };
  if (!run?.best?.trial || !run.baselineDir || !run.best.dir) return { ...identity, files: [] };
  const before = await inventory(run.baselineDir), after = await inventory(run.best.dir);
  const expected = run.best.files ?? run.trials?.find(t => t.number === run.best.trial)?.files;
  if (!run.sourceFiles || !expected) throw new Error('此历史记录缺少文件校验信息，请查看原始补丁。');
  if (changedFiles(run.sourceFiles, before).length || changedFiles(expected, after).length) throw new Error('快照内容已改变，不能将当前文件展示为已验证候选。请查看原始补丁。');
  let remaining = 512 * 1024;
  async function text(root, name, hash) {
    if (!hash) return null;
    const file = path.resolve(root, name);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(file) !== file) throw new Error('快照文件路径已改变');
    if (stat.size > 128 * 1024 || stat.size > remaining) return { omitted: 'large' };
    const bytes = await readFile(file);
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('读取时快照内容已改变，请重新打开改动预览。');
    remaining -= bytes.length;
    if (bytes.includes(0)) return { omitted: 'binary' };
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return { omitted: 'binary' }; }
  }
  const files = [];
  for (const name of changedFiles(before, after)) {
    const oldText = await text(run.baselineDir, name, before[name]);
    const newText = await text(run.best.dir, name, after[name]);
    const omitted = oldText?.omitted ?? newText?.omitted;
    files.push({ path: name, kind: !before[name] ? 'added' : !after[name] ? 'deleted' : 'modified',
      ...(omitted ? { omitted } : { oldText, newText: newText ?? '' }) });
  }
  return { ...identity, files };
}
