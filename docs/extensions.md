# 扩展 SLA

SLA 0.4 复用 DSH 的 Cordis 插件、服务和 Skill。探索内核管理尝试、制品、观测与决定，默认 SLA 策略负责搜索，领域工作流定义具体准备、评价和交付。`registerTask` 复用默认文件工作流，`registerWorkflow` 可接入其他制品与流程。内置参数工作流使用 JSON；未提供远程系统或数据库适配器。

## 组合领域工作流

完整例子是 [`extensions/parameters.js`](../extensions/parameters.js)，以 `dsh-sla/parameters` 随 bundle 挂载；[`examples/retrieval-parameters`](../examples/retrieval-parameters/README.md) 提供可复制的输入。它用已有固定评测器和数据建立基线，规划与提出参数使用两个 fresh spawn 角色，评价在 Host 独立进行，交付参数包；不创建代码候选或 `.sla` 评价脚本。

```js
import { defineWorkflow, jsonArtifact, verifyJsonArtifact } from 'dsh-sla/workflow';
export const inject = ['sla'];
export function apply(ctx) {
  ctx.effect(() => ctx.sla.registerWorkflow(myWorkflow));
}
```

`defineWorkflow` 是类型辅助，真正的注册验证由服务执行。`WorkflowDefinition`、`WorkflowContext`、`Artifact`、角色与交付类型从 `dsh-sla/workflow` 导入。

| 定义 | 职责 |
| --- | --- |
| id/version/name/description | 能力身份与适用条件；供项目选择器自动选择 |
| artifacts.verify(artifact) | 校验制品类型、内容摘要及所需资源。JSON 可复用 verifyJsonArtifact |
| evaluate({artifact, criteria, signal, execute}) | 独立评价完整制品，返回领域结果；输入是副本，修改输入会拒绝结果 |
| validateBaseline / compare / complete | 与下面的代码任务接口同义 |
| qualify(result, criteria) | 可选，同步返回 `{retain, deliver}`。默认二者为 valid；未通过检查不能交付 |
| projectEvidence(result) | 可选，同步返回可保存 JSON，最多 12000 字符，作为 Advisor 的领域摘要 |
| run(ctx) | 组合准备、探索、评价升级等阶段；恢复会重新进入，因此根据持久状态跳过已完成阶段 |
| deliver({artifact, evaluation, state, signal, authorize}) | 可选，交付前调用 authorize，再完成副作用并返回可保存的 JSON 回执 |
| recoverDelivery(state) | 可选，核对实际交付副作用，返回下述三种状态 |

`ctx.state()`、`ctx.artifact(id)` 返回副本。`ctx.saveState(value)` 保存领域进度，`ctx.status(stage,message)` 保存用户可读状态。工作流不能通过它们修改核心候选或伪造通过结果。

`ctx.initialize({criteria,artifact})` 校验并封存初始制品，实际评价和验证基线后建立探索。已有依据时直接返回当前状态。`ctx.observe(id)` 独立评价已封存制品；`ctx.reviseCriteria(criteria)` 持久化待发布事务、重测本目标候选并原子发布新版选择，中断后自动接续。

`ctx.search({plan,produce,afterTrial?})` 使用默认 SLA 策略：plan 接收状态和分支证据，返回 `{stop,reason,assignments}`；每项 assignment 包含 direction、可选 lane、hypothesis、instructions 和 evidenceTrials。produce 接收当前分支的 seed 制品、assignment、feedback、signal 及绑定本次尝试的 invoke，返回 `{kind,digest,payload}`。可用 `jsonArtifact(value)` 生成 JSON 制品。封存后评价中断，会在恢复时先评价同一尝试，不能重新调用 produce 替换它。afterTrial 接收完成的记录副本，可据此触发领域检查；它不替代评价。

`ctx.invoke({role,prompt,schema?,blueprint,cwd?})` 使用真实 DSH spawn。blueprint 声明 instructions、tools（files/search/skills/shell）和可选 mount(ctx)，后者可在子作用域装配普通 DSH 插件。工具和角色随作用域释放，模型、输出额度与用量沿用宿主。schema 存在即使用结构化结果，不以 role 名称猜测；工具组为空仍保留 DSH 自带的工作目录信息和结果提交能力。

