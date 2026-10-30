import assert from 'node:assert/strict';
import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

function record(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
}
const consumerRoot = await realpath(process.cwd());
for (const key of process.argv.slice(2)) {
  const specifier = key === '.' ? 'dsh-sla' : 'dsh-sla/' + key.slice(2);
  const resolved = await realpath(fileURLToPath(import.meta.resolve(specifier)));
  const relative = path.relative(consumerRoot, resolved);
  assert.ok(!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep), resolved);
  const module: unknown = await import(specifier);
  record(module);
  assert.ok(Object.keys(module).length, specifier);
}
const source = await readFile(new URL(import.meta.resolve('dsh-sla/client')), 'utf8');
let bundle: unknown;
vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value: unknown) { bundle = value; } } } });
record(bundle);
assert.equal(bundle.id, 'dsh-sla');
assert.ok(typeof bundle.factory === 'function');
const plugin: unknown = bundle.factory(() => ({}));
record(plugin);
assert.equal(typeof plugin.apply, 'function');
for (const key of ['dsh-sla/locale/en.json', 'dsh-sla/locale/zh.json', 'dsh-sla/icon']) await access(fileURLToPath(import.meta.resolve(key)));
for (const name of ['typescript', 'esbuild']) assert.throws(() => import.meta.resolve(name));
console.log('All public runtime exports loaded; browser ModuleLoader registered; no TypeScript or esbuild installed');
