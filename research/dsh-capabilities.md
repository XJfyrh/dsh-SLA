# DeepSeek Harness 能力图谱：实现「无状态 Agent 研究循环（SLA）」的可行性调研

> 调研对象：Desktop 进程内实际安装的 DSH 0.2.1-rc.2（`C:\Users\12898\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\`，profile `desktop`）。
> 证据来源：`cordis_inspect_query`（Service/Event/Config/Tool/Slots 的权威契约）+ 安装包 `README.md` 与 `lib/index.js` + profile 组合层。
> 每条给出 verdict：**可直接用** / **需少量适配** / **缺失**。源码路径中 `$DSH` = `...\resources\app.asar\dsh`，`@ai/` = `$DSH\node_modules\@deepseek-ai\`。

## 0. 总体结论

SLA 的核心诉求——「Harness 持有研究状态；每个 Advisor epoch / Worker trial 重建全新 role 专属上下文；agent 是无状态调用」——**在 Host 插件 + agent preset 组合下基本可实现，但需要自己实现状态层与预算层**。DSH 提供了三块决定性原语：

1. **真正的 fresh-child 原语**：`ctx.subagents.startActivation()` + `spawn` provider（`inheritsParentContext: false`），每次调用生成新 session、新 Agent、零父对话继承，调用方提供完整 `prompt` 并拿到 `result`。
2. **按 invocation 重建完整上下文的注入点**：`ctx.systemPrompt.section({ complete: true })`（scoped 到 agent）、`system-prompt/assemble` waterfall、`agent/pre-step` waterfall（可整体替换进入该 step 的 messages）、`agent/request` waterfall（逐次请求覆盖 provider/model/effort/maxTokens）。
3. **DSH 自带的同构先例**：`ralph`（`@ai/dsh-tool-ralph`）就是「固定 foreground fresh-agent 循环 + 每轮只传有界 handoff + workspace 作长期记忆」的官方实现，SLA 只比它多 role 划分、候选/评分状态与 token 预算。

真正的缺口集中在四处：**无 per-invocation token 预算硬停**、**child usage 不随结果返回**、**无删除/清理 session 的 API**、**Windows 上无网络隔离（文件沙箱为 ACL 实现，非 Landlock 语义）**。

---

## (a) 插件与 bundle 形态：Host plugin / agent preset / client plugin

**Bundle 形态（可直接用）**。bundle 是 `package.json` 声明了 `dsh.bundle.patch` 的包：`$DSH\node_modules\@deepseek-ai\dsh-web-app\package.json` 中
```json
"dsh": { "bundle": { "patch": ["./cordis.patch.yml","./presets/standard.patch.yml", ...] } }
```
`patch` 可为字符串或字符串数组；`files`/`exports` 必须包含 patch、`locale/*.json`、`icon`（图标/多语言见 skill `host-plugin.md`）。`cordis.patch.yml` 是 Loader patch 层：`- insert: [rows]` 插入行，或 `- id: <existing>` 覆盖既有行（`config` **整体替换而非深合并**）。行字段：`id`、`name`（包 specifier）、`config`、可选 `disabled`（布尔/`!!js` 表达式）、`inject`、`intercept`、`isolate`；`name: cordis:group` + `group: true` 使 `config` 成为嵌套 entry 列表（用于 preset 隔离 `isolate: { workflowEngine: true }` 等）。实例见 `$DSH\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml`（`id: subagent`、`id: tool-subagent`、`id: tools`、`id: system-prompt` 等约 120 行）与 `...\dsh-web-app\cordis.patch.yml`（把 tool 行 `disabled: true` 交给 preset 挂载）。

**Host plugin 导出形态（可直接用）**：`index.js` 二选一，不可混用——`export function apply(ctx, config)`（可配 `export const inject = ['tools']`、`export const Config`），或以 service class 作 default export。所有注册必须落在 `apply` 内并用 `ctx.effect()`/`ctx.on()` 返回清理。`Config` 是 schemastery schema，在行激活时校验（`$DSH\...\dsh-tool-subagent\lib\index.js` 的 `const Config = z.object({...})` 即范例）。工具注册：`ctx.tools.register(defineTool({ name, description, parameters, output: { schema, render }, async execute(args, exec) { ... } }))`（`@ai/dsh-tools` README）。Service 注册即 Cordis service class（default export），可选 `@Remote` 装饰方法暴露给 UI。

**在 desktop profile 中如何被加载（可直接用）**：profile 只声明 bundle 列表与用户 patch：
- `C:\Users\12898\.dsh\profiles\desktop\package.json`：`dsh.profile.bundles = ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","@deepseek-ai/dsh-experimental-agent-team-profile","@deepseek-ai/dsh-experimental-auto-review","@anysearch/anysearch-dsh"]`；
- `C:\Users\12898\.dsh\profiles\desktop\cordis.patch.yml`：最后应用的用户层（示例里覆盖 `ui-chat`、`agent-default-model`、`llm-pi-ai` 等）。
新插件 = 一个工作区 bundle + `plugin_manager install_bundle`（本任务禁止执行）：它写 profile 依赖并选择 bundle，HMR 可即时激活；**替换已安装包的 JS 需要重启**才加载新一代模块。安装后可用 `Config.listConfigs` 拿 `packageDir` 复核。

**三者区别**：
- Host plugin：进程级 Loader 行，可提供 Service、注册事件监听、全局 Tool，拥有整个 Host 生命周期；desktop 的 host 平面包含 `subagents`、`workflow-ptc`、`token-meter`、`storage-domain`、`schedule`、`jobs` 等（见 `dsh-web-app\cordis.patch.yml` 保留清单与注释）。
- agent preset：一行 `@deepseek-ai/dsh-agent-preset`，`config.id` 是会话保存的 preset 身份，`config.plugins` 是**每个 Agent 独立挂载**的子 entry 列表（tools、prompt 段、persona、delegation 工具、compaction…）。实例：`$DSH\node_modules\@deepseek-ai\dsh-web-app\presets\standard.patch.yml`（`id: preset-standard`，`config.id: standard`，`plugins` 含 `persona`、`agent-instructions`、`time-context`、`tool-fs`、`tool-subagent`、`workflow-ptc`、`tool-workflow`、`planning`/`compaction`/`delegation` 三个 `cordis:group` 隔离组）。preset 注册表在 Host：`@deepseek-ai/dsh-agent-preset-registry`（`config.default: standard`）。preset 是组合、不是沙箱：YAML 可执行 Host 代码。
- client（UI）plugin：`package.json` 带 `dsh.client` 字段的包，进入 Web roster（`dsh-web-app\cordis.patch.yml` 注释：`dsh.client` rows 是 `window.__DSH_BOOT__` 的浏览器清单），由 `clientModules`/`webServer` 提供 bundle 与 index 注入；它通过 slot 注册渲染，不能直接 require Harness client 包。修改 client 代码需 `pnpm run dev:web` 监听才有免刷新 HMR，否则重建并刷新页面。

---

## (b) 从代码发起「全新无状态」agent 调用

`$DSH\node_modules\@deepseek-ai\dsh-agent\README.md`、`dsh-agent-loop\README.md`、`dsh-tool-subagent\lib\index.js`、`dsh-subagent\README.md` 是权威依据。

| 入口 | 契约 | 全量 prompt | 全新 session | 结果 | model/effort/cwd |
|---|---|---|---|---|---|
| `ctx.agentLoop.create(id: SessionId, options: AgentOptions = {}, meta: Pick<SessionHeader,'cwd'> = {}): Promise<Agent>` | 直接用给定 id 建 Agent+Session | ❌ 无 prompt 参数 | ✅（新 id 即新 session） | ❌ 无 result；需 `followup()`+`whenIdle()` 读历史 | ✅ `AgentOptions{provider?,model?,reasoningEffort?,maxTokens?}`；`meta.cwd` |
| `ctx.agents.create(options: CreateAgentOptions): Promise<AgentHandle>` / `ctx.agentLoop.createAgent(ownerCtx, options)` | `CreateAgentOptions{sessionId; parentAgent?; meta?{cwd?,parentSession?,isSeeded?,origin?:'subagent',delegationDepth?,agentPreset?}; inheritedEventCount?; seed?: readonly SessionEvent[]; agentOptions?: AgentOptions; signal?; setup?: AgentSetup}` | ❌（可用 `agent.followup({content})` 注入） | ✅（`meta.origin:'subagent'` 可伪装 child） | `AgentHandle{agent, dispose()}`；结果靠 `agent.whenIdle()` + `session.deriveMessages()` | ✅ 全部 |
| `ctx.agents.resume(options: ResumeAgentOptions)` | `{resumeSessionId; parentAgent?; agentOptions?; signal?; setup?}` | ❌ | ❌ 恢复历史（**违反 SLA**） | — | ✅ |
| **`ctx.subagents.startActivation(spec)`** | `SubagentActivationSpec{provider; label; childId?; request: Omit<SubagentStartRequest,'label'|'signal'>; signal; delivery:'parent'|'caller'}`；`SubagentStartRequest{cwd?; agentPreset?; label?; prompt: ContentBlock[]; parent: Agent; signal; agentOptions?; outputSchema?: ObjectJsonSchema; maxDepth?}` | ✅ **`request.prompt` 即完整初始 user message** | ✅ spawn provider `inheritsParentContext = false`（`dsh-subagent-spawn-in-process\lib\index.js` 模块注释："its own session, own system prompt, zero parent context"） | ✅ `SubagentActivation{childId; messageId?; result: Promise<SubagentResult>; dispose()}`，`SubagentResult{output: readonly ContentBlock[]; structured?; diagnostic?; stopReason}` | ✅ `cwd`/`agentOptions`/`agentPreset`/`outputSchema`/`maxDepth`；`delivery:'caller'` 可无父通知、可临时（ephemeral）session |
| `ctx.workflowEngine.start(request: WorkflowStartRequest): WorkflowRun` | `{script: string; meta: WorkflowMeta; args?; subagentProvider?; maxTotalAgents?; parent: Agent; signal?}` → `WorkflowRun{id; meta; result: Promise<WorkflowResult>; cancel(reason?); dispose()}`，`WorkflowResult{value: unknown; stopReason:'completed'|'cancelled'|'error'; error?; agentsStarted}` | ✅ 由脚本的 `agent(prompt, opts)` 提供 | ✅（engine 用配置的 provider，默认 `spawn`，`dsh-workflow-ptc`） | ✅ 脚本 return 的 JSON 值 | ⚠️ 仅 `agent()` opts / phase 级 `provider`/`model`；**无 cwd、无 agentPreset、无 per-child system prompt** |

关键事实：
- **`ctx.agents.create` 没有 prompt 字段**；prompt 走 inbox（`Agent.followup`/`steer`/`inject`，`@ai/dsh-agent` README "Drive an agent's conversation"）。因此「一条调用 = 一个 prompt + 一个结果」的最短路径是 `subagents.startActivation`，不是 `agents.create`。
- child 的作用域/工具限制**由 preset 决定**：`tool-subagent` 的 `agentPreset`/`allowedAgentPresets` 只对 `capabilities.agentPreset && !inheritsParentContext` 的 provider 生效（`dsh-tool-subagent\lib\index.js` `SubagentPresetSelection.assertProvider`）。未显式指定时 child 加入父的当前 preset revision（`dsh-subagent\README.md` "Child presets"）。
- 模型路由：child 默认继承父 route 中兼容字段；`agentOptions` 显式覆盖；`preflightChildLlmRoute` 在创建前经 `ctx.llm.resolveCallConfig()` 校验；Host 级 allowlist 由 `ctx.subagentModelSelection.current(): SubagentModelSelectionSettings` 采样（profile patch 已启用 `subagent-model-selection-settings`，allowlist = `deepseek-account/deepseek-flash`、`qwen-token-plan-cn/qwen3.8-flash`）。
- 并发上限：`@ai/dsh-subagent` Host 配置 `maxActiveSubagents` 默认 **8**（每棵 activation 树；超限 `ACTIVATION_LIMIT_REACHED`），N 路并行 Worker 需显式调高；`workflow-ptc` 的 `maxConcurrentAgents` 默认 `0`（取 CPU 并行度）、`maxTotalAgents` 默认 1000。
- verdict：**fresh 无状态调用可直接用**；「角色化 + 每 epoch 重建 context」需预设/监听器配合 → **需少量适配**。

---

## (c) Token 计量

服务契约：`ctx.tokenMeter.measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement`、`estimateMessage(message: Message): number`（`$DSH\node_modules\@deepseek-ai\dsh-token-meter\README.md`）。

```ts
interface TokenMeasurement {
  readonly logRevision: SessionLogOffset
  readonly baseline: { kind:'none'; tokens:0 } | { kind:'estimated'; tokens:number } | { kind:'usage'; tokens:number; usage: Readonly<TokenUsage> }
  readonly surfaceDeltaTokens: number
  readonly totalTokens: number        // 请求+响应压力
  readonly surfaceTokens: number      // 仅 surface，= sum(nodes[].tokens)
  readonly nodes: readonly TokenSurfaceNode[]  // {seq, tokens, heuristicTokens}
}
interface TokenUsage { inputTokens; outputTokens; totalTokens?; cacheReadTokens?; cacheWriteTokens?; reasoningTokens? }
```
- **计量单位是 session**：`measure()` 重放该 session 的 durable tail；每次调用 O(surface)，不产生模型请求。文本按固定启发式（4 字符≈1 token）+ 块/角色开销，**不是账单级精度**。
- **per-role 归因没有原生累积器**：token-meter 注册三个 projection unit —— `tokenUsage`（`uncachedInputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`）、`contextPressure`（`pressureTokens`/`projectedTokens`/`contextWindow`）、`contextBreakdown`（`systemTokens`/`toolsTokens`/`messageTokens`）。读取：`ctx.sessionProjections.stateOf(session, 'tokenUsage')`。一个 session 对应一个 child，故「每 child / 每 role 用量」= 自己按 sessionId 建账本。
- **父读子用量**：`SubagentResult` 无 usage 字段（见 (b) 类型），`subagent/end` 也只给 `SubagentRunEndInfo`。可行路径两条：① 在根/Host ctx 监听 `session/event`（`(session, event)`，`assistant/message.data.usage?: TokenUsage` 已在 SessionEventMap 中）；scoped 事件会向祖先 scope 分发（`tool-subagent` 即在 apply 级监听 `agent/created` 收到全部 agent 事件），再按 `session.header.parentSession`/已知 `childId` 归集，spawn 与 caller delivery 都能覆盖；② 结束后用 `ctx.sessionQuery.readSession(childId)`/`readSurface(childId)` 折叠 `assistant/message.usage`（要求 persistence 已挂载；`delivery:'caller'` 的临时 session 在 dispose 后即不可读）。
- **「累计 token 预算 + 硬停」**：**缺失原生能力**。`dsh-workflow` README 明确 "No token-budget vocabulary"；tokenMeter 只测量不做决策；`AgentOptions.maxTokens` 只是单次请求输出上限。可实现的近似 = Host 插件自建账本（fold usage）+ 在 `agent/pre-step`（`PreStepDecision = {kind:'reject'} | {kind:'enter', messages, startsRequestSeries?}`）拒绝进入下一步，或用 `ctx.tools.guard()`（同步、单调、不可被后续监听器翻案）拒绝工具调用，或 `ctx.approval`/`subagents.interrupt` 终止。精度受启发式估算与「请求已发出」的时间差限制，**无法在一次模型请求内部原子截断**。verdict：**需少量适配**（近似硬停可做，精确硬停缺失）。

---

## (d) Session 持久化、恢复与「无状态」边界

- **存储与恢复**：`@ai/dsh-base\cordis.patch.yml` 中 `id: session-persistence-jsonl` 配置 `root: !!js dshHomePath('sessions')`；Session 是 append-only 事件日志（`@ai/dsh-session`），`SessionHeader{version,id,createdAt,cwd?,parentSession?,isSeeded,origin?,delegationDepth?,agentPreset?}`。`ctx.sessionPersistence` 只暴露 `create(header)`/`open(id, access)`/`flush()`/`stat()`/`list()`——**没有 delete/remove**。`ctx.sessions` 只有 `create/prepare/enter/announce/flush/get/list/fork`；`ctx.workspaceRegistry.archiveSession(sessionId)` 是「归档隐藏」而非删除。结论：**无法清除/删除 child session 日志（缺失）**；SLA 下每 epoch/trial 一个新 session，会在 `$DSH_HOME\sessions` 持续累积，需要自建保留/清理策略（例如自己的 storage domain 索引 + 存档，日志本身不可删）。
- **恢复**：`ctx.agents.resume({resumeSessionId,...})` 与 `agentLoop.resume`；冷恢复要求 persistence + session query（`dsh-subagent` README）。SLA 应**永不 resume**，恢复语义只用于调试。
- **压缩**：`ctx.compaction.compactIfNeeded/compactNow/compactRegion` 都作用于**单个 session 的 surface**；compaction 只是「隐藏被取代事件」，不删除。因此「每次调用一个全新 session」天然避免跨 invocation 的对话堆积；反之若复用 session，压缩只在该 session 内进行。
- **内置「fresh session per invocation」原语**：**有**——`subagents.startActivation` + `spawn`（最佳）、workflow 的 `agent()`（每次调用一个 managed Activation）、`ralph`（固定 fresh-agent 轮次循环）。它们都通过 `CreateAgentOptions.meta.origin='subagent'`/`delegationDepth` 建立 child 关系并写 `subagent/catalog` 到父 log（`delivery:'parent'` 时）。
- **child 从父继承什么**：spawn 不继承对话；继承父的 origin 元数据与 permission roots（`dsh-subagent` README "Use this package"）；`cwd` 默认捕获父当前目录（可覆盖）；`agentPreset` 默认父当前 revision（可显式覆盖，会写 `agent-preset/selected`）；模型路由默认继承父兼容字段；system prompt **不继承文本**，由 child 自己的 preset 重新组装，但 runtime context 会带 `subagent:delegation` 声明（含「权限已固定、不可自行扩权」）、sandbox policy、approval policy 等。

---

## (e) 上下文组装：能否让一次调用的全部内容由 Harness 构造

可以，而且是 DSH 的强项，但入口是 **scope**（per-Agent）而非全局参数。

- **system prompt**：`ctx.systemPrompt.section({ name, order, text: string | ((ctx:AssembleContext)=>string), interpolate?, complete? })`；`complete: true` 的 section 在 assembly 后成为**唯一** system prompt（多于一个 effective complete section 会失败）。`ctx.systemPrompt.context({name, order, text, interpolate?, required?})` 是变成 sourced user-role 快照的运行时事实；`variable(name, provider)` 供 `{{name}}` 插值；`tools(provider)` 贡献 schema；`suppressRuntimeContext()` 关闭可选 runtime context。`systemPrompt.assemble(context: AssembleContext)` 返回 `PromptAssembly{sections, contexts, tools, variables}`，`system-prompt/assemble` 是专家级 waterfall，可整体替换 assembly。
- **逐 step 的 user 内容**：`agent/pre-step` waterfall：`(payload:{agent,messages:UserMessage[],turn,step,signal}, next) => Promise<PreStepDecision>`，返回 `{kind:'enter', messages:[...], startsRequestSeries?}` 可**整体替换**进入该 step 的消息；`{kind:'reject'}` 可拒绝。这是「Harness 构造 payload、无对话堆积」的精确机制。
- **逐请求的调用配置**：`agent/request` waterfall 返回 `LlmCallConfig{provider, model, reasoningEffort?, temperature?, maxTokens?, stop?}`，可逐 epoch 指定模型/effort（并写 `request/header` 供审计）。注意 `EpochHeader.system?: never`——**system prompt 不在 request 里**，它作为 surface node 0 的 `system/message` 进入 derived history。
- **per-role 可实现性**：是的。两条路：① 每个角色一个 preset（`config.plugins` 决定工具/persona/段），`startActivation({agentPreset:'worker'})` 选择；② Host 插件在 `agent/created` 拿到 `agent.ctx` 后注册 `agent.ctx.systemPrompt.section({complete:true})`、`agent.ctx.tools.restrict()`、`agent.ctx.on('agent/pre-step', ...)`，仅对该 Agent 生效（`@ai/dsh-agent` README "Scope registrations to one agent"；`references/practices.md` 要求把 per-agent 注册包在 `agent.ctx.effect()` 并保存 disposer）。per-invocation 动态 payload 用路 ②（插件全局监听 `agent/pre-step`，按 childId/role 构造 messages）。
- 结论：**「整次调用的 user/context 完全由 harness 构造、无对话 buildup、按 role 变化」可直接用**（`agent/pre-step` + `complete` section + preset）；**一次 invocation 内禁止对话增长**没有内建开关，只能由插件每步重写 messages 或干脆每步一个 fresh child。

---

## (f) 并发与隔离

- **worktree**：`ctx.worktrees.create(agent: Agent, request: CreateWorktreeRequest = {}, signal?): Promise<CreatedWorktree>`，返回 `{path, branch, baseCommit, repositoryRoot}`，并**自动** `ctx.workingDirectory.set` 到 canonical checkout；默认目录 `<checkout root>/.agents/worktrees/<name>`，每次新建分支、保留产物（`@ai/dsh-experimental-worktree` README）。`ctx.workingDirectory.set(agent, path, signal?)` 也可单独切换，且是模型可见日志（`working-directory` 贡献 directory context）。
- **每个 worker 独立 workspace**：把 `startActivation({request:{cwd: worktree.path, ...}})` 指向各自 worktree，即得 N 个隔离 checkout + 独立 session + 独立 Agent。workflow engine 的 children 则统一继承 run 启动时捕获的目录（`workflow-ptc` README "captured directory when the parent later moves"），**不能 per-child 换 cwd**。
- **sandbox/permissions**：`ctx.sandboxPolicy.resolve(request): SandboxExecutionPolicy`、`defaultMode: SandboxMode`（`read-only | workspace-write | danger-full-access`）、`overrideOf(session)`；模式切换是 log-only `sandbox/mode` 事件，**按 session** 记录并跨重启回放（`@ai/dsh-sandbox-policy` README）。`ctx.approval.setPolicy(agent, policy: ApprovalPolicy)` 可按 Agent 设审批策略；`ctx.fs.writeText(target, content, expected?, signal?, sandboxPolicy?)` 允许 per-call policy。**注意**：child session 是独立 session，其 sandbox mode 由它的日志折叠 + 部署默认决定（`dsh-base` 默认 `workspace-write`，可被 `DSH_PERMISSION_MODE` 覆盖），父的会话差异不会自动传播；`sandboxPolicy` 无公开 setter，插件只能靠追加 `sandbox/mode` 事件或 per-call policy 施加约束（**需少量适配**）。
- **subprocess**：`ctx.subprocess.spawn(spec: SubprocessSpawnSpec): SubprocessHandle`、`spawnTerminal(...)`、`terminalEnvironment()`、`resolveExecutable(command, env?, signal?)`；沙箱 provider（Windows：`@ai/dsh-sandbox-windows-acl`，`dsh-base` 挂 `dsh-sandbox-local`）负责实际约束。**网络不受文件策略限制**（`workflow-ptc` README 明示 "Network access is not restricted by the file policy"）→ Worker 的网络访问无法用现有公开 API 隔离（**缺失**，除非自建 proxy/凭据层）。
- verdict：**N 路并行、各自独立 workspace 可直接用**（worktrees + cwd + spawn children）；需同时把 `maxActiveSubagents` 从 8 调高，并接受「同用户、无网络隔离」。

---

## (g) 研究状态的持久化

优先级建议：**`ctx.storageDomain`（主） > `ctx.fs`（大对象/工件） > session log（只作派生/审计）**。

- **storageDomain（可直接用，最适合 candidates/outcomes/checkpoints）**：`defineDomain({name, version, tables:{ rows: domainTable(schema) }, ...})` 在插件模块加载时声明并 export；消费端 `const domain = await ctx.storageDomain.open(spec)`，同步读 `domain.table('rows').get(id)`，写 `put(id, record)` / `update(id, fn)` / `delete(id)` / `global.set()`，每次写**先落盘再解析**并按序 emit `domain/changed(change: DomainChanged)`（`@ai/dsh-storage-domain` README）。`dsh-base` 已挂 `storage-domain`（`backend: json`，路由可配 `routes`），落盘在 `$DSH_HOME\storages`，重启后 open 时按 schema 全量校验。持久、可查询（`get/update` + 自建索引表）、可被 Host Tool 读取 → **这正是 SLA 的「harness 持有研究状态」**。注意记录是纯 JSON、`update` 的 transform 在写链槽位运行，不要原地改返回值。
- **session log**：`session.append(type,data,opts)`/`deriveMessages()`；**不能新增自定义 event type**（未知类型需 `ignorable:true`，live `append` 无法设置；`appendPluginRecord` 仅限实验包）。因此研究状态写 storage domain，不要写 session。
- **fs / spillStore**：`ctx.fs.resolve/readText/writeText/editText/listDir/stat/watch`（`FsTarget` 抽象、可被 sandbox 约束）；`ctx.spillStore.saveText({...}): Promise<SpillRef>` 适合大文本片段（`dsh-base` 的 `spill-policy` 以 `maxInlineTokens: 12500` 溢出）。工件（候选代码、patch、报告）放 fs；结构化索引放 domain。
- **`domain/changed` + `ctx.sessionProjections.onChanged`** 可作为「状态变化 → UI/调度器」的推送源。

---

## (h) Preset / 角色

- 注册：`ctx.agentPresets.register(definition: PresetDefinition): Promise<() => Promise<void>>`、`list()`、`resolve(id?)`、`readDocument(id)`、`mount(ctx, id?)`、`select(agent, agentPreset): Promise<string>`、`recompose(ctx, id)`、`inspectCompositions(ctx?)`、`compositionInventory()`、`acquireScope(id?)`、`composeFrom(ctx, parent)`、`composedPreset(ctx)`、`serviceFor(agent,'name')`（Service 目录 + `@ai/dsh-agent-preset-registry` README）。
- **YAML 结构**（`$DSH\...\dsh-web-app\presets\standard.patch.yml` 为完整样例）：
```yaml
- insert:
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config: { prefix: 'You are a coding agent powered by the {{model}} model.' }
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
          - id: delegation
            name: cordis:group
            group: true
            isolate: { workflowEngine: true }
            config:
              - id: tool-subagent
                name: '@deepseek-ai/dsh-tool-subagent'
                config: { provider: spawn, toolName: subagent, modelSelectionSettings: true }
```
字段：`id`（必填，稳定身份）、`plugins`（必填子 entry 列表）、`name`/`description`/`order`（展示）。
- **插件能否注册 preset 并逐 child 选择**：能。`agentPresets.register()` 注册（effect-scoped），`select(agent, id)` 对空白 session 记录选择；**child 的逐次选择走 `SubagentStartRequest.agentPreset`**（`startActivation`），这是 SLA 按 role 分派 worker/advisor 的推荐路径。`tool-subagent` 另可用 `allowedAgentPresets` 做模型面 allowlist。
- **不同 role 不同工具/system prompt 是否可行**：**可直接用**。role = preset（工具行集合 + persona/段 + 可隔离 `workflowEngine`/`compaction`），`systemPrompt.section({complete:true})` 可让某 role 的整段 system prompt 完全由插件提供；`ctx.tools.restrict()` 可在 agent scope 进一步收窄。限制：preset 是组合不是安全边界；旧 revision 不跨重启保留；用户 override 会整体替换子列表。

---

## (i) SLA 循环的驱动方式

| 驱动 | 机制与签名 | 阻塞/超时 | 取消 | 进度面 | verdict |
|---|---|---|---|---|---|
| 自定义长工具（同步跑完循环） | `ctx.tools.register(defineTool({..., async execute(args, exec) {...}}))`；`exec.signal` 协作取消；工具自身可声明 `timeoutMs`，不声明则无超时（`dsh-tool-call-timeout-policy` 只对声明了 limit 的工具生效） | 阻塞父 turn 直到返回 | `exec.signal`、`agent.cancel()` | native 工具卡片；`presentCall/presentResult` 仅 Host 消费 | 可直接用（研究循环最直接） |
| workflow engine | `ctx.workflowEngine.start({script, meta, args?, subagentProvider?, maxTotalAgents?, parent, signal?})` → `WorkflowRun{result,cancel,dispose}`；PTC 引擎在独立 Node 进程、无整体 elapsed deadline、`timeoutMs: null` | 前台，父 turn 等 result | `run.cancel()`、`signal`、`dispose()` | `workflow/start|phase|log|agent-start|agent-end|end` 事件（observe-only，payload 是 run 快照，不含 live handle） | 可直接用（推荐做 epoch 编排） |
| ralph | `ralph` 工具 `{objective, maxRounds?}`，固定剧本：每轮 fresh child（provider 必须 `inheritsParentContext:false` 且支持 `outputSchema`），只传 objective/round/cap/handoff；结果 `complete|blocked|budget-limited` + rounds | 阻塞 | `exec.signal` → `run.cancel()` | generic 卡片 | 可直接用（最接近 SLA 的先例；但无 role/无 token 预算） |
| goals | `ctx.goals.create/get/edit/pause/resume/complete/block/clear(agent, ...)` + `goal-round-driver`（`dsh-base` 已挂） | 自动 continuation rounds | pause/block | `goal/changed`、GoalBar | 需少量适配（**同 session**，不满足无状态） |
| schedule | `ctx.schedule.create(sessionId, request, signal?)`、`list/catalog/history/update/delete`；到期作为**原 session 的 follow-up** 投递，跨重启持久 | 非阻塞 | delete | `schedule/changed`、ui-schedule | 需少量适配（持久定时器，但不是 fresh agent） |
| 插件加载即启动的 Host service | `apply(ctx)` 里 `ctx.effect()` 启一个循环；用 `ctx.setTimeout/interval`（timer service）；对某个 live Agent 调 `agent.followup()` 唤醒（`inject()` 不唤醒，见 practices.md） | 自管 | `ctx.effect` disposer + AbortController | 自建 Remote/stream | 可直接用（但必须自己处理生命周期/重启恢复） |
| background jobs | `ctx.jobs`（`dsh-jobs` 契约）+ `job_*` 工具；owner = 启动它的 agent session，**进程退出即死**，无持久执行 | 非阻塞 | `job_kill`/`kill` | job 事件流、ui-jobs | 不适合驱动 SLA 主循环（适合单步长任务） |

**推荐架构**：Host 插件注册一个「run research loop」工具或一个 service，循环体内用 `subagents.startActivation({delivery:'caller'})` 串行/并行跑 epoch 与 trial，用 `workflowEngine` 做批量 fan-out，状态写 storage domain，预算用 `session/event` 折叠 usage 后在 `agent/pre-step` 拒绝下一步。

---

## (j) UI（次要）

Host 插件可以向 client 推状态：Host service 方法加 `@Remote({ mode: 'stream' })`（参见 `terminalController.retain/attach`、`jobController.follow/list`、`remoteAccess.follow`），或对 session 派生状态用 `ctx.sessionProjections` 注册 projection 并声明 `wire.view`，让 Client 直接拿到已折叠值（`references/practices.md` §Performance/UI）。Dashboard 需要 **client plugin** 在 slot 中渲染（候选表、分数曲线、worker 泳道）：可参考 `@deepseek-ai/dsh-client-ui-jobs`（session-header 名册 + 流式面板）、`dsh-client-ui-schedule`（任务目录）、`dsh-client-ui-workflow-run`（单次 run 可视化）、`dsh-client-ui-goal`。**未验证**：本会话 `Slots.listSubTree` 两次超时（页面未连接），具体 slot key（如 `conversation.chat.node`、`sidebar-right`、`session-header`）需连上 GUI 后复核，故 verdict：**需少量适配 + 需现场验证**。

---

## (k) 缺口、风险与「纯 workflow 脚本 vs Host 插件」

### 真实缺口（按严重度）
1. **无 per-invocation token 预算硬停**：tokenMeter 仅测量；`workflow` 无 token 预算词汇；`maxTokens` 仅单请求输出。只能做「步间近似硬停」。→ 缺失。
2. **child 用量不随结果返回**：`SubagentResult` 无 usage，`subagent/end` 无 usage；必须自建 `session/event` 折叠或 `sessionQuery` 冷读；caller-delivery 的 ephemeral session 结束后不可读。→ 需少量适配。
3. **无删除 session 的 API**：`sessions`/`sessionPersistence` 无 delete，只有 archive；日志永久累积。→ 缺失。
4. **无 per-child sandbox/net 隔离**：child session 从部署默认 mode 起步，`sandboxPolicy` 无 setter；网络不受文件策略限制（PTC 明示）；Windows 用 `dsh-sandbox-windows-acl`（ACL），并非 Landlock 等价物。→ 需少量适配（文件）/缺失（网络）。
5. **workflow 脚本的表达力边界**：`agent()` 只能覆盖 provider/model（+label/phase），**不能指定 cwd、agentPreset、system prompt 或 tools**；run 无 journaling/resume、无 background start/poll、必须前台 await；脚本只回传最终 JSON。→ 缺失（若要 role 化 / 每 epoch 全量重建 context）。
6. **并发上限与成本**：`maxActiveSubagents` 默认 8/tree；每个 child 是完整 Agent（独立 session、system prompt、持久日志），workflow 还额外起 PTC Node 进程；高 N 的 spawn 成本与日志成本显著。→ 风险。
7. **状态写路径必须走 storage domain**，不能发明 session event type；否则 reopen 失败或迁移丢数据。→ 风险。

### 纯 workflow 脚本 vs Host 插件
| 能力 | 纯 workflow 脚本 | Host 插件 |
|---|---|---|
| 每 epoch/trial fresh agent + 全量 prompt | ✅ `agent(prompt)` | ✅ `startActivation({prompt})` |
| 并行 fan-out / pipeline / phase 进度 | ✅ | ✅（或自建） |
| role 专属 preset / system prompt / tools | ❌ | ✅ |
| cwd/worktree per worker | ❌（继承 run 目录） | ✅ `worktrees.create` + `cwd` |
| 持久 candidates/outcomes/checkpoints | ❌（内存，跑完即失） | ✅ storageDomain |
| token 预算/账本 | ❌ | ✅（近似，见 c） |
| 重启后继续 / 后台运行 | ❌ | ✅（Host service + domain；仍受进程生命周期） |
| 自定义工具与 UI | ❌ | ✅ |
- verdict：**纯 workflow 脚本**适合「一次性、单轮、有界 fan-out」的 MVP；**忠实 SLA（多 epoch、role、预算、持久候选、可观测）需要 Host 插件 + 至少一个 agent preset**。建议形态：Host 插件（编排 + storage domain + 预算 + run 工具 + 事件）+ `preset-advisor`/`preset-worker` 两个 preset + 可选 client 插件做 dashboard。切勿用 `ralph` 直接当 SLA（它无 role、无评分/候选、报告不自证、预算只有轮数）。

---

## 附录：关键源码索引
- 组合层：`C:\Users\12898\.dsh\profiles\desktop\package.json`、`...\desktop\cordis.patch.yml`；`$DSH\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml`（L359-409 subagent/workflow 区、L234-276 sandbox/approval/permission、L138 session-persistence、L408 timeout-policy）；`...\dsh-web-app\cordis.patch.yml`（L460-589 preset 平面迁移 + 保留清单）、`...\dsh-web-app\presets\standard.patch.yml`。
- Agent/loop：`@ai/dsh-agent\README.md`、`@ai/dsh-agent-loop\README.md`、`@ai/dsh-agent\src\runtime-types.ts`（source map）。
- Subagent：`@ai/dsh-subagent\README.md`、`@ai/dsh-subagent-spawn-in-process\lib\index.js`、`@ai/dsh-tool-subagent\lib\index.js`（L354-615 apply/execute/preset/model-selection）。
- Workflow：`@ai/dsh-workflow\README.md`、`@ai/dsh-workflow-ptc\README.md`、`@ai/dsh-tool-ralph\README.md`。
- Prompt/token：`@ai/dsh-system-prompt\README.md`、`@ai/dsh-token-meter\README.md`。
- Session/storage：`@ai/dsh-session\README.md`、`@ai/dsh-session-query\README.md`、`@ai/dsh-storage-domain\README.md`、`@ai/dsh-session-projection\README.md`。
- 隔离/工具：`@ai/dsh-experimental-worktree\README.md`、`@ai/dsh-sandbox-policy\README.md`、`@ai/dsh-tools\README.md`、`@ai/dsh-tool-call-timeout-policy\README.md`、`@ai/dsh-jobs\README.md`。
- 插件机制：`@ai/dsh-agent-preset\skills\cordis-plugin-development\references\{practices.md,host-plugin.md}`、`@ai/dsh-agent-preset\README.md`、`@ai/dsh-agent-preset-registry\README.md`。
