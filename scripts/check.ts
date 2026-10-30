import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseJson } from './json.ts';

const compiled = new Set<string>();
for (const config of ['tsconfig.json', 'tsconfig.client.json', 'tsconfig.tools.json', 'tsconfig.probes.json', 'tsconfig.tests.json', 'tsconfig.client-tests.json', 'tsconfig.consumer.json', 'tsconfig.client-consumer.json']) {
  const effective = z.object({ compilerOptions: z.object({ strict: z.boolean(), noEmitOnError: z.boolean().optional(), skipLibCheck: z.boolean().optional() }) }).parse(parseJson(execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--showConfig', '-p', config], { encoding: 'utf8', windowsHide: true })));
  assert.equal(effective.compilerOptions.strict, true, config);
  if (!config.includes('consumer')) assert.equal(effective.compilerOptions.noEmitOnError, true, config);
  assert.ok(!effective.compilerOptions.skipLibCheck, config);
  const files = execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--listFilesOnly', '-p', config], { encoding: 'utf8', windowsHide: true });
  for (const file of files.trim().split(/\r?\n/)) compiled.add(path.resolve(file));
}
let count = 0;
for (const directory of ['src', 'extensions', 'scripts', 'test']) {
  for (const entry of await readdir(directory, { recursive: true })) {
    assert.ok(!/\.(m?js|d\.ts)$/.test(entry), `Implementation or handwritten declaration outside TS build: ${entry}`);
    if (!entry.endsWith('.ts')) continue;
    const file = path.join(directory, entry);
    assert.ok(compiled.has(path.resolve(file)), `Implementation missing from strict programs: ${file}`);
    const source = await readFile(file, 'utf8');
    assert.ok(!/@ts-(ignore|nocheck)\b/.test(source), `Suppressed implementation: ${file}`);
    count++;
  }
}
for (const directory of ['dist']) {
  for (const entry of await readdir(directory, { recursive: true })) {
    if (!/\.m?js$/.test(entry)) continue;
    execFileSync(process.execPath, ['--check', path.join(directory, entry)], { stdio: 'inherit', windowsHide: true });
  }
}
console.log(`All ${count} TS source, test and tooling files enter strict checking; emitted JS parses successfully`);
