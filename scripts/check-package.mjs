import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const [pack] = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', windowsHide: true }));
const files = new Set(pack.files.map(file => file.path));
assert.equal(manifest.private, undefined);
assert.equal(manifest.license, 'MIT');
for (const required of ['LICENSE', 'README.md', 'cordis.patch.yml', 'client.js', 'src/host.js', 'src/workflow.js', 'src/workflow.d.ts']) assert.ok(files.has(required), required);
for (const file of files) assert.ok(!/^(artifacts|node_modules|research|test|scripts|\.github)\//.test(file) && !/(^|\/)\.env/.test(file), file);
for (const target of Object.values(manifest.exports).flatMap(value => typeof value === 'string' ? [value] : Object.values(value))) {
  if (!target.includes('*')) assert.ok(files.has(target.replace(/^\.\//, '')), target);
}
assert.equal(manifest.exports['./extension'], undefined);
console.log(`Package checked: ${pack.name}@${pack.version}, ${files.size} files, ${pack.size} compressed bytes`);
