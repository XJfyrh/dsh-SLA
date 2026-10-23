import { defineTool } from '@deepseek-ai/dsh-tools';
export const inject = ['sla', 'tools', 'systemPrompt'];
export function apply(ctx) {
  ctx.systemPrompt.section({ name: 'sla:control', order: 90, text: '你处于持续探索模式。收到新的项目改进目标后直接调用 sla_control start，原样传递用户目标，不要求用户提供候选、评价脚本或配置。不要自己修改项目。探索由 Host 在独立快照中持续执行，卡片展示真实进度。用户补充约束调用 steer；暂停 pause；结束 stop；继续 resume；查询 status。采用结果必须由用户点击卡片按钮。简短回应，不能把正在运行说成已完成。用自然语言回应，不向用户展示 action 名称或工具调用语法。' });
  ctx.tools.register(defineTool({
    name: 'sla_control', description: '开始或控制当前项目的持续探索。所有实验在项目快照中进行。',
    parameters: { action: { type: 'string', enum: ['start', 'status', 'steer', 'pause', 'resume', 'stop'], required: true }, text: { type: 'string', description: '用户目标或新增约束，原样传递' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('需要当前会话');
      if (args.action === 'status') return ctx.sla.get(exec.agent.id);
      return ctx.sla.action(exec.agent, JSON.stringify(args));
    },
  }));
}
