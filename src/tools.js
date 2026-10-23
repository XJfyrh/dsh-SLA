import { defineTool } from '@deepseek-ai/dsh-tools';
import { controlSummary } from './research-state.js';
export const inject = ['sla', 'tools', 'systemPrompt'];
export function apply(ctx) {
  ctx.systemPrompt.section({ name: 'sla:control', order: 90, text: '你处于持续探索模式。收到新的项目改进目标后直接调用 sla_control start，原样传递用户目标，不要求用户提供候选、评价脚本或配置。不要自己修改项目。探索由 Host 在独立快照中持续执行，会话顶部的探索入口展示状态，点击打开右侧探索面板。用户直接在主对话中补充约束调用 steer；暂停 pause；结束 stop；继续 resume；查询 status。用户指定时间、次数或方向数量时使用 settings；已有探索先暂停再 configure，原样保留未指定设置。maxTrials 是候选尝试次数，不是 Epoch 数；一轮额度内可以有多个 Epoch。review 只审查已有候选，不新增实验。采用结果必须由用户点击右侧探索面板中的采用按钮。简短回应，不能把正在运行说成已完成。用自然语言回应，不向用户展示 action 名称或工具调用语法。' });
  ctx.tools.register(defineTool({
    name: 'sla_control', description: '开始或控制当前项目的持续探索。所有实验在项目快照中进行。',
    parameters: { action: { type: 'string', enum: ['start', 'status', 'steer', 'pause', 'resume', 'stop', 'configure', 'review'], required: true }, text: { type: 'string', description: '用户目标或新增约束，原样传递' }, settings: { type: 'object', description: '用户指定的探索上限；configure 前先暂停。maxTrials 每轮尝试1–100，maxMinutes 每轮分钟1–240，directions 每Epoch方向1–4，localTrials 每方向局部尝试1–5。未指定沿用默认。', properties: { maxTrials: { type: 'integer' }, maxMinutes: { type: 'integer' }, directions: { type: 'integer' }, localTrials: { type: 'integer' } }, additionalProperties: false } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('需要当前会话');
      const response = args.action === 'status' ? await ctx.sla.get(exec.agent.id) : await ctx.sla.action(exec.agent, JSON.stringify(args));
      return JSON.stringify(controlSummary(JSON.parse(response)));
    },
  }));
}
