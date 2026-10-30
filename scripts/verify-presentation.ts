import type { Context } from '@deepseek-ai/cordis';
import type { } from '@deepseek-ai/dsh-agent-preset-registry';
import type { GenerateOptions, StreamChunk, ToolCallBlock } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { } from '@deepseek-ai/dsh-sandbox-policy';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { performanceWorkflow } from '../dist/extensions/performance.js';
import { isRecord, message } from '../dist/src/errors.js';
import type { } from '../dist/src/host.js';
import { settings } from '../dist/src/research-state.js';
import { object, present, runFixture } from '../test/state-fixtures.ts';
// Development Host overlay: verifies Worker Markdown and Reviewer metadata through DSH spawn
// and structured-output services, with deterministic model responses and no API call.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preservedBehaviorReview } from '../dist/extensions/code-review.js';
import { candidateBrief } from '../dist/src/presentation.js';
import { workerPrompt } from '../dist/src/prompts.js';

export const inject = ['sla', 'agents', 'agentPresets', 'llm'];
const output = fileURLToPath(new URL('../artifacts/decision-ui/host/', import.meta.url));
const brief = '### 改动说明\n修正零值回退逻辑，保留合法的零输入。\n### 尚未验证\n其它运行时尚未验证。';
const review = { hasChecks: true, title: '边界外输入的返回行为', purpose: '保持上下界以外的输入仍返回相应边界。', summary: '提出独立的边界行为检查。' };
class ScriptedAdapter extends LlmAdapter {
  requests = 0;
  async resolveModel(provider: string, model: string) { return { provider, id: model, name: model }; }
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.requests++;
    if (this.requests === 1) {
      assert.ok(JSON.stringify(options).includes('改动说明'));
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: brief };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: brief } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } else {
      assert.equal(this.requests, 2, 'unexpected model request');
      const submit = present(options.tools).find(t => isRecord(t.parameters.properties) && t.parameters.properties.hasChecks);
      assert.ok(submit);
      assert.ok(object(submit.parameters.properties).title);
      assert.ok(object(submit.parameters.properties).purpose);
      const block: ToolCallBlock = { type: 'tool-call', id: ToolCallId(randomUUID()), name: submit.name, arguments: JSON.stringify(review) };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    }
  }
}
async function verify(ctx: Context) {
  await ctx.sla.ready;
  const cwd = path.join(os.homedir(), '.dsh', 'sla-artifacts', 'presentation-probe', randomUUID());
  await mkdir(cwd, { recursive: true });
  const adapter = new ScriptedAdapter();
  const unregister = ctx.llm.registerAdapter(['sla-presentation-probe'], adapter);
  let parent;
  try {
    parent = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd, origin: 'subagent' }, agentOptions: { provider: 'sla-presentation-probe', model: 'scripted' },
      setup: async (scope, agent) => {
        await ctx.agentPresets.mount(scope, 'sla');
        agent.session.append('sandbox/mode', { mode: 'workspace-write', source: 'delegation' });
        agent.session.append('approval/policy', { policy: 'never', source: 'delegation' });
      } });
    const run = runFixture({ goal: '固定响应的展示契约验收', notes: [], criteria: { ready: true, criterion: 'contract probe' }, checks: [], trials: [] });
    const common = { settings: settings(), parent: parent.agent, cwd, signal: AbortSignal.timeout(60000), onStarted: async () => {} };
    const worker = object(await ctx.sla.invoke({ ...common, role: 'worker', prompt: workerPrompt(run, { direction: 'probe', hypothesis: 'probe', instructions: 'probe', evidenceTrials: [] }, { ...performanceWorkflow, description: 'probe' }) }));
    assert.ok(typeof worker.summary === 'string');
    assert.deepEqual(candidateBrief(worker.summary), { change: '修正零值回退逻辑，保留合法的零输入。', unverified: '其它运行时尚未验证。' });
    const method = preservedBehaviorReview('契约验收');
    const reviewer = await ctx.sla.invoke({ ...common, role: 'reviewer', schema: method.schema,
      prompt: method.prompt(run, { phase: 'baseline', checkDirectory: 'probe', originalDirectory: 'original', previousFailures: [] }) });
    assert.deepEqual(reviewer, review);
    return { passed: true, requests: adapter.requests, model: 'fixed responses; no external API', workerBrief: candidateBrief(worker.summary), reviewer,
      scope: 'DSH output contract only; no candidate implementation or evaluation executed' };
  } finally { await parent?.dispose(); unregister(); }
}
export function apply(ctx: Context) {
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      let report;
      try { report = await verify(ctx); } catch (error) { report = { passed: false, error: error instanceof Error ? error.stack : message(error) }; }
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
    }, 3000);
    return () => clearTimeout(timer);
  });
}
