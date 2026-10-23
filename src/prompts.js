const strings = { type: 'array', items: { type: 'string' } };
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const scoutSchema = schema({ title: { type: 'string' }, criterion: { type: 'string' }, unit: { type: 'string' }, ready: { type: 'boolean' }, reason: { type: 'string' } });
export const advisorSchema = schema({ hypothesis: { type: 'string' }, instructions: { type: 'string' }, stop: { type: 'boolean' }, reason: { type: 'string' } });
export const workerSchema = schema({ summary: { type: 'string' }, changes: strings });
const intro = run => `你是 SLA 持续探索的一次全新调用。目标：${run.goal}\n用户补充：${run.notes.join('\n') || '无'}\n只在当前工作目录内工作，不访问其他会话、源项目、兄弟候选、凭据或网络。不要提交 Git，不调用其他 agent。用中文返回结论。在 12 步内完成并提交结构化结果；优先用相对路径，批量读取。`;
export function scoutPrompt(run) {
  return `${intro(run)}
先调查项目，自己确定最值得改善的一个问题和可执行评价依据。不要要求用户提供技术细节。保持评价脚本简洁，复用现有测试；计时重复放在脚本内部，无需多次调用脚本。调查阶段不实现优化候选。
你只能新增 .sla/ 目录中的文件，不要修改任何项目源文件。
创建 .sla/evaluate.mjs（Node.js，无新增第三方依赖），它以项目根目录为 cwd，针对当前项目运行正确性检查及目标测量。可调用项目已有语言运行时/测试入口，但不得安装软件、下载依赖或写到项目外。脚本每次运行应在 45 秒内结束。
最终 stdout 最后一行必须为 SLA_RESULT {"valid":true,"score":数字,"summary":"实际检查结果"}。score 越小越好；出现错误或正确性失败必须 valid:false。基线必须真实可测，不写死分数，不以源代码是否包含某字符串判断性能。优先覆盖边界/错误输入，计时任务使用重复测量。所有评价辅助文件放 .sla/。
评价脚本会原样冻结并在每个候选上运行。criterion 说明度量与正确性边界，unit 说明单位。无法建立有效检查时 ready:false，并说清缺少的具体条件。不得声称检查已经通过，插件会自行运行。`;
}
export function advisorPrompt(run) {
  return `${intro(run)}
角色：规划下一次实验。当前目录是最佳候选，只允许读取，不修改文件，不自行实现候选或运行性能实验。根据代码和已有反馈提出一个待验证假设，交给 Worker 执行，不需要先证明性能收益。
固定评价依据：${run.criteria.criterion}；单位 ${run.criteria.unit}，越小越好。
基线 ${run.baseline.score}；目前最佳 ${run.best.score}。
本目标版本的实验反馈：${JSON.stringify(run.trials.filter(x => x.revision === run.revision).slice(-8))}
根据反馈选一个值得验证的具体假设，明确交给执行者的改动。避免重复已经失败的方案。没有值得继续的方向可 stop:true 并解释依据；不要因为一轮失败就停止。`;
}
export function workerPrompt(run, plan) {
  return `${intro(run)}
角色：完成一次候选修改。假设：${plan.hypothesis}\n任务：${plan.instructions}
评价依据：${run.criteria.criterion}；${run.criteria.unit} 越小越好。
仅修改项目代码和有必要的项目测试；不要创建或修改 .sla/，不要改变判断标准、隐藏失败或跳过正确性。评价由插件在单独副本运行。
保持已有公共行为，遵守用户约束。完成后返回实际改动摘要。`;
}
