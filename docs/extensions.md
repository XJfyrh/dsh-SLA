# 扩展 SLA

SLA 0.3 复用 DSH 的 Cordis 插件、服务和 Skill。核心提供文件候选快照、实验调度、证据保存、暂停恢复和采用；任务扩展提供调查指引、可执行评价与比较规则。当前候选是本机文件项目，不提供远程系统或数据库的快照适配器。

## 方法扩展：DSH Skill

项目技能放在 `.agents/skills/<name>/SKILL.md`，也可由普通 DSH 插件通过 `ctx.skills.register` 提供。SLA 的选择、调查、规划、执行子会话装配官方 `dsh-skill-filesystem` 与 `dsh-tool-skill`，复用宿主技能服务和发现机制，随子会话卸载文件监听。项目 `.agents` 会进入候选快照，技能附带资源通过官方加载结果定位。默认快照排除 `.dsh`，项目内需随快照携带的技能使用 `.agents/skills`。

Skill 提供方法与资源，不替代实际执行的检查结果。当前使用源码和资源文件，不冻结用户级技能服务的后续内容变化；已建立的评价文件独立冻结。

## 能力扩展：普通 DSH 插件

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

类型从 `dsh-sla/extension` 导入。评价结果需要 `valid: boolean`、`summary: string`；可选 `display` 供原生面板展示，其余 JSON 字段归扩展解释，完整载荷保存在实验的 `evaluation` 中，不覆盖实验编号等核心身份。`valid` 表示该候选满足采用所需的检查，不能用“测量已执行”代替。核心只保留 `valid` 且优于当前候选的改动；采用前再次评价并要求优于基线。核心不要求数值、单位、特定命令或 `SLA_RESULT` 协议，`parseResult` 只是可选辅助函数。

调查只新增 `.sla/` 中的检查文件，核心预建目录；复用现有检查时可以为空。整个目录按内容哈希冻结，执行时复制到独立检查目录；运行后复核冻结文件，新缓存只留在本次检查目录。原项目只在用户采用且源文件未变时写回，即使原生评价不调用 shell，也会复核宿主只读权限。扩展是与 Host 同进程运行的受信任代码，注册接口不提供代码隔离；应使用传入的 `execute`，遵守取消信号和现有 DSH 权限。

## 身份与生命周期

每次探索记录选择理由、扩展 id/version 和评价文件哈希。一个目标版本内比较规则固定；修改目标会重建评价依据但保留任务扩展，改换任务类型请新建会话。不同扩展不共享可直接比较的分数。

同 id 重复注册失败。扩展卸载会取消其活动调用；恢复或采用时找不到同一 id/version 则停止，保留记录，不自动替换规则。升级有行为变化的扩展必须提升版本；同版本源码真实性由包管理与开发者负责。0.1 历史记录明确绑定 `code-performance@1.0.0`，保持旧评价文件。

持久化和界面继续复用 DSH；Token 明细使用宿主原有入口。本版不新增计费账本、额度预留或任务扩展管理界面。

## 可选独立审查

`review` 提供 `schema`、`prompt(run, context)` 和 `evaluate({cwd, signal, criteria, execute, check})`。`context` 给出 `phase`、允许新增文件的 `checkDirectory`、只读 `originalDirectory` 和此前实际失败；结构化结果为 `{hasChecks, summary}`，说明要保护的行为及其与目标修正的关系。新增文件只能位于 `.sla/<checkDirectory>/`。

`evaluate` 返回 `{passed:boolean, summary:string}`，不要复用缺陷基线的 `valid`。完整例子见 [`extensions/code-review.js`](../extensions/code-review.js)；Node 命令属于这个代码任务方法，核心不要求此运行时。新增检查会在初始项目和候选上独立执行，纳入后每次评价继续执行。核心把补充检查通过与任务 `valid` 合并为最终有效性，并在 `supplementaryChecks` 中记录结果，任务扩展不应占用这个字段。

任务可以不提供 review；这表示没有独立审查能力，不是审查通过。默认代码任务因新增审查语义升级为 `1.1.0`。发布、恢复与候选身份规则见[核心规则](core.md)。
