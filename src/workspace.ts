import { z } from 'zod';
import { filesSchema, fileHash } from './data.js';
import type { FileInventory, Run } from './data.js';
import { hasCode, errorFact, required } from './errors.js';
import { message } from './errors.js';
import { readdir, readFile, writeFile, mkdir, lstat, realpath, rm, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const adoptionJournalSchema = z.object({ state: z.enum(['applying', 'rolled-back', 'applied']), files: z.array(z.string()), before: filesSchema.optional(), after: filesSchema.optional(), backupDirectory: z.string().optional(), error: z.string().optional(), rollbackErrors: z.array(z.string()).optional() });
type AdoptionJournal = z.infer<typeof adoptionJournalSchema>;
const exec = promisify(execFile);
const excluded = new Set(['.git', '.sla', '.dsh', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'artifacts']);
const safe = (p: string) => !p.split('/').some(x => excluded.has(x) || x === '..') && !/(^|\/)\.env($|\.)/.test(p);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function writeJournal(root: string, data: AdoptionJournal) {
  const temporary = path.join(root, 'adoption-' + randomUUID() + '.tmp');
  await writeFile(temporary, JSON.stringify(data, null, 2));
  await rename(temporary, path.join(root, 'adoption.json'));
}

export async function inventory(root: string): Promise<FileInventory> {
  root = await realpath(root);
  let names: string[];
  try {
    const { stdout } = await exec('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    names = [...new Set(stdout.split('\0').filter(Boolean))].filter(safe);
  } catch (e) {
    if (hasCode(e, 'ENOENT')) throw new Error('需要安装 Git 才能建立项目快照。');
    if (!String(errorFact(e, 'stderr')).includes('not a git repository')) throw e;
    names = [];
    async function walk(dir: string, prefix = '') {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const rel = prefix + entry.name;
        if (!safe(rel)) continue;
        if (entry.isSymbolicLink()) throw new Error(`项目快照不复制符号链接：${rel}`);
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel + '/');
        else if (entry.isFile()) names.push(rel);
        if (names.length > 15000) throw new Error('项目超过 15000 个文件，请缩小到一个子项目。');
      }
    }
    await walk(root);
  }
  const files: Array<[string, string]> = [];
  let bytes = 0;
  for (const name of names.sort()) {
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep)) throw new Error('项目路径越界');
    let stat;
    try { stat = await lstat(file); } catch (e) { if (hasCode(e, 'ENOENT')) continue; throw e; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`项目快照只接受普通文件：${name}`);
    if (await realpath(file) !== file) throw new Error(`项目包含链接路径：${name}`);
    bytes += stat.size;
    if (bytes > 100 * 1024 * 1024 || files.length >= 15000) throw new Error('快照超过 100 MiB / 15000 文件上限，请选择子项目。');
    files.push([name, digest(await readFile(file))]);
  }
  return Object.fromEntries(files);
}

export async function snapshot(source: string, target: string) {
  const files = await inventory(source);
  await mkdir(target, { recursive: true });
  for (const [name, hash] of Object.entries(files)) {
    const bytes = await readFile(path.join(source, name));
    if (digest(bytes) !== hash) throw new Error(`创建快照时文件发生变化：${name}`);
    const dest = path.join(target, name);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
  }
  return files;
}

export function changedFiles(before: FileInventory, after: FileInventory) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(name => fileHash(before, name) !== fileHash(after, name));
}

