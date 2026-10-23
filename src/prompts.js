const strings = { type: 'array', items: { type: 'string' } };
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const scoutSchema = schema({ title: { type: 'string' }, criterion: { type: 'string' }, unit: { type: 'string' }, ready: { type: 'boolean' }, reason: { type: 'string' } });
export const advisorSchema = schema({ hypothesis: { type: 'string' }, instructions: { type: 'string' }, stop: { type: 'boolean' }, reason: { type: 'string' } });
export const workerSchema = schema({ summary: { type: 'string' }, changes: strings });
export const intro = run => `你是 SLA 持续探索的一次全新调用。目标：${run.goal}\n用户补充：${run.notes.join('\n') || '无'}\n使用目录中与当前任务相关的 DSH 技能。只在当前工作目录内修改文件，不访问其他会话、源项目、兄弟候选、凭据或网络；允许读取所选技能及其引用资源。不要提交 Git，不调用其他 agent。用中文返回结论。在 12 步内完成并提交结构化结果；优先用相对路径，批量读取。`;
export function advisorPrompt(run, task) {
  return `${intro(run)}
角色：规划下一次实验。当前目录是最佳候选，只允许读取，不修改文件，不自行实现候选。根据代码和已有反馈提出一个待验证假设，交给 Worker 执行。
任务方法：${task.instructions ?? task.description}
固定评价依据：${run.criteria.criterion}。
基线 ${run.baseline.display ?? run.baseline.summary}；目前最佳 ${run.best.display ?? run.best.summary}。
本目标版本的实验反馈：${JSON.stringify(run.trials.filter(x => x.revision === run.revision).slice(-8))}
根据反馈选一个值得验证的具体假设，明确交给执行者的改动。避免重复已经失败的方案。没有值得继续的方向可 stop:true 并解释依据；不要因为一轮失败就停止。`;
}
export function workerPrompt(run, plan, task) {
  return `${intro(run)}
角色：完成一次候选修改。假设：${plan.hypothesis}\n任务：${plan.instructions}
评价依据：${run.criteria.criterion}。
任务方法：${task.instructions ?? task.description}
仅修改项目代码和有必要的项目测试；不要创建或修改 .sla/，不要改变判断标准、隐藏失败或跳过正确性。评价由插件在单独副本运行。
除目标明确要求修正的行为外保持已有公共行为，遵守用户约束。完成后返回实际改动摘要。`;
}

export function selection(tasks) {
  return {
    schema: schema({ taskId: { type: 'string', enum: [...tasks.map(task => task.id), 'unsupported'] }, reason: { type: 'string' } }),
    prompt: run => `${intro(run)}\n角色：只读调查目标和项目，选择一个最匹配的已安装任务扩展。不要修改文件。reason 只用一两句说明为什么适用，不输出完整调查记录或实现建议。没有合适扩展时返回 unsupported 并解释原因，不要硬套性能任务。\n已安装扩展：${JSON.stringify(tasks)}`,
  };
}
