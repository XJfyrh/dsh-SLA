import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files = ['client.js'];
for (const dir of ['src', 'extensions', 'scripts']) {
  for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isFile() && /\.(m?js)$/.test(entry.name)) files.push(dir + '/' + entry.name);
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Syntax checked ${files.length} JavaScript files`);