export async function candidateDiff(before: string, after: string) {
  let text;
  try {
    ({ stdout: text } = await exec('git', ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', before, after], { maxBuffer: 1024 * 1024, windowsHide: true }));
  } catch (e) {
    if (!hasCode(e, 1)) return '改动较大或无法生成预览，请在证据目录比较初始快照与候选。';
    const stdout = errorFact(e, 'stdout');
    if (typeof stdout !== 'string') throw e;
    text = stdout;
  }
  return text.length > 64000 ? text.slice(0, 64000) + '\n…预览已截断，完整文件见证据目录。' : text;
}

export async function copyEvaluation(source: string, target: string) {
  const from = path.join(source, '.sla');
  const files: Array<[string, string]> = []; const budget = { bytes: 0, count: 0 };
  await mkdir(path.join(target, '.sla'), { recursive: true });
  async function copy(dir: string, rel = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('评价依据不允许符号链接');
      const name = path.join(rel, entry.name), dest = path.join(target, '.sla', name);
      if (entry.isDirectory()) { await mkdir(dest, { recursive: true }); await copy(path.join(dir, entry.name), name); }
      else {
        if (!entry.isFile()) throw new Error('评价依据只接受普通文件');
        const bytes = await readFile(path.join(dir, entry.name));
        budget.bytes += bytes.length; budget.count++;
        if (budget.bytes > 10 * 1024 * 1024 || budget.count > 1000) throw new Error('评价依据超过 10 MiB / 1000 文件上限');
        files.push([name.split(path.sep).join('/'), digest(bytes)]);
        await writeFile(dest, bytes);
      }
    }
  }
  await copy(from);
  return Object.fromEntries(files);
}

export async function verifyEvaluation(root: string, files: FileInventory) {
  const base = path.join(root, '.sla');
  for (const name of Object.keys(files)) {
    if (path.isAbsolute(name) || name.split(/[\\/]/).some(part => part === '..' || !part)) throw new Error('固定评价依据路径无效');
  }
  const seen = new Set();
  async function verify(dir: string, prefix = '') {
    if ((await lstat(dir)).isSymbolicLink()) throw new Error('固定评价依据不允许符号链接');
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name, current = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('固定评价依据不允许符号链接');
      if (entry.isDirectory()) { await verify(current, name + '/'); continue; }
      if (!entry.isFile()) throw new Error('固定评价依据只接受普通文件');
      if (!Object.hasOwn(files, name)) throw new Error('固定评价依据新增了文件：' + name);
      if (digest(await readFile(current)) !== files[name]) throw new Error('固定评价依据内容被修改：' + name);
      seen.add(name);
    }
  }
  await verify(base);
  for (const name of Object.keys(files)) if (!seen.has(name)) throw new Error('固定评价依据文件缺失：' + name);
}

export async function canonicalRoot(root: string) {
  // Accept alternate spellings (including Windows short paths) without following linked ancestors.
  let dir = path.resolve(root);
  for (;;) {
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('目标根目录包含链接或已改变');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return realpath(root);
}

export async function adopt(run: Run, authorize: () => Promise<void> = async () => {}, expectedCandidateFiles?: FileInventory) {
  run = { ...run, cwd: await canonicalRoot(run.cwd) };
  const before = required(run.sourceFiles, '原始文件清单');
  const bestDir = required(run.best?.dir, '候选目录');
  const after = await inventory(bestDir);
  if (expectedCandidateFiles && changedFiles(expectedCandidateFiles, after).length) throw new Error('复验后候选内容已改变，未采用');
  const current = await inventory(run.cwd);
  if (changedFiles(before, current).length) throw new Error('原项目已修改，未采用。请查看候选后手动合并。');
  const names = changedFiles(before, after);
  const sourceHash = async (name: string) => {
    const rootStat = await lstat(run.cwd);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(run.cwd) !== run.cwd) throw new Error('目标根目录包含链接或已改变');
    // A newly created parent must not traverse a link outside the selected root.
    let dir = path.dirname(path.join(run.cwd, name));
    while (dir !== run.cwd) {
      try { if ((await lstat(dir)).isSymbolicLink()) throw new Error(`目标路径包含链接：${name}`); }
      catch (e) { if (!hasCode(e, 'ENOENT')) throw e; }
      dir = path.dirname(dir);
    }
    try {
      const file = path.join(run.cwd, name), stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`目标路径不是普通文件：${name}`);
      if (await realpath(file) !== file) throw new Error(`目标路径包含链接：${name}`);
      return digest(await readFile(file));
    } catch (e) { if (hasCode(e, 'ENOENT')) return undefined; throw e; }
  };
  for (const name of names) {
    if (!fileHash(before, name)) {
      try { await lstat(path.join(run.cwd, name)); throw new Error(`原项目存在未纳入快照的文件 ${name}，未采用。`); }
      catch (e) { if (!hasCode(e, 'ENOENT')) throw e; }
    }
    if (await sourceHash(name) !== fileHash(before, name)) throw new Error(`原项目已修改 ${name}，未采用。请查看候选后手动合并。`);
  }
  const backups = new Map<string, Buffer | null>();
  for (const name of names) backups.set(name, fileHash(before, name) ? await readFile(path.join(run.cwd, name)) : null);
  const journal: AdoptionJournal = { state: 'applying', files: names, before, after, backupDirectory: run.baselineDir };
  await authorize();
  if (changedFiles(before, await inventory(run.cwd)).length) throw new Error('原项目已修改，未采用。请查看候选后手动合并。');
  await writeJournal(run.root, journal);
  const attempted = new Set<string>();
  try {
    for (const name of names) {
      const beforeAuthorization = await inventory(run.cwd);
      await authorize();
      if (changedFiles(beforeAuthorization, await inventory(run.cwd)).length) throw new Error('原项目已修改，未采用。请查看候选后手动合并。');
      if (await sourceHash(name) !== fileHash(before, name)) throw new Error(`原项目已修改 ${name}，未采用。请查看候选后手动合并。`);
      const dest = path.join(run.cwd, name);
      if (fileHash(after, name)) {
        const bytes = await readFile(path.join(bestDir, name));
        if (digest(bytes) !== fileHash(after, name)) throw new Error(`写回前候选文件已改变：${name}`);
        await mkdir(path.dirname(dest), { recursive: true });
        attempted.add(name);
        await writeFile(dest, bytes);
      } else { attempted.add(name); await rm(dest); }
    }
    // Check original paths directly: adopting .gitignore can change Git's inventory.
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (await sourceHash(name) !== fileHash(after, name)) throw new Error(`原项目已修改或采用后文件校验失败：${name}`);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const name of attempted) {
      try {
        const hash = await sourceHash(name);
        if (hash === fileHash(before, name)) continue;
        if (hash !== fileHash(after, name)) throw new Error(`采用期间文件再次改变，保留当前内容：${name}`);
        const bytes = backups.get(name), dest = path.join(run.cwd, name);
        if (bytes === null) await rm(dest, { force: true });
        else await writeFile(dest, required(bytes, '回滚副本'));
      } catch (rollbackError) { rollbackErrors.push(message(rollbackError)); }
    }
    await writeJournal(run.root, { ...journal, state: rollbackErrors.length ? 'applying' : 'rolled-back', error: message(error), rollbackErrors });
    throw error;
  }
  await writeJournal(run.root, { ...journal, state: 'applied' });
  return names;
}

