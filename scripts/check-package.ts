import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { packageSchema, parseJson, readJson, sourceMapSchema } from './json.ts';
const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = packageSchema.parse(await readJson(new URL('../package.json', import.meta.url)));
const exports = manifest.exports;
assert.ok(exports);
const npmPath = process.env.npm_execpath;
assert.ok(npmPath, 'Run this check through npm run check:package');
const destination = path.join(root, 'artifacts', 'package');
await mkdir(destination, { recursive: true });
const npm = (args: string[], cwd = root) => execFileSync(process.execPath, [npmPath, ...args], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
// The archive itself is subsequently installed outside this checkout.
const [pack] = z.array(z.looseObject({ name: z.string(), version: z.string(), filename: z.string(), size: z.number(), files: z.array(z.looseObject({ path: z.string() })) })).length(1).parse(parseJson(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', destination])));
const files = new Set(pack.files.map(file => file.path));
assert.equal(manifest.private, undefined);
assert.equal(manifest.license, 'MIT');
for (const required of ['LICENSE', 'README.md', 'cordis.patch.yml', 'dist/client.js', 'dist/src/host.js', 'dist/src/workflow.js', 'dist/src/workflow.d.ts']) assert.ok(files.has(required), required);
for (const file of files) {
  assert.ok(!/^(src|extensions|artifacts|node_modules|research|test|scripts|\.github)\//.test(file) && !/(^|\/)\.env/.test(file), file);
  if (file.endsWith('.map')) {
    const map = sourceMapSchema.parse(await readJson(path.join(root, file)));
    assert.ok(map.sourcesContent, file);
    assert.equal(map.sourcesContent.length, map.sources.length, file);
    assert.ok(map.sourcesContent.every(source => typeof source === 'string'), file);
  }
}
for (const target of Object.values(exports).flatMap(value => typeof value === 'string' ? [value] : Object.values(value))) {
  if (!target.includes('*')) assert.ok(files.has(target.replace(/^\.\//, '')), target);
}
assert.equal(exports['./extension'], undefined);
console.log(`Package checked: ${pack.name}@${pack.version}, ${files.size} files, ${pack.size} compressed bytes`);
const consumer = await mkdtemp(path.join(os.tmpdir(), 'sla-package-consumer-'));
await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'sla-package-consumer', private: true, type: 'module' }));
console.log(`Installing production package in ${consumer}`);
npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', path.join(destination, pack.filename)], consumer);
await writeFile(path.join(consumer, 'runtime.ts'), await readFile(new URL('./package-runtime.ts', import.meta.url)));
const entries = Object.keys(exports).filter(key => key !== './client' && typeof exports[key] === 'object');
const runtime = execFileSync(process.execPath, ['runtime.ts', ...entries], { cwd: consumer, encoding: 'utf8', windowsHide: true });
console.log(runtime.trim());
// Extension authors need the same pinned DSH development type graph as plugin authors.
// This is deliberately after the production-only runtime assertion above.
const consumerManifest = packageSchema.parse(await readJson(path.join(consumer, 'package.json')));
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
