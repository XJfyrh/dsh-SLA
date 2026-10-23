import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { remote } from './remote.js';
import { ExplorationEngine } from './engine.js';
import { mountResearcher } from './researcher.js';
import { TaskRegistry } from './task-registry.js';

const runSchema = z.object({
  id: z.string(), sessionId: z.string(), goal: z.string(), cwd: z.string(), root: z.string(),
  status: z.enum(['preparing', 'running', 'pausing', 'paused', 'stopping', 'completed', 'blocked']),
  revision: z.number().int().positive(), trials: z.array(z.record(z.string(), z.json())),
  attempts: z.number().int().nonnegative(), notes: z.array(z.string()),
}).passthrough();
const domain = defineDomain({ name: 'sla_exploration', version: 1, tables: { runs: domainTable(runSchema) } });
const actionSchema = z.object({ action: z.enum(['start', 'pause', 'resume', 'steer', 'stop', 'adopt', 'configure', 'review']), text: z.string().trim().max(12000).optional(), settings: z.object({ maxTrials: z.number().int().min(1).max(100).optional(), maxMinutes: z.number().int().min(1).max(240).optional(), directions: z.number().int().min(1).max(4).optional(), localTrials: z.number().int().min(1).max(5).optional() }).strict().optional() }).strict();
function view(run) {
  if (!run) return null;
  const { sourceFiles, ...rest } = run;
  return rest;
}

