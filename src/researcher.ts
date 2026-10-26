import type { Context, Fiber } from '@deepseek-ai/cordis';
import type { RoleBlueprint } from './contracts.js';
import * as persona from '@deepseek-ai/dsh-persona';
import * as files from '@deepseek-ai/dsh-tool-fs';
import * as search from '@deepseek-ai/dsh-tool-fs-search';
import * as skills from '@deepseek-ai/dsh-tool-skill';
import * as skillFiles from '@deepseek-ai/dsh-skill-filesystem';
import { codeRole } from './code-roles.js';

// These tools belong to one private child scope, not the selectable preset roster.
export async function mountResearcher(ctx: Context, role: string, blueprint: RoleBlueprint = codeRole(role)) {
  if (typeof blueprint.instructions !== 'string' || !Array.isArray(blueprint.tools)) throw new Error('工作流角色定义无效');
  const shell = process.platform === 'win32'
    ? await import('@deepseek-ai/dsh-tool-pwsh')
    : await import('@deepseek-ai/dsh-tool-bash');
  const groups = {
    files: () => [ctx.plugin(files, {})],
    search: () => [ctx.plugin(search, { sampleOverCapGlobResults: false })],
    skills: () => [ctx.plugin(skillFiles, {}), ctx.plugin(skills, {})],
    shell: () => [ctx.plugin(shell, {})],
  };
  if (blueprint.tools.some(name => !Object.hasOwn(groups, name))) throw new Error('未知 DSH 工具组');
  const mount = async (fiber: Fiber & PromiseLike<Fiber>) => {
    await fiber;
    const missing = Object.keys(fiber.inject).filter(name => fiber.ctx.get(name) === undefined);
    if (missing.length) throw new Error(`SLA 实验工具缺少服务：${missing.join(', ')}`);
  };
  await mount(ctx.plugin(persona, { prefix: `你只负责 SLA 的 ${role} 阶段。项目总体目标是背景，不是要求你在本阶段完成整个任务。${blueprint.instructions}技能只辅助当前阶段，不扩大允许修改的范围。` }));
  for (const name of new Set(blueprint.tools)) for (const fiber of groups[name]()) await mount(fiber);
  await blueprint.mount?.(ctx);
}
