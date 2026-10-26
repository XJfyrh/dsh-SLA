import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { adopt, recoverAdoption, snapshot } from '../src/workspace.js';

async function adoptionFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sla-adoption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  await mkdir(cwd);
  for (const name of ['a', 'b', 'c']) await writeFile(path.join(cwd, name + '.txt'), 'original-' + name);
  const baselineDir = path.join(root, 'initial'), candidate = path.join(root, 'candidate');
  const sourceFiles = await snapshot(cwd, baselineDir);
  await snapshot(cwd, candidate);
  for (const name of ['a', 'b']) await writeFile(path.join(candidate, name + '.txt'), 'candidate-' + name);
  return { root, cwd, sourceFiles, baselineDir, best: { dir: candidate }, adopted: false };
}

test('adoption and recovery accept an equivalent noncanonical root spelling', async t => {
  const run = await adoptionFixture(t);
  run.cwd += path.sep + '.';
  await adopt(run);
  assert.equal(await readFile(path.join(run.cwd, 'a.txt'), 'utf8'), 'candidate-a');
  await recoverAdoption(run);
  assert.equal(run.adopted, true);
  assert.equal(run.adoptionPending, false);
});

test('adoption rejects a linked ancestor before requesting a write', async t => {
  const run = await adoptionFixture(t);
  const original = run.cwd;
  const alias = path.join(run.root, 'linked-parent');
  await symlink(run.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  run.cwd = path.join(alias, 'project');
  let calls = 0;
  await assert.rejects(adopt(run, async () => { calls++; }), /链接/);
  assert.equal(calls, 0);
  assert.equal(await readFile(path.join(original, 'a.txt'), 'utf8'), 'original-a');
});

test('adoption preserves source edits made during initial authorization', async t => {
  const run = await adoptionFixture(t);
  let calls = 0;
  await assert.rejects(adopt(run, async () => {
    if (++calls === 1) await writeFile(path.join(run.cwd, 'a.txt'), 'user edit');
  }), /原项目已修改/);
  assert.equal(await readFile(path.join(run.cwd, 'a.txt'), 'utf8'), 'user edit');
  assert.equal(await readFile(path.join(run.cwd, 'b.txt'), 'utf8'), 'original-b');
});

test('per-file authorization rechecks source files outside the write set', async t => {
  const run = await adoptionFixture(t);
  let calls = 0;
  await assert.rejects(adopt(run, async () => {
    if (++calls === 2) await writeFile(path.join(run.cwd, 'c.txt'), 'user edit');
  }), /原项目已修改/);
  assert.equal(await readFile(path.join(run.cwd, 'a.txt'), 'utf8'), 'original-a');
  assert.equal(await readFile(path.join(run.cwd, 'c.txt'), 'utf8'), 'user edit');
});

test('per-file authorization rejects new source files and rolls back completed writes', async t => {
  const run = await adoptionFixture(t);
  let calls = 0;
  await assert.rejects(adopt(run, async () => {
    if (++calls === 3) await writeFile(path.join(run.cwd, 'new-user-file.txt'), 'user addition');
  }), /原项目已修改/);
  assert.equal(await readFile(path.join(run.cwd, 'a.txt'), 'utf8'), 'original-a');
  assert.equal(await readFile(path.join(run.cwd, 'b.txt'), 'utf8'), 'original-b');
  assert.equal(await readFile(path.join(run.cwd, 'new-user-file.txt'), 'utf8'), 'user addition');
  await recoverAdoption(run);
  assert.equal(run.adoptionPending, false);
});

test('adopting ignore rules preserves previously ignored user files', async t => {
  const run = await adoptionFixture(t);
  await promisify(execFile)('git', ['init', '--quiet', run.cwd], { windowsHide: true });
  await writeFile(path.join(run.cwd, '.gitignore'), 'private.txt\n');
  await writeFile(path.join(run.cwd, 'private.txt'), 'user data');
  run.baselineDir = path.join(run.root, 'git-initial');
  run.sourceFiles = await snapshot(run.cwd, run.baselineDir);
  run.best.dir = path.join(run.root, 'git-candidate');
  await snapshot(run.cwd, run.best.dir);
  await writeFile(path.join(run.best.dir, '.gitignore'), '');
  await adopt(run);
  assert.equal(await readFile(path.join(run.cwd, '.gitignore'), 'utf8'), '');
  assert.equal(await readFile(path.join(run.cwd, 'private.txt'), 'utf8'), 'user data');
  await recoverAdoption(run);
  assert.equal(run.adopted, true);
});

test('adoption cannot write a new file through a root replaced during authorization', async t => {
  const run = await adoptionFixture(t);
  const outside = path.join(run.root, 'outside');
  await snapshot(run.cwd, outside);
  run.best.dir = path.join(run.root, 'new-file-candidate');
  await snapshot(run.cwd, run.best.dir);
  await writeFile(path.join(run.best.dir, 'new.txt'), 'candidate new file');
  let calls = 0;
  await assert.rejects(adopt(run, async () => {
    if (++calls === 1) {
      await rename(run.cwd, path.join(run.root, 'moved-project'));
      await symlink(outside, run.cwd, process.platform === 'win32' ? 'junction' : 'dir');
    }
  }), /链接/);
  await assert.rejects(lstat(path.join(outside, 'new.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(outside, 'a.txt'), 'utf8'), 'original-a');
});

test('adoption rolls back its own writes without overwriting untouched user files', async t => {
  const run = await adoptionFixture(t);
  let calls = 0;
  await assert.rejects(adopt(run, async () => {
    if (++calls === 3) {
      await writeFile(path.join(run.cwd, 'b.txt'), 'user edit');
      throw new Error('write permission withdrawn');
    }
  }), /permission withdrawn/);
  assert.equal(await readFile(path.join(run.cwd, 'a.txt'), 'utf8'), 'original-a');
  assert.equal(await readFile(path.join(run.cwd, 'b.txt'), 'utf8'), 'user edit');
  await recoverAdoption(run);
  assert.equal(run.adoptionPending, false);
});

test('rollback preserves edits to an already written file and recovery holds ambiguity', async t => {
  const run = await adoptionFixture(t);
  let calls = 0;
  await assert.rejects(adopt(run, async () => {
    if (++calls === 3) {
      await writeFile(path.join(run.cwd, 'a.txt'), 'user edit after write');
      throw new Error('write permission withdrawn');
    }
  }), /permission withdrawn/);
  assert.equal(await readFile(path.join(run.cwd, 'a.txt'), 'utf8'), 'user edit after write');
  assert.equal(await readFile(path.join(run.cwd, 'b.txt'), 'utf8'), 'original-b');
  await recoverAdoption(run);
  assert.equal(run.adoptionPending, true);
  assert.equal(run.status, 'blocked');
});
