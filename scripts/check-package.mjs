import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const destination = path.join(root, 'artifacts', 'package');
await mkdir(destination, { recursive: true });
const npm = (args, cwd = root) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
// The archive itself is subsequently installed outside this checkout.
const [pack] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', destination]));
const files = new Set(pack.files.map(file => file.path));
assert.equal(manifest.private, undefined);
assert.equal(manifest.license, 'MIT');
for (const required of ['LICENSE', 'README.md', 'cordis.patch.yml', 'dist/client.js', 'dist/src/host.js', 'dist/src/workflow.js', 'dist/src/workflow.d.ts']) assert.ok(files.has(required), required);
for (const file of files) {
  assert.ok(!/^(src|extensions|artifacts|node_modules|research|test|scripts|\.github)\//.test(file) && !/(^|\/)\.env/.test(file), file);
  if (file.endsWith('.map')) {
    const map = JSON.parse(await readFile(path.join(root, file), 'utf8'));
    assert.equal(map.sourcesContent.length, map.sources.length, file);
    assert.ok(map.sourcesContent.every(source => typeof source === 'string'), file);
  }
}
for (const target of Object.values(manifest.exports).flatMap(value => typeof value === 'string' ? [value] : Object.values(value))) {
  if (!target.includes('*')) assert.ok(files.has(target.replace(/^\.\//, '')), target);
}
assert.equal(manifest.exports['./extension'], undefined);
console.log(`Package checked: ${pack.name}@${pack.version}, ${files.size} files, ${pack.size} compressed bytes`);
const consumer = await mkdtemp(path.join(os.tmpdir(), 'sla-package-consumer-'));
await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'sla-package-consumer', private: true, type: 'module' }));
console.log(`Installing production package in ${consumer}`);
npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', path.join(destination, pack.filename)], consumer);
await writeFile(path.join(consumer, 'runtime.mjs'), `
import assert from 'node:assert/strict';
import { readFile, realpath, access } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const consumerRoot = await realpath(process.cwd());
const entries = ${JSON.stringify(Object.keys(manifest.exports).filter(key => key !== './client' && typeof manifest.exports[key] === 'object'))};
for (const key of entries) {
  const specifier = key === '.' ? 'dsh-sla' : 'dsh-sla/' + key.slice(2);
  const resolved = await realpath(fileURLToPath(import.meta.resolve(specifier)));
  const relative = path.relative(consumerRoot, resolved);
  assert.ok(!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep), resolved);
  assert.ok(Object.keys(await import(specifier)).length, specifier);
}
const source = await readFile(new URL(import.meta.resolve('dsh-sla/client')), 'utf8');
let bundle;
vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { bundle = value; } } } });
assert.equal(bundle.id, 'dsh-sla');
const plugin = bundle.factory(() => ({}));
assert.equal(typeof plugin.apply, 'function');
for (const key of ['dsh-sla/locale/en.json', 'dsh-sla/locale/zh.json', 'dsh-sla/icon']) await access(fileURLToPath(import.meta.resolve(key)));
for (const name of ['typescript', 'esbuild']) assert.throws(() => import.meta.resolve(name));
console.log('All public runtime exports loaded; browser ModuleLoader registered; no TypeScript or esbuild installed');
`);
const runtime = execFileSync(process.execPath, ['runtime.mjs'], { cwd: consumer, encoding: 'utf8', windowsHide: true });
console.log(runtime.trim());
// Extension authors need the same pinned DSH development type graph as plugin authors.
// This is deliberately after the production-only runtime assertion above.
const consumerManifest = JSON.parse(await readFile(path.join(consumer, 'package.json'), 'utf8'));
consumerManifest.devDependencies = manifest.devDependencies;
await writeFile(path.join(consumer, 'package.json'), JSON.stringify(consumerManifest, null, 2));
npm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
await writeFile(path.join(consumer, 'workflow-types.ts'), await readFile(path.join(root, 'test/workflow-types.ts')));
await writeFile(path.join(consumer, 'counter.ts'), await readFile(path.join(root, 'examples/extensions/counter.ts')));
await writeFile(path.join(consumer, 'client-types.ts'), await readFile(path.join(root, 'test/client-types.ts')));
await writeFile(path.join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2024', module: 'NodeNext', moduleResolution: 'NodeNext', types: ['node'] }, include: ['workflow-types.ts', 'counter.ts'] }));
await writeFile(path.join(consumer, 'tsconfig.client.json'), JSON.stringify({ extends: './tsconfig.json', include: ['client-types.ts'] }));
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', '.'], { cwd: consumer, stdio: 'inherit', windowsHide: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.client.json'], { cwd: consumer, stdio: 'inherit', windowsHide: true });
await writeFile(path.join(destination, 'verification.json'), JSON.stringify({ passed: true, pack, consumer, runtime: runtime.trim(), generatedTypes: 'positive example and expected errors passed outside source checkout' }, null, 2));
console.log('Installed declarations: strict positive example and all expected type errors passed');
