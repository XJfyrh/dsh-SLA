import { advisorEvidence, feedback } from './research-state.js';
const strings = { type: 'array', items: { type: 'string' } };
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const scoutSchema = schema({ title: { type: 'string' }, criterion: { type: 'string' }, unit: { type: 'string' }, ready: { type: 'boolean' }, reason: { type: 'string' } });
export const advisorSchema = schema({ assignments: { type: 'array', items: schema({ direction: { type: 'string' }, hypothesis: { type: 'string' }, instructions: { type: 'string' }, evidenceTrials: { type: 'array', items: { type: 'integer' } } }) }, stop: { type: 'boolean' }, reason: { type: 'string' } });
export const workerSchema = schema({ summary: { type: 'string' }, changes: strings });
export const intro = run => `你是 SLA 持续探索的一次全新调用。目标：${run.goal}\n用户补充：${run.notes.join('\n') || '无'}\n使用目录中与当前任务相关的 DSH 技能。只在当前工作目录内修改文件，不访问其他会话、源项目、兄弟候选、凭据或网络；允许读取所选技能及其引用资源。不要提交 Git，不调用其他 agent。用中文返回结论。在 12 步内完成并提交结构化结果；优先用相对路径，批量读取。`;
export function advisorPrompt(run, task) {
  return `${intro(run)}
角色：规划下一个 Epoch。当前目录是全局最佳，只允许读取，不修改文件，不自行实现候选。
最多分配 ${run.settings.directions} 个不同方向，每个方向连续尝试最多 ${run.settings.localTrials} 次，同一个任务贯穿这些局部尝试。direction 使用稳定的英文短 id；继续同一方向沿用原 id，换方法使用新 id。未分配的方向暂停但保留候选。新方向可以暂时落后全局最佳，不因首次有效结果较差就放弃。
任务方法：${task.instructions ?? task.description}
固定评价依据：${run.criteria.criterion}。
已冻结补充检查：${JSON.stringify(run.checks)}
基线 ${run.baseline.display ?? run.baseline.summary}；目前最佳 ${run.best.display ?? run.best.summary}。
本目标版本的方向证据（核心从实际记录生成）：${JSON.stringify(advisorEvidence(run))}
当前评价版本 ${run.criteriaVersion}。历史证据保留自身版本，跨版本分数不能直接比较。invalid 是正确性失败，inconclusive 是执行或评价未完成，不能据此断言方向无效。记录中的 hypothesis 是待验证假设，不是事实。
每个分配用 evidenceTrials 引用实际支持它的实验编号；新方向没有依据可返回空数组。不要重复已有强负面证据的方法，除非明确提出改变前提的理由。没有值得继续的方向可 stop:true、assignments:[] 并说明依据；不要因为一轮失败就停止。`;
}
export function workerPrompt(run, plan, task, direction) {
  return `${intro(run)}
角色：完成当前方向的一次候选修改。方向：${plan.direction}；假设：${plan.hypothesis}\n任务：${plan.instructions}
当前目录是本方向保留候选。上一次本方向的实际反馈：${JSON.stringify(feedback(run.trials.filter(t => t.direction === direction?.id && t.revision === run.revision && t.status !== 'running').at(-1), run))}
每次只实现一个连贯改动；保留之前有效进展。未完成的评价不是方法无效的证据。
评价依据：${run.criteria.criterion}。
已冻结补充检查：${JSON.stringify(run.checks)}
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
