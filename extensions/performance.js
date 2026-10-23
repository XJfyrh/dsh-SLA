import { intro, scoutSchema } from '../src/prompts.js';
import { parseResult } from '../src/evaluation.js';
import { validateEvaluation } from '../src/task-registry.js';

function scoutPrompt(run) {
  return `${intro(run)}
先调查项目，自己确定最值得改善的一个问题和可执行评价依据。不要要求用户提供技术细节。保持评价脚本简洁，复用现有测试；计时重复放在脚本内部，无需多次调用脚本。调查阶段不实现优化候选。
你只能新增 .sla/ 目录中的文件，不要修改任何项目源文件。
创建 .sla/evaluate.mjs（Node.js，无新增第三方依赖），它以项目根目录为 cwd，针对当前项目运行正确性检查及目标测量。可调用项目已有语言运行时/测试入口，但不得安装软件、下载依赖或写到项目外。脚本每次运行应在 45 秒内结束。
最终 stdout 最后一行必须为 SLA_RESULT {"valid":true,"score":数字,"summary":"实际检查结果"}。score 越小越好；出现错误或正确性失败必须 valid:false。基线必须真实可测，不写死分数，不以源代码是否包含某字符串判断性能。优先覆盖边界/错误输入，计时任务使用重复测量。所有评价辅助文件放 .sla/。
保持原有测试失败可见；测试无法执行、超时或依赖缺失不能当作通过，也不能移除对应检查。Windows 下 Node 测试若因子进程管道 EPERM 失败，可用 node --test --experimental-test-isolation=none 原样执行测试，或在当前进程使用 node:test；不要反复重试同一失败入口。
评价脚本会原样冻结并在每个候选上运行。criterion 说明度量与正确性边界，unit 说明单位。完成文件与一次运行验证后立即提交结构化结果，不反复测量。无法建立有效检查时 ready:false，并说清缺少的具体条件。不得声称检查已经通过，插件会自行运行。`;
}

export function parseEvaluation(result) {
  const value = validateEvaluation(parseResult(result));
  if (typeof value.score !== 'number' || !Number.isFinite(value.score)) throw new Error('评价结果格式无效：缺少数值 score');
  return { ...value, display: String(Number(value.score.toPrecision(6))) };
}

export const performanceTask = {
  id: 'code-performance', version: '1.0.0', name: '代码性能',
  description: '改善可运行代码的耗时、内存或其他可测量成本；保持正确行为。适用于明确的速度、资源或效率目标。',
  prepare: { schema: scoutSchema, prompt: scoutPrompt },
  instructions: '保持已有正确行为；用固定正确性检查和目标测量验证，数值越小越好。',
  async evaluate({ execute }) { return parseEvaluation(await execute('node .sla/evaluate.mjs')); },
  validateBaseline(result) { if (!result.valid) throw new Error('初始项目未通过建立的正确性检查：' + result.summary); },
  compare(candidate, reference) { return candidate.score < reference.score ? 'better' : candidate.score === reference.score ? 'equal' : 'worse'; },
};

export const inject = ['sla'];
export function apply(ctx) { ctx.effect(() => ctx.sla.registerTask(performanceTask)); }