交付恢复必须明确区分 `{status:'delivered',receipt}`、`{status:'absent'}`、`{status:'unknown',reason}`。没有提供恢复能力时，交付中断保持待核对状态；确认不存在副作用才能允许重试。扩展卸载取消其活动执行，同一 id/version 恢复后才能接续。

领域插件是可信 Host 代码，必须遵守 signal 和权限；接口不能隔离恶意插件。制品预览目前支持代码快照与 JSON；其他类型显示未提供预览，不把缺少展示当作没有改动。模型完整日志、导出、Token 统计使用 DSH，不另建平台。

## 方法扩展：DSH Skill

项目技能放在 `.agents/skills/<name>/SKILL.md`，也可由普通 DSH 插件通过 `ctx.skills.register` 提供。SLA 的选择、调查、规划、执行子会话装配官方 `dsh-skill-filesystem` 与 `dsh-tool-skill`，复用宿主技能服务和发现机制，随子会话卸载文件监听。项目 `.agents` 会进入候选快照，技能附带资源通过官方加载结果定位。默认快照排除 `.dsh`，项目内需随快照携带的技能使用 `.agents/skills`。

Skill 提供方法与资源，不替代实际执行的检查结果。当前使用源码和资源文件，不冻结用户级技能服务的后续内容变化；已建立的评价文件独立冻结。

## 默认代码工作流：registerTask

扩展通过 `inject = ['sla']` 依赖服务，再调用 `ctx.sla.registerTask(task)`。注册返回 disposer，放进 `ctx.effect`，随 DSH 插件卸载撤销注册。无需另外的安装器、目录扫描或插件市场。

```js
export const inject = ['sla'];
export function apply(ctx) {
  ctx.effect(() => ctx.sla.registerTask(myTask));
}
```

完整可运行的示例是 [`extensions/bugfix.js`](../extensions/bugfix.js) 与 [`extensions/performance.js`](../extensions/performance.js)。二者是独立 Cordis 插件，默认 bundle 分别挂载 `dsh-sla/bugfix` 和 `dsh-sla/performance`，核心没有导入它们。新包按 DSH 官方 `dsh plugin add <path>` 安装，通过普通 bundle patch 挂载。

| 字段 | 职责 |
| --- | --- |
| `id`、`version`、`name`、`description` | 唯一名称、三段版本、展示名、适用目标；供 Agent 根据自然语言与项目自动选择 |
| `prepare.schema`、`prepare.prompt(run)` | 调查子会话的结构化返回与任务方法；返回 `ready`、`criterion`，未就绪说明 `reason` |
| `instructions` | 可选的规划和执行指引 |
| `evaluate({ cwd, signal, criteria, execute })` | 在独立候选副本中执行检查，返回结果；`execute(command)` 使用 DSH shell、权限与取消机制，并记录命令原始输出 |
| `validateBaseline(result, criteria)` | 确认初始结果可用于本任务；不满足时抛错。缺陷任务可接受已复现的失败基线 |
| `compare(candidate, reference, criteria)` | 同步返回 `better`、`equal`、`worse` 或 `incomparable` |
| `complete(candidate, criteria)` | 可选同步完成判定；通过后提前结束本轮 |
| `qualify`、`projectEvidence` | 与上面的工作流接口相同；领域资格和证据摘要不需要改核心 |

类型从 `dsh-sla/extension` 导入。评价结果需要 `valid: boolean`、`summary: string`；可选 `display` 供原生面板展示，其余 JSON 字段归扩展解释，完整载荷保存在实验的 `evaluation` 中，不覆盖实验编号等核心身份。`valid` 表示该候选满足采用所需的检查，不能用“测量已执行”代替。全局最佳只接受有效改善；新方向可先保留落后全局的有效候选，再沿该方向继续。采用前再次评价并要求优于基线。核心不要求数值、单位、特定命令或 `SLA_RESULT` 协议，`parseResult` 只是可选辅助函数。

