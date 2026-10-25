import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defineWorkflow, jsonArtifact, verifyJsonArtifact, slaPlanSchema } from '../src/workflow.js';
import { validateDataset, evaluateRetrieval } from './retrieval-evaluator.js';

const role = instructions => ({ instructions, tools: [] });
const parameterSchema = { type: 'object', properties: { topK: { type: 'integer' }, titleWeight: { type: 'number' } }, required: ['topK', 'titleWeight'], additionalProperties: false };
function packageContent(state, artifact) {
  return JSON.stringify({ artifactId: artifact.id, criteriaVersion: state.criteriaVersion, parameters: artifact.payload }, null, 2) + '\n';
}
async function packageReceipt(state, artifact) {
  const target = path.join(state.root, 'parameters.json');
  if (await readFile(target, 'utf8') !== packageContent(state, artifact)) throw new Error('参数交付内容不一致，保留现有文件等待检查');
  return { kind: 'parameter-package', path: target, artifactId: artifact.id, parameters: artifact.payload };
}

export const parameterWorkflow = defineWorkflow({
  id: 'retrieval-parameters', version: '1.0.0', name: '检索参数',
  description: '针对项目已有 retrieval-eval.json 中的英文词项检索评测集，优化 topK 和 titleWeight。复用固定评测器，交付参数 JSON 包，不修改源码。',
  artifacts: { verify: verifyJsonArtifact },
  async evaluate({ artifact, criteria }) { return evaluateRetrieval(artifact.payload, criteria.dataset); },
  validateBaseline(result) { if (!result.valid) throw new Error('初始参数无效：' + result.summary); },
  compare(a, b) { return a.recall !== b.recall ? (a.recall > b.recall ? 'better' : 'worse') : a.returned < b.returned ? 'better' : a.returned === b.returned ? 'equal' : 'worse'; },
  complete: result => result.recall === 1 && result.returned === 1,
  projectEvidence: result => result.diagnostics,
  async run(ctx) {
    let state = ctx.state();
    if (!state.criteria) {
      const dataset = validateDataset(JSON.parse(await readFile(path.join(state.cwd, 'retrieval-eval.json'), 'utf8')));
      let initial = { topK: 1, titleWeight: 0 };
      try { initial = JSON.parse(await readFile(path.join(state.cwd, 'retrieval-params.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await ctx.initialize({ artifact: jsonArtifact(initial), criteria: { ready: true,
        criterion: '使用冻结的英文词项检索数据集，优先提高平均召回率；召回相同时减少平均返回条数。搜索参数为 topK（1–5）和 titleWeight（0–8）。', dataset } });
    }
    await ctx.search({
      plan: async ({ state, evidence }) => ctx.invoke({ role: 'parameter-advisor', schema: slaPlanSchema,
        blueprint: role('只分配参数搜索方向，根据实际观测规划；不修改数据集，不把猜测当作结果。'),
        prompt: `目标：${state.goal}\n补充：${state.notes.join('\n')}\n${state.criteria.criterion}\n最多 ${state.settings.directions} 个分支，每分支 ${state.settings.localTrials} 次。direction 是方法族；同方法可分配独立 lane。\n当前最佳：${JSON.stringify(state.best.evaluation)}\n分支证据：${JSON.stringify(evidence)}\n输出下一轮可独立执行的参数搜索假设；evidenceTrials 只引用已有编号。` }),
      produce: async ({ seed, assignment, feedback, invoke }) => jsonArtifact(await invoke({ role: 'parameter-proposer', schema: parameterSchema,
        blueprint: role('只提交一组完整参数，topK 为 1–5 整数，titleWeight 为 0–8。测量由独立评测器完成。'),
        prompt: `从 ${JSON.stringify(seed.payload)} 继续。\n假设：${assignment.hypothesis}\n任务：${assignment.instructions}\n上次反馈：${JSON.stringify(feedback)}\n提交值得验证的下一组参数，不声称已经改善。` })),
    });
  },
  async deliver({ state, artifact, authorize }) {
    await authorize();
    const target = path.join(state.root, 'parameters.json');
    try { await writeFile(target, packageContent(state, artifact), { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return packageReceipt(state, artifact);
  },
  async recoverDelivery(state) {
    const artifact = state.artifacts.find(a => a.id === state.best.artifactId);
    if (!artifact) throw new Error('交付候选身份不存在');
    verifyJsonArtifact(artifact);
    try { return { status: 'delivered', receipt: await packageReceipt(state, artifact) }; }
    catch (error) { if (error.code === 'ENOENT') return { status: 'absent' }; throw error; }
  },
});

export const inject = ['sla'];
export function apply(ctx) { ctx.effect(() => ctx.sla.registerWorkflow(parameterWorkflow)); }
