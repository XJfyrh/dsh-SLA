import * as persona from '@deepseek-ai/dsh-persona';
import * as files from '@deepseek-ai/dsh-tool-fs';
import * as search from '@deepseek-ai/dsh-tool-fs-search';
import * as skills from '@deepseek-ai/dsh-tool-skill';
import * as skillFiles from '@deepseek-ai/dsh-skill-filesystem';

// These tools belong to one private child scope, not the selectable preset roster.
export async function mountResearcher(ctx, role) {
  const boundaries = {
    selector: '只读选择任务扩展，不修改任何文件，不解决项目目标。',
    scout: '只建立评价依据，所有新增文件放 .sla/。不得修改项目源文件或原有测试，不得修复或优化项目。完成初始评价后立即提交结构化结果；缺陷复现成功就是本阶段成功，不能为了让检查通过而修复。',
    advisor: '只读规划下一轮的不同探索方向，不修改任何文件，不自行执行修复。',
    worker: '只完成指定候选修改，不创建或修改 .sla/，不改变评价依据。',
    reviewer: '只独立审查评价遗漏，在指定 .sla/reviews 子目录新增补充检查。不得修改源代码、参考项目或原有评价，不实现修复。只保护目标修正范围之外的行为，不把目标缺陷的错误输出固化为正确预期。',
  };
  if (!boundaries[role]) throw new Error(`未知 SLA 调用角色：${role}`);
  const shell = process.platform === 'win32'
    ? await import('@deepseek-ai/dsh-tool-pwsh')
    : await import('@deepseek-ai/dsh-tool-bash');
  for (const [plugin, config] of [
    [persona, { prefix: `你只负责 SLA 的 ${role} 阶段。项目总体目标是背景，不是要求你在本阶段完成整个任务。${boundaries[role]}技能只辅助当前阶段，不扩大允许修改的范围。` }],
    [files, {}],
    [search, { sampleOverCapGlobResults: false }],
    [skillFiles, {}],
    [skills, {}],
    [shell, {}],
  ]) {
    const fiber = ctx.plugin(plugin, config);
    await fiber;
    const missing = Object.keys(fiber.inject).filter(name => fiber.ctx.get(name) === undefined);
    if (missing.length) throw new Error(`SLA 实验工具缺少服务：${missing.join(', ')}`);
  }
}
