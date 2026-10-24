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
import { changePreview } from './change-preview.js';
import { settings as parseSettings } from './research-state.js';

const runSchema = z.object({
  id: z.string(), sessionId: z.string(), goal: z.string(), cwd: z.string(), root: z.string(),
  status: z.enum(['preparing', 'running', 'pausing', 'paused', 'stopping', 'completed', 'blocked']),
  revision: z.number().int().positive(), trials: z.array(z.record(z.string(), z.json())),
  attempts: z.number().int().nonnegative(), notes: z.array(z.string()),
}).passthrough();
const domain = defineDomain({ name: 'sla_exploration', version: 1, tables: { runs: domainTable(runSchema) } });
const actionSchema = z.object({ action: z.enum(['start', 'pause', 'resume', 'steer', 'stop', 'adopt', 'configure', 'review']), text: z.string().trim().max(12000).optional(), settings: z.object({ maxTrials: z.number().int().min(1).max(100).optional(), maxMinutes: z.number().int().min(1).max(240).optional(), directions: z.number().int().min(1).max(4).optional(), localTrials: z.number().int().min(1).max(5).optional(), maxStepsPerCall: z.number().int().min(4).max(200).optional(), maxMinutesPerCall: z.number().int().min(1).max(60).optional() }).strict().optional() }).strict();
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
      const role = this.researchOwners.get(agent.session.header.parentSession);
      // Harness awaits creation listeners before the child's first model request.
      await mountResearcher(agent.ctx, role);
      agent.ctx.tools.presentAs('native');
      const workSteps = () => this.calls.get(agent.id)?.workSteps ?? 24;
      const submitting = () => (this.calls.get(agent.id)?.steps ?? 0) > workSteps();
      // Assembly controls what the model sees; the native guard also rejects
      // stale/hallucinated tool calls before any side effect in the final step.
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembly = await next();
        // DSH assembles tools before pre-step increments the admitted count.
        if ((this.calls.get(agent.id)?.steps ?? 0) < workSteps()) return assembly;
        return { ...assembly, tools: assembly.tools.filter(tool => role !== 'worker' && tool.name === 'structured_output') };
      });
      agent.ctx.tools.guard(exec => submitting() && (role === 'worker' || exec.name !== 'structured_output')
        ? 'SLA 工作步骤已用完，本步只提交已有结果，不再执行工具。' : undefined);
      agent.ctx.systemPrompt.context({
        name: 'sla:invocation-budget', order: 1000, required: true, interpolate: false,
        text: () => {
          const steps = this.calls.get(agent.id)?.steps ?? 0;
          if (submitting()) return `本次 SLA 调用只剩结果提交步，工作工具已收起。${role === 'worker' ? '立即用 Markdown 汇报已写入的改动和未验证事项，不再调用工具。' : '立即调用 structured_output 提交已有结果；按本阶段格式如实说明未完成条件，不能把未执行的检查说成通过。'}文件写好不等于调用完成。`;
          return steps < workSteps() - 6 ? `本次 SLA 调用最多 ${workSteps()} 个工作步，另有 1 个只提交结果的步骤；尽早完成，不必用满。`
            : `本次 SLA 调用已进入收尾阶段。包含当前步还剩 ${workSteps() + 1 - steps} 个工作步，之后只允许提交结果。停止增加检查或临时样例，优先完成已有工作；无法完成时如实说明缺少条件。需要结构化输出的角色必须调用结果提交工具，文件已写好不等于调用完成。`;
        },
      });
    });
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const call = this.calls.get(agent.id);
      if (call && ++call.steps > call.workSteps + 1) return { kind: 'reject' };
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
  async changes(sessionId) {
    await this.ready;
    return JSON.stringify(await changePreview(this.engine.get(sessionId)));
  }
  async action(agent, input) {
    await this.ready;
    const request = actionSchema.parse(JSON.parse(input));
    if (['start', 'steer'].includes(request.action) && !request.text) throw new Error('请输入目标或补充要求。');
    return JSON.stringify(view(await this.engine.action(agent, request)));
  }
  async invoke({ parent, role, cwd, prompt, schema, settings, signal, onStarted }) {
    if (this.ctx.sandboxPolicy.resolve({ session: parent.session }).mode === 'read-only') throw new Error('会话已切换为只读，探索已停止。');
    const provider = this.ctx.subagents.getProvider('spawn');
    if (!provider || provider.inheritsParentContext !== false || !provider.capabilities.outputSchema) throw new Error('当前 Harness 未提供 fresh spawn + structured output 能力。');
    const limits = parseSettings(settings);
    const timeout = AbortSignal.timeout(limits.maxMinutesPerCall * 60000);
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
      request: { parent: owner.agent, cwd, prompt: [{ type: 'text', text: prompt }], ...(role === 'worker' ? {} : { outputSchema: schema }) },
      });
    } catch (error) { await owner.dispose(); throw error; }
    finally { this.researchOwners.delete(owner.agent.id); }
    this.calls.set(activation.childId, { steps: 0, workSteps: limits.maxStepsPerCall });
    const cancel = () => { activation.dispose().catch(error => this.ctx.logger.warn(String(error))); };
    combined.addEventListener('abort', cancel, { once: true });
    if (combined.aborted) cancel();
    try {
      await onStarted(activation.childId);
      const result = await activation.result;
      combined.throwIfAborted();
      if (this.calls.get(activation.childId)?.steps > limits.maxStepsPerCall + 1) throw new Error(`子会话达到 ${limits.maxStepsPerCall} 个工作步和 1 个结果提交步上限，尚未提交完整结果；本次调用证据已保留。`);
      if (result.stopReason !== 'completed') throw new Error(`子会话未完成：${result.stopReason} ${result.diagnostic ?? '未提交完整结果'}`);
      if (role === 'worker') return { summary: result.output.filter(x => x.type === 'text').map(x => x.text).join('\n') };
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
