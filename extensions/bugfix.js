import { intro, scoutSchema } from '../src/prompts.js';
import { parseResult } from '../src/evaluation.js';
import { validateEvaluation } from '../src/task-registry.js';

export const bugfixTask = {
  id: 'code-bugfix', version: '1.0.0', name: '缺陷修复',
  description: '修复明确的错误、异常输出或失败用例。通过可复现缺陷和回归测试判断完成，不需要性能分数。',
  prepare: { schema: scoutSchema, prompt: run => `${intro(run)}
先调查问题并复用项目已有测试。只允许在 .sla/ 创建冻结的复现与回归检查，不修改源代码或原有测试。调查阶段不修复缺陷。
创建 .sla/evaluate.mjs，可调用项目已有运行时/测试入口。每次运行在 45 秒内结束，不安装依赖。
最后一行输出 SLA_RESULT {"valid":布尔,"reproduced":布尔,"regressionPassed":布尔,"summary":"实际检查结果"}。
reproduced 表示目标缺陷被实际断言复现，不能用进程报错、语法错误或依赖缺失代替。regressionPassed 表示不包含目标缺陷用例的相关原有行为检查通过。valid 当且仅当缺陷不再复现且回归检查通过。
复现检查必须同时验证正确的预期行为，不能因为返回不同的另一种错误结果就判修复。保持失败可见，不跳过或删除原有断言；评价程序遇到设施错误应非零退出。
初始项目应该 reproduced:true、regressionPassed:true、valid:false。准备不出明确复现时 ready:false，说明缺少条件。不要编造分数。criterion 描述复现条件、正确行为及回归范围；unit 返回空字符串。
所有检查与辅助文件放 .sla/；这些文件将原样冻结并独立运行。` },
  instructions: '以固定复现用例和回归检查确认修复。除明确需要修正的错误行为外，保持原有公共行为；不要删除、跳过或放宽测试。',
  async evaluate({ execute }) {
    const value = validateEvaluation(parseResult(await execute('node .sla/evaluate.mjs')));
    if (typeof value.reproduced !== 'boolean' || typeof value.regressionPassed !== 'boolean' || value.valid !== (!value.reproduced && value.regressionPassed)) throw new Error('缺陷评价结果相互矛盾');
    return { ...value, display: value.valid ? '修复通过' : !value.regressionPassed ? '回归失败' : '缺陷已复现' };
  },
  validateBaseline(result) {
    if (!result.reproduced || !result.regressionPassed) throw new Error('基线需要明确复现目标缺陷且相关回归检查通过：' + result.summary);
  },
  compare(candidate, reference) { return candidate.valid === reference.valid ? 'equal' : candidate.valid ? 'better' : 'worse'; },
  complete(result) { return result.valid; },
};

export const inject = ['sla'];
export function apply(ctx) { ctx.effect(() => ctx.sla.registerTask(bugfixTask)); }