export default class SlaService extends TypertRemoteService {
  static inject = ['typert', 'agents', 'storageDomain', 'subagents', 'workingDirectory', 'shell', 'sandboxPolicy'];
  constructor(ctx) {
    super(ctx, 'sla');
    this.tasks = new TaskRegistry();
    ctx.typert.register({ package: remote.package, face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: remote.descriptors });
    this.calls = new Map();
    this.researchOwners = new Map();
    ctx.on('agent/created', async ({ agent }) => {
      if (!this.researchOwners.has(agent.session.header.parentSession)) return;
      // Harness awaits creation listeners before the child's first model request.
      await mountResearcher(agent.ctx, this.researchOwners.get(agent.session.header.parentSession));
      agent.ctx.systemPrompt.context({
        name: 'sla:invocation-budget', order: 1000, required: true, interpolate: false,
        text: () => {
          const steps = this.calls.get(agent.id)?.steps ?? 0;
          return steps < 18 ? '本次 SLA 调用最多 24 步，请预留一步提交结果。'
            : `本次 SLA 调用已进入收尾阶段。包含当前步还剩 ${25 - steps} 步。停止增加检查或临时样例，优先提交已有结果；无法完成时如实说明缺少条件。需要结构化输出的角色必须调用结果提交工具，文件已写好不等于调用完成。`;
        },
      });
    });
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const call = this.calls.get(agent.id);
      if (call && ++call.steps > 24) return { kind: 'reject' };
      return next();
    });
    this.ready = this.initialize();
    ctx.effect(() => async () => {
      await this.ready;
      await this.engine.dispose();
      await this.domain.close();
    });
  }
  async initialize() {
    this.domain = await this.ctx.storageDomain.open(domain);
    const root = path.join(os.homedir(), '.dsh', 'sla-artifacts');
    this.engine = new ExplorationEngine({ store: this.domain.table('runs'), tasks: this.tasks, root, adapter: {
      authorize: parent => this.assertWritable(parent),
      directory: async parent => {
        const policy = this.ctx.sandboxPolicy.resolve({ session: parent.session });
        if (policy.mode === 'read-only') throw new Error('当前会话是只读模式，请使用工作区内修改模式启动探索。');
        return this.ctx.workingDirectory.ensure(parent);
      },
      invoke: args => this.invoke(args),
      execute: async ({ parent, cwd, signal, command }) => {
        const policy = this.ctx.sandboxPolicy.resolve({ session: parent.session });
        if (policy.mode === 'read-only') throw new Error('会话已切换为只读，评价已停止。');
        const spec = this.ctx.shell.resolve({ command, workdir: cwd, timeoutMs: 60000, stdoutMaxBytes: 128 * 1024, signal, sandboxPolicy: { ...policy, workspaceRoot: cwd } });
        const process = await this.ctx.shell.execute(spec);
        return process.result();
      },
      error: error => this.ctx.logger.error(String(error)),
    } });
    await this.engine.recover();
  }
  registerTask(task) { return this.tasks.register(task); }
  assertWritable(parent) {
    if (this.ctx.sandboxPolicy.resolve({ session: parent.session }).mode === 'read-only') throw new Error('当前会话是只读模式，未执行评价或写回。');
  }
  async get(sessionId) {
    await this.ready;
    return JSON.stringify(view(this.engine.get(sessionId)));
  }
  async action(agent, input) {
    await this.ready;
    const request = actionSchema.parse(JSON.parse(input));
    if (['start', 'steer'].includes(request.action) && !request.text) throw new Error('请输入目标或补充要求。');
    return JSON.stringify(view(await this.engine.action(agent, request)));
  }
  async invoke({ parent, role, cwd, prompt, schema, signal, onStarted }) {
    if (this.ctx.sandboxPolicy.resolve({ session: parent.session }).mode === 'read-only') throw new Error('会话已切换为只读，探索已停止。');
    const provider = this.ctx.subagents.getProvider('spawn');
    if (!provider || provider.inheritsParentContext !== false || !provider.capabilities.outputSchema) throw new Error('当前 Harness 未提供 fresh spawn + structured output 能力。');
    const timeout = AbortSignal.timeout(5 * 60000);
    const combined = AbortSignal.any([signal, timeout]);
    // spawn inherits its parent's immutable workspace boundary, not request.cwd.
    // This non-driving owner binds that boundary to this one snapshot.
    const config = parent.session.requestHeader()?.config;
    const owner = await this.ctx.agents.create({
      sessionId: randomUUID(), parentAgent: parent, signal: combined,
      meta: { cwd, parentSession: parent.id, origin: 'subagent' },
      agentOptions: { ...parent.options, ...(config ? { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort } : {}) },
      setup: async (_ctx, agent) => {
        agent.session.append('sandbox/mode', { mode: 'workspace-write', source: 'delegation' });
        agent.session.append('approval/policy', { policy: 'never', source: 'delegation' });
      },
    });
    let activation;
    this.researchOwners.set(owner.agent.id, role);
    try {
      activation = await this.ctx.subagents.startActivation({
      provider: 'spawn', label: 'SLA · ' + role, delivery: 'caller', signal: combined,
      request: { parent: owner.agent, cwd, prompt: [{ type: 'text', text: prompt }], ...(role === 'worker' ? {} : { outputSchema: schema }), agentOptions: { maxTokens: 16000 } },
      });
    } catch (error) { await owner.dispose(); throw error; }
    finally { this.researchOwners.delete(owner.agent.id); }
    this.calls.set(activation.childId, { steps: 0 });
    const cancel = () => { activation.dispose().catch(error => this.ctx.logger.warn(String(error))); };
    combined.addEventListener('abort', cancel, { once: true });
    if (combined.aborted) cancel();
    try {
      await onStarted(activation.childId);
      const result = await activation.result;
      combined.throwIfAborted();
      if (this.calls.get(activation.childId)?.steps > 24) throw new Error('子会话达到 24 步上限，尚未提交完整结果；本次调用证据已保留。');
      if (result.stopReason !== 'completed') throw new Error(`子会话未完成：${result.stopReason} ${result.diagnostic ?? '未提交完整结果'}`);
      if (role === 'worker') return { summary: result.output.filter(x => x.type === 'text').map(x => x.text).join('\n'), changes: [] };
      if (!result.structured) throw new Error('子会话未提交结构化结果');
      return result.structured;
    } finally {
      combined.removeEventListener('abort', cancel);
      try { await activation.dispose(); }
      finally {
        this.calls.delete(activation.childId);
        await owner.dispose();
      }
    }
  }
}
