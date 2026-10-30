import { execFileSync } from 'node:child_process';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, sourceMapSchema } from './json.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'dist');
if (path.dirname(output) !== path.resolve(root)) throw new Error('Unexpected build output path');
await rm(output, { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit', windowsHide: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.client.json'], { cwd: root, stdio: 'inherit', windowsHide: true });
await import('./build-client.ts');

// Declaration maps are useful in an installed package too: embed their original TS.
for (const entry of await readdir(output, { recursive: true })) {
  if (!entry.endsWith('.d.ts.map')) continue;
  const file = path.join(output, entry);
  const map = sourceMapSchema.parse(await readJson(file));
  map.sourcesContent = await Promise.all(map.sources.map(source => readFile(path.resolve(path.dirname(file), source), 'utf8')));
  await writeFile(file, JSON.stringify(map));
}
