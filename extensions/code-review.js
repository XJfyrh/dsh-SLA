import { intro } from '../src/prompts.js';
import { parseResult } from '../src/evaluation.js';

// Code-task method, not a required protocol for other SLA extensions.
export function preservedBehaviorReview(kind) {
  return {
    schema: { type: 'object', properties: { hasChecks: { type: 'boolean' }, summary: { type: 'string' } }, required: ['hasChecks', 'summary'], additionalProperties: false },
    prompt(run, { phase, checkDirectory, originalDirectory, previousFailures }) {
      return `${intro(run)}
角色：独立审查${phase === 'baseline' ? '初始评价依据' : '候选的行为回归'}。这是${kind}任务。只找目标修改范围之外、必须保持的公共行为。不要修复项目或实现优化。
当前目录是待审项目，${originalDirectory}/ 是只读原始项目。阅读目标、原始代码和已有 .sla 检查，找现有检查没有覆盖的具体行为；${phase === 'candidate' ? '重点看候选与原始实现的差别，尝试构造能暴露回归的输入。' : '优先检查边界输入、错误处理、返回值语义和调用协议。'}
缺陷修复允许目标错误行为改变，绝不能把目标缺陷的旧错误输出写成回归预期。summary 必须说明检查的保留行为及为什么在目标修正范围之外。性能重复测量属于原评价，这里检查语义。
只能在 .sla/${checkDirectory}/ 新增文件，不能修改其他评价文件、源代码、原有测试或参考项目。需要新检查时编写 .sla/${checkDirectory}/check.mjs，用 Node 从 cwd 加载待审项目，使用明确断言验证保留行为。不得导入参考目录、扫描其它候选、写死通过、比较源码字符串或依赖候选自己给出预期；可把独立推导的少量输入/预期写入检查。检查不得改动项目文件、安装依赖或联网，45秒内结束。
最后输出一行 SLA_RESULT {"passed":布尔,"summary":"实际断言结果"}；断言失败应输出 passed:false，设施/导入/语法错误应非零退出，不能伪装成语义反例。
断言运行完成时 exit 0，包括 passed:false；不得在运行时写入 .sla/，日志输出到 stdout。
原始项目和候选将由 Host 分别运行同一检查，原始项目未通过的检查不会发布。不要自行修改原始项目。完成一个最有价值的检查就提交，不追求穷举。没有具体新检查则 hasChecks:false，不创建文件，并说明检查了什么；这不表示已证明所有行为正确。
已有评价：${run.criteria.criterion}
已冻结补充检查：${JSON.stringify(run.checks.map(c => c.summary))}
此前审查失败：${JSON.stringify(previousFailures)}`;
    },
    async evaluate({ execute, check }) {
      const value = parseResult(await execute(`node .sla/${check.directory}/check.mjs`));
      if (typeof value?.passed !== 'boolean' || typeof value.summary !== 'string' || !value.summary.trim()) throw new Error('保留行为检查需要 passed 与 summary');
      return { passed: value.passed, summary: value.summary };
    },
  };
}
