import { readFile } from 'node:fs/promises';
import { z } from 'zod';

export async function readJson(file: string | URL): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}
export function parseJson(text: string): unknown { return JSON.parse(text); }
export const sourceMapSchema = z.looseObject({ sources: z.array(z.string()), sourcesContent: z.array(z.string()).optional() });
export const packageSchema = z.looseObject({
  name: z.string(), private: z.boolean().optional(), license: z.string().optional(),
  exports: z.record(z.string(), z.union([z.string(), z.record(z.string(), z.string())])).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});
