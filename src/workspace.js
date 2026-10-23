import { readdir, readFile, writeFile, mkdir, copyFile, lstat, realpath, rm, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const excluded = new Set(['.git', '.sla', '.dsh', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'artifacts']);
const safe = p => !p.split('/').some(x => excluded.has(x) || x === '..') && !/(^|\/)\.env($|\.)/.test(p);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function writeJournal(root, data) {
  const temporary = path.join(root, 'adoption-' + randomUUID() + '.tmp');
  await writeFile(temporary, JSON.stringify(data, null, 2));
  await rename(temporary, path.join(root, 'adoption.json'));
}

export async function inventory(root) {
  root = await realpath(root);
  let names;
  try {
    const { stdout } = await exec('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    names = [...new Set(stdout.split('\0').filter(Boolean))].filter(safe);
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('需要安装 Git 才能建立项目快照。');
    if (!String(e.stderr).includes('not a git repository')) throw e;
    names = [];
    async function walk(dir, prefix = '') {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const rel = prefix + entry.name;
        if (!safe(rel)) continue;
        if (entry.isSymbolicLink()) throw new Error(`首版不复制符号链接：${rel}`);
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel + '/');
        else if (entry.isFile()) names.push(rel);
        if (names.length > 15000) throw new Error('项目超过 15000 个文件，请缩小到一个子项目。');
      }
    }
    await walk(root);
  }
  const files = {};
  let bytes = 0;
  for (const name of names.sort()) {
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep)) throw new Error('项目路径越界');
    let stat;
    try { stat = await lstat(file); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`首版只接受普通文件：${name}`);
    if (await realpath(file) !== file) throw new Error(`项目包含链接路径：${name}`);
    bytes += stat.size;
    if (bytes > 100 * 1024 * 1024 || Object.keys(files).length >= 15000) throw new Error('快照超过首版的 100 MiB / 15000 文件上限，请选择子项目。');
    files[name] = digest(await readFile(file));
  }
  return files;
}

export async function snapshot(source, target) {
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

export function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(name => before[name] !== after[name]);
}

export async function candidateDiff(before, after) {
  let text;
  try {
    ({ stdout: text } = await exec('git', ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', before, after], { maxBuffer: 1024 * 1024, windowsHide: true }));
  } catch (e) {
    if (e.code !== 1) return '改动较大或无法生成预览，请在证据目录比较初始快照与候选。';
    text = e.stdout;
  }
  return text.length > 64000 ? text.slice(0, 64000) + '\n…预览已截断，完整文件见证据目录。' : text;
}

export async function copyEvaluation(source, target) {
  const from = path.join(source, '.sla');
  const files = {}, budget = { bytes: 0, count: 0 };
  await mkdir(path.join(target, '.sla'), { recursive: true });
  async function copy(dir, rel = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('评价依据不允许符号链接');
      const name = path.join(rel, entry.name), dest = path.join(target, '.sla', name);
      if (entry.isDirectory()) { await mkdir(dest, { recursive: true }); await copy(path.join(dir, entry.name), name); }
      else {
        if (!entry.isFile()) throw new Error('评价依据只接受普通文件');
        const bytes = await readFile(path.join(dir, entry.name));
        budget.bytes += bytes.length; budget.count++;
        if (budget.bytes > 10 * 1024 * 1024 || budget.count > 1000) throw new Error('评价依据超过 10 MiB / 1000 文件上限');
        files[name.split(path.sep).join('/')] = digest(bytes);
        await writeFile(dest, bytes);
      }
    }
  }
  await copy(from);
  return files;
}

export async function verifyEvaluation(root, files) {
  const base = path.join(root, '.sla');
  for (const [name, hash] of Object.entries(files)) {
    if (path.isAbsolute(name) || name.split(/[\\/]/).some(part => part === '..' || !part)) throw new Error('固定评价依据路径无效');
    let current = base;
    for (const part of ['', ...name.split('/')]) {
      if (part) current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('固定评价依据不允许符号链接');
    }
    if (digest(await readFile(current)) !== hash) throw new Error('固定评价依据内容被修改：' + name);
  }
}

export async function adopt(run, authorize = async () => {}) {
  const before = run.sourceFiles;
  const after = await inventory(run.best.dir);
  const current = await inventory(run.cwd);
  if (changedFiles(before, current).length) throw new Error('原项目已修改，未采用。请查看候选后手动合并。');
  const names = changedFiles(before, after);
  for (const name of names) {
    if (!before[name]) {
      try { await lstat(path.join(run.cwd, name)); throw new Error(`原项目存在未纳入快照的文件 ${name}，未采用。`); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (current[name] !== before[name]) throw new Error(`原项目已修改 ${name}，未采用。请查看候选后手动合并。`);
    // A newly created parent must not traverse a link outside the selected root.
    let dir = path.dirname(path.join(run.cwd, name));
    while (dir !== run.cwd) {
      try { if ((await lstat(dir)).isSymbolicLink()) throw new Error(`目标路径包含链接：${name}`); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      dir = path.dirname(dir);
    }
  }
  const backups = new Map();
  for (const name of names) backups.set(name, before[name] ? await readFile(path.join(run.cwd, name)) : null);
  const journal = { state: 'applying', files: names, before, after, backupDirectory: run.baselineDir };
  await authorize();
  await writeJournal(run.root, journal);
  try {
    for (const name of names) {
      await authorize();
      const dest = path.join(run.cwd, name);
      if (after[name]) {
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(path.join(run.best.dir, name), dest);
      } else await rm(dest);
    }
    for (const name of names) {
      const dest = path.join(run.cwd, name);
      if (after[name]) {
        if (digest(await readFile(dest)) !== after[name]) throw new Error(`采用后文件校验失败：${name}`);
      } else {
        try { await lstat(dest); throw new Error(`采用后文件仍存在：${name}`); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    }
  } catch (error) {
    for (const [name, bytes] of backups) {
      const dest = path.join(run.cwd, name);
      if (bytes === null) await rm(dest, { force: true });
      else await writeFile(dest, bytes);
    }
    await writeJournal(run.root, { ...journal, state: 'rolled-back' });
    throw error;
  }
  await writeJournal(run.root, { ...journal, state: 'applied' });
  return names;
}

export async function recoverAdoption(run) {
  if (run.adopted && !run.adoptionPending) return;
  let journal;
  try { journal = JSON.parse(await readFile(path.join(run.root, 'adoption.json'), 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') { run.adoptionPending = false; return; }
    run.adoptionPending = true; run.status = 'blocked';
    run.message = '采用记录无法读取，请保留 adoption.json 并对照原始快照检查文件：' + e.message;
    return;
  }
  if (!Array.isArray(journal.files) || journal.files.some(name => typeof name !== 'string' || !safe(name) || path.isAbsolute(name) || name.includes('\\'))) {
    run.adoptionPending = true; run.status = 'blocked'; run.message = '采用记录中的文件路径无效，需人工核对。'; return;
  }
  if (journal.state === 'rolled-back') { run.adoptionPending = false; return; }
  const matches = async expected => {
    if (!expected) return false;
    for (const name of journal.files) {
      let hash;
      try {
        const file = path.join(run.cwd, name);
        if (await realpath(file) !== file) return false;
        hash = digest(await readFile(file));
      } catch (e) { if (e.code !== 'ENOENT') return false; }
      if (hash !== expected[name]) return false;
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