export async function recoverAdoption(run: Run) {
  if (run.adopted && !run.adoptionPending) return;
  let journal: AdoptionJournal;
  try { journal = adoptionJournalSchema.parse(JSON.parse(await readFile(path.join(run.root, 'adoption.json'), 'utf8'))); }
  catch (e) {
    if (hasCode(e, 'ENOENT')) { run.adoptionPending = false; return; }
    run.adoptionPending = true; run.status = 'blocked';
    run.message = '采用记录无法读取，请保留 adoption.json 并对照原始快照检查文件：' + message(e);
    return;
  }
  if (!Array.isArray(journal.files) || journal.files.some(name => typeof name !== 'string' || !safe(name) || path.isAbsolute(name) || name.includes('\\'))) {
    run.adoptionPending = true; run.status = 'blocked'; run.message = '采用记录中的文件路径无效，需人工核对。'; return;
  }
  if (journal.state === 'rolled-back') { run.adoptionPending = false; return; }
  const matches = async (expected: FileInventory | undefined) => {
    if (!expected) return false;
    let cwd;
    try { cwd = await canonicalRoot(run.cwd); } catch { return false; }
    for (const name of journal.files) {
      let hash;
      try {
        const file = path.join(cwd, name);
        if (await realpath(file) !== file) return false;
        hash = digest(await readFile(file));
      } catch (e) { if (!hasCode(e, 'ENOENT')) return false; }
      if (hash !== fileHash(expected, name)) return false;
    }
    return true;
  };
  if (await matches(journal.after)) {
    run.adopted = true; run.adoptionPending = false; run.adoptedFiles = journal.files;
    run.status = 'completed';
    run.message = '恢复时已核验采用的文件内容。';
  } else if (await matches(journal.before)) {
    run.adoptionPending = false;
  } else {
    run.adoptionPending = true; run.status = 'blocked';
    run.message = '采用曾被中断，原项目可能已部分修改。请对照 adoption.json 与原始快照检查并手动合并。';
  }
}
