// Optional, one-time DSH overlay for local acceptance. Never replaces an
// existing demo directory; installs no permanent profile plugin.
import { access, cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
export const inject = ['workspaceRegistry'];
export async function apply(ctx) {
  const projects = [];
  for (const [source, folder, title] of [
    ['clamp-bug', 'clamp-repair-demo', 'SLA 0.2 · 缺陷修复'],
    ['duplicates-baseline', 'performance-extension-demo', 'SLA 0.2 · 代码性能'],
  ]) {
    const cwd = path.join(os.homedir(), '.dsh', 'sla-artifacts', folder);
    try { await access(cwd); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await cp(fileURLToPath(new URL('../examples/' + source, import.meta.url)), cwd, { recursive: true, errorOnExist: true, force: false }); }
    const project = await ctx.workspaceRegistry.create(cwd, title);
    projects.push({ id: project.id, cwd, title });
  }
  const output = fileURLToPath(new URL('../artifacts/extensibility/live/', import.meta.url));
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'workspaces.json'), JSON.stringify(projects, null, 2));
}
