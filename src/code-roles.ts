import type { RoleBlueprint } from './contracts.js';
const boundaries: Record<string, string> = {
  selector: '只读选择任务扩展，不修改任何文件，不解决项目目标。',
  scout: '只建立评价依据，所有新增文件放 .sla/。不得修改项目源文件或原有测试，不得修复或优化项目。完成初始评价后立即提交结构化结果；缺陷复现成功就是本阶段成功，不能为了让检查通过而修复。',
  advisor: '只读规划下一轮的不同探索方向，不修改任何文件，不自行执行修复。选定有依据的可执行实验假设后即提交简短任务，将实现推导、参数选择和收益验证留给 Worker；未知点由实验解决。',
  worker: '只完成指定候选修改，不创建或修改 .sla/，不改变评价依据。',
  reviewer: '只独立审查评价遗漏，在指定 .sla/reviews 子目录新增补充检查。不得修改源代码、参考项目或原有评价，不实现修复。只保护目标修正范围之外的行为，不把目标缺陷的错误输出固化为正确预期。',
};

export function codeRole(role: string): RoleBlueprint {
  if (!boundaries[role]) throw new Error(`未知 SLA 调用角色：${role}；工作流需提供角色定义`);
  return { instructions: boundaries[role], tools: ['files', 'search', 'skills', 'shell'] };
}
