import type { SlaEndpoints } from './wire.js';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Domain } from '@deepseek-ai/dsh-storage-domain';
import type {} from '@deepseek-ai/dsh-subagent';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import type {} from '@deepseek-ai/dsh-working-directory';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-typert-registry';
import { runSchema, actionSchema } from './data.js';
import type { Run } from './data.js';
import type { RegisteredWorkflow, RoleBlueprint } from './contracts.js';
import type { InvokeRequest } from './runtime-contracts.js';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { remote } from './remote.js';
import { ExplorationEngine } from './engine.js';
import { mountResearcher } from './researcher.js';
import { WorkflowRegistry } from './workflow-registry.js';
import { changePreview } from './change-preview.js';
import { settings as parseSettings } from './research-state.js';

const persistenceSchema: z.ZodType<Run> = runSchema;
const domain = defineDomain({ name: 'sla_runs', version: 1, tables: { runs: domainTable<string, Run>(persistenceSchema) } });
function view(run: Run | null) {
  if (!run) return null;
  const { sourceFiles, ...rest } = run;
  return rest;
}

export default class SlaService extends TypertRemoteService implements SlaEndpoints<Agent> {
  tasks = new WorkflowRegistry();
  calls = new Map<string, { steps: number; workSteps: number }>();
  researchOwners = new Map<string, { role: string; blueprint?: RoleBlueprint; structured: boolean }>();
  ready: Promise<void>;
  // Every entry point awaits ready before using these initialized resources.
  engine!: ExplorationEngine;
  domain!: Domain<typeof domain>;
  static inject = ['typert', 'agents', 'storageDomain', 'subagents', 'workingDirectory', 'shell', 'sandboxPolicy'];
  constructor(ctx: Context) {
    super(ctx, 'sla');
    this.tasks = new WorkflowRegistry();
    ctx.typert.register({ package: remote.package, face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: remote.descriptors });
    ctx.on('agent/created', async ({ agent }) => {
      const parentId = agent.session.header.parentSession;
      const owner = parentId && this.researchOwners.get(parentId);
      if (!owner) return;
      const { role, blueprint, structured } = owner;
      // Harness awaits creation listeners before the child's first model request.
      await mountResearcher(agent.ctx, role, blueprint);
      agent.ctx.tools.presentAs('native');
      const workSteps = () => this.calls.get(agent.id)?.workSteps ?? 24;
      const submitting = () => (this.calls.get(agent.id)?.steps ?? 0) > workSteps();
      // Assembly controls what the model sees; the native guard also rejects
      // stale/hallucinated tool calls before any side effect in the final step.
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembly = await next();
        // DSH assembles tools before pre-step increments the admitted count.
        if ((this.calls.get(agent.id)?.steps ?? 0) < workSteps()) return assembly;
        return { ...assembly, tools: assembly.tools.filter(tool => structured && tool.name === 'structured_output') };
      });
      agent.ctx.tools.guard(exec => submitting() && (!structured || exec.name !== 'structured_output')
        ? 'SLA 工作步骤已用完，本步只提交已有结果，不再执行工具。' : undefined);
      agent.ctx.systemPrompt.context({
        name: 'sla:invocation-budget', order: 1000, required: true, interpolate: false,
        text: () => {
          const steps = this.calls.get(agent.id)?.steps ?? 0;
          if (submitting()) return `本次 SLA 调用只剩结果提交步，工作工具已收起。${!structured ? '立即用 Markdown 汇报已完成的工作和未验证事项，不再调用工具。' : '立即调用 structured_output 提交已有结果；按本阶段格式如实说明未完成条件，不能把未执行的检查说成通过。'}产物已产生不等于结果已验证。`;
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
  registerWorkflow(workflow: RegisteredWorkflow) { return this.tasks.register(workflow); }
  assertWritable(parent: Agent) {
    if (this.ctx.sandboxPolicy.resolve({ session: parent.session }).mode === 'read-only') throw new Error('当前会话是只读模式，未执行评价或写回。');
  }
  async get(sessionId: string) {
    await this.ready;
    return JSON.stringify(view(this.engine.get(sessionId)));
  }
  async changes(sessionId: string) {
    await this.ready;
    return JSON.stringify(await changePreview(this.engine.get(sessionId)));
  }
  async action(agent: Agent, input: string) {
    await this.ready;
    const request = actionSchema.parse(JSON.parse(input));
    if (['start', 'steer'].includes(request.action) && !request.text) throw new Error('请输入目标或补充要求。');
    return JSON.stringify(view(await this.engine.action(agent, request)));
  }
  async invoke({ parent, role, cwd, prompt, schema, blueprint, settings, signal, onStarted }: InvokeRequest): Promise<unknown> {
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
      sessionId: SessionId(randomUUID()), parentAgent: parent, signal: combined,
      meta: { cwd, parentSession: parent.id, origin: 'subagent' },
      agentOptions: { ...parent.options, ...(config ? { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort } : {}) },
      setup: async (_ctx, agent) => {
        agent.session.append('sandbox/mode', { mode: 'workspace-write', source: 'delegation' });
        agent.session.append('approval/policy', { policy: 'never', source: 'delegation' });
      },
    });
    let activation;
    this.researchOwners.set(owner.agent.id, { role, blueprint, structured: !!schema });
    try {
      activation = await this.ctx.subagents.startActivation({
      provider: 'spawn', label: 'SLA · ' + role, delivery: 'caller', signal: combined,
      request: { parent: owner.agent, cwd, prompt: [{ type: 'text', text: prompt }], ...(schema ? { outputSchema: schema } : {}) },
      });
    } catch (error) { await owner.dispose(); throw error; }
    finally { this.researchOwners.delete(owner.agent.id); }
    this.calls.set(activation.childId, { steps: 0, workSteps: limits.maxStepsPerCall });
    const cancel = () => { activation.dispose().catch(error => this.ctx.logger.warn(String(error))); };
    combined.addEventListener('abort', cancel, { once: true });
    if (combined.aborted) cancel();
    let failure, settled = false;
    try {
      await onStarted(activation.childId);
      const result = await activation.result;
      settled = true;
      combined.throwIfAborted();
      if ((this.calls.get(activation.childId)?.steps ?? 0) > limits.maxStepsPerCall + 1) throw new Error(`子会话达到 ${limits.maxStepsPerCall} 个工作步和 1 个结果提交步上限，尚未提交完整结果；本次调用证据已保留。`);
      if (result.stopReason !== 'completed') throw new Error(`子会话未完成：${result.stopReason} ${result.diagnostic ?? '未提交完整结果'}`);
      if (!schema) return { summary: result.output.filter(x => x.type === 'text').map(x => x.text).join('\n') };
      if (!result.structured) throw new Error('子会话未提交结构化结果');
      return result.structured;
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      throw failure;
    } finally {
      combined.removeEventListener('abort', cancel);
      try { await activation.dispose(); }
      finally {
        this.calls.delete(activation.childId);
        await owner.dispose();
      }
      // DSH caller results settle after managed activity/descendant cleanup.
      // Only expose this fact after both activation and owner disposal succeed.
      if (failure && settled) Object.assign(failure, { quiescent: true });
    }
  }
}
