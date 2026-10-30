import type { Context } from '@deepseek-ai/cordis';
import type { } from '@deepseek-ai/dsh-agent-preset-registry';
import type { GenerateOptions, StreamChunk, ToolCallBlock } from '@deepseek-ai/dsh-llm';
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm';
import type { } from '@deepseek-ai/dsh-sandbox-policy';
import type { } from '@deepseek-ai/dsh-session-title';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import type { } from '@deepseek-ai/dsh-workspace';
import { isRecord, message } from '../dist/src/errors.js';
import type { } from '../dist/src/host.js';
import { best, object, present } from '../test/state-fixtures.ts';
// Real DSH registration, fresh spawn, structured output, storage and delivery.
// The adapter supplies fixed model responses; no external model request occurs.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventory } from '../dist/src/workspace.js';

export const inject = ['sla', 'agents', 'agentPresets', 'llm', 'tools', 'workspaceRegistry', 'sessionTitle'];
const output = fileURLToPath(new URL('../artifacts/refactor/host-workflow/', import.meta.url));
const uiPendingDelivery = process.env.SLA_VERIFY_UI === '1';
class ScriptedAdapter extends LlmAdapter {
  requests: Array<{ fields: string[]; tools: string[]; purpose?: string }> = [];
  async resolveModel(provider: string, model: string) { return { provider, id: model, name: model }; }
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (this.requests.length === 3) {
      const text = '固定响应集成验证已完成：参数候选经过独立评价，可在探索面板查看当前结果和交付记录。此记录验证插件接入，不代表真实任务的搜索收益。';
      this.requests.push({ fields: [], tools: present(options.tools).map(t => t.name), purpose: 'visible verification receipt' });
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } }; return;
    }
    const find = (field: string) => present(options.tools).find(t => isRecord(t.parameters.properties) && t.parameters.properties[field]);
    const tool = find('taskId') ?? find('assignments') ?? find('topK');
    assert.ok(tool, 'expected workflow structured output');
    const fields = Object.keys(object(tool.parameters.properties)), names = present(options.tools).map(t => t.name);
    assert.ok(!names.includes('sla_control'));
    const value = fields.includes('taskId') ? { taskId: 'retrieval-parameters', reason: 'fixture has an existing retrieval dataset' }
      : fields.includes('assignments') ? { stop: false, reason: '', assignments: [{ direction: 'titles', lane: 'titles-a', hypothesis: 'title overlap identifies relevant documents', instructions: 'increase titleWeight to 4', evidenceTrials: [] }] }
      : { topK: 1, titleWeight: 4 };
    if (!fields.includes('taskId')) assert.deepEqual(names.slice().sort(), [tool.name, 'working_directory'].sort(), 'custom role unexpectedly inherited file or shell tools');
    this.requests.push({ fields, tools: names }); assert.ok(this.requests.length <= 3);
    const block: ToolCallBlock = { type: 'tool-call', id: ToolCallId(randomUUID()), name: tool.name, arguments: JSON.stringify(value) };
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}
async function verify(ctx: Context) {
  await ctx.sla.ready;
  assert.ok(ctx.sla.tasks.list().some(t => t.id === 'retrieval-parameters'), 'bundle did not mount parameter workflow');
  const cwd = path.join(os.homedir(), '.dsh', 'sla-artifacts', 'workflow-probe', randomUUID());
  await cp(new URL('../examples/retrieval-parameters/', import.meta.url), cwd, { recursive: true });
  const workspace = await ctx.workspaceRegistry.create(cwd, 'SLA 0.4 · 参数工作流');
  const before = await inventory(cwd), adapter = new ScriptedAdapter();
  const unregister = ctx.llm.registerAdapter(['sla-workflow-probe'], adapter);
  let parent;
  try {
    parent = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd }, agentOptions: { provider: 'sla-workflow-probe', model: 'scripted' },
      setup: async (scope, agent) => {
        await ctx.agentPresets.mount(scope, 'sla');
        agent.session.append('sandbox/mode', { mode: 'workspace-write', source: 'delegation' });
        agent.session.append('approval/policy', { policy: 'never', source: 'delegation' });
      } });
    ctx.sessionTitle.rename(parent.agent.session, '检索参数 · 固定响应集成验证');
    const engine = ctx.sla.engine, id = parent.agent.id;
    await ctx.sla.action(parent.agent, JSON.stringify({ action: 'start', text: '提高检索效果，使用已有数据集调整参数' }));
    while (engine.active.has(id)) await present(engine.active.get(id)).promise;
    const run = present(engine.get(id)); assert.equal(run.status, 'completed', run.message);
    assert.equal(present(run.baseline).recall, 0); assert.equal(best(run).recall, 1); assert.equal(run.attempts, 1);
    assert.equal(run.invocations.length, 3); assert.ok(run.invocations.every(i => i.status === 'completed' && i.childId));
    assert.equal(run.invocations[2].attemptId, run.trials[0].id);
    const preview = object(JSON.parse(await ctx.sla.changes(id))); assert.equal(preview.kind, 'artifact');
    if (!uiPendingDelivery) {
      await ctx.sla.action(parent.agent, JSON.stringify({ action: 'adopt' }));
      const delivered = present(engine.get(id)); assert.equal(delivered.adopted, true);
      const outputPath = object(delivered.delivery).path; assert.ok(typeof outputPath === 'string');
      const contents = object(JSON.parse(await readFile(outputPath, 'utf8')));
      assert.equal(contents.artifactId, best(run).artifactId); assert.deepEqual(contents.parameters, { topK: 1, titleWeight: 4 });
    }
    const delivered = present(engine.get(id));
    assert.deepEqual(await inventory(cwd), before); assert.equal(ctx.sla.calls.size, 0);
    parent.agent.send({ id: MessageId(randomUUID()), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '显示这次固定响应工作流集成验证的交付记录。' }] }, 'next-turn', true);
    await parent.agent.whenIdle();
    assert.equal(adapter.requests.length, 4);
    return { passed: true, uiPendingDelivery, model: 'fixed responses; no external API', requests: adapter.requests, sessionId: id, runId: run.id,
      records: { artifacts: run.artifacts.length, observations: delivered.observations.length, decisions: run.decisions.length },
      initial: present(run.baseline).display, selected: best(run).display, delivery: delivered.delivery, projectUnchanged: true, privateToolsDisposed: true };
  } catch (error) {
    throw Object.assign(new Error(message(error), { cause: error }), { probe: { requests: adapter.requests, run: parent && ctx.sla.engine.get(parent.agent.id) } });
  } finally {
    await parent?.dispose();
    if (parent) await workspace.attachSession(parent.agent.id);
    unregister();
  }
}
export function apply(ctx: Context) {
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      let report;
      try { report = await verify(ctx); } catch (error) { report = { passed: false, error: error instanceof Error ? error.stack : message(error), probe: isRecord(error) ? error.probe : undefined }; }
      await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
    }, 3000);
    return () => clearTimeout(timer);
  });
}