代码工作流的调查只新增 `.sla/` 中的检查文件，工作流预建目录；复用现有检查时可以为空。整个目录按内容哈希冻结，执行时复制到独立检查目录；运行后复核冻结文件，新缓存只留在本次检查目录。原项目只在用户采用且源文件未变时写回，即使原生评价不调用 shell，也会复核宿主只读权限。扩展是与 Host 同进程运行的受信任代码，注册接口不提供代码隔离；应使用传入的 `execute`，遵守取消信号和现有 DSH 权限。

使用 `parseResult` 时，正常完成检查必须退出 0，即使 `valid:false` 或 `passed:false`；非零退出、超时和输出截断都表示评价未完成。评价运行不得改写 `.sla/` 或项目文件，日志写 stdout，临时缓存可用副本中的 `.dsh/cache/`。缺陷已复现属于正常评价结果，不是设施错误。

## 身份与生命周期

每次探索记录选择理由、扩展 id/version 和评价文件哈希。一个目标版本内比较规则固定；修改目标会重建评价依据但保留任务扩展，改换任务类型请新建会话。不同扩展不共享可直接比较的分数。

同 id 重复注册失败。扩展卸载会取消其活动调用；恢复或采用时找不到同一 id/version 则停止，保留记录，不自动替换规则。改变评价执行或结果解释、基线有效性、候选比较、完成或审查资格，以及不兼容的输入输出契约时，必须提升任务扩展版本。仅澄清操作指引或展示，且保持已有产物兼容与通过条件不变时，可保持版本；具体源码与提示词修订由插件版本和 Git 提交标识。同版本源码真实性由包管理与开发者负责。提示词修订不会替换旧运行已冻结的评价文件；修正旧检查仍须重新建立评价依据。0.1 历史记录明确绑定 `code-performance@1.0.0`，保持旧评价文件。

持久化和界面继续复用 DSH；Token 明细使用宿主原有入口。本版不新增计费账本、额度预留或任务扩展管理界面。

## 可选独立审查

`review` 提供 `schema`、`prompt(run, context)` 和 `evaluate({cwd, signal, criteria, execute, check})`。`context` 给出 `phase`、允许新增文件的 `checkDirectory`、只读 `originalDirectory` 和此前实际失败；结构化结果为 `{hasChecks, summary}`，说明要保护的行为及其与目标修正的关系。新增文件只能位于 `.sla/<checkDirectory>/`。

`evaluate` 返回 `{passed:boolean, summary:string}`，不要复用缺陷基线的 `valid`。完整例子见 [`extensions/code-review.js`](../extensions/code-review.js)；Node 命令属于这个代码任务方法，核心不要求此运行时。新增检查会在初始项目和候选上独立执行，纳入后每次评价继续执行。核心把补充检查通过与任务 `valid` 合并为最终有效性，并在 `supplementaryChecks` 中记录结果，任务扩展不应占用这个字段。

0.3.2 支持审查结果附带 `title`（最多 60 字符的行为名称）和 `purpose`（最多 300 字符的保护行为说明）。二者由扩展的 schema 与 prompt 声明，核心只保存非空且符合长度的字符串，不参与通过判定；旧扩展可以继续只返回 `{hasChecks, summary}`。`purpose` 不包含当前通过/失败结论，提出检查时的发现放在 `summary`。界面使用本次 `supplementaryChecks` 显示结果，将原始 `summary` 放在有候选、版本标注的历史来源下。默认代码任务已采用新字段，评价与比较规则未变化，因此任务版本保持 `1.1.0`。

Worker 继续使用 DSH 普通文本输出。核心提示词约定 `### 改动说明` 和 `### 尚未验证` 两个简短 Markdown 小节；界面仅提取明确标题下不超过 500 字符的内容，其他文字保留在执行记录。缺少或过长时显示文件改动与缺失说明，不从假设或日志推断结果。

任务可以不提供 review；这表示没有独立审查能力，不是审查通过。默认代码任务因新增审查语义升级为 `1.1.0`。发布、恢复与候选身份规则见[核心规则](core.md)。
