# 扩展工作流

统一公共入口是 `ctx.sla.registerWorkflow(workflow)`。安装、配置、生命周期与方法资源复用 DSH Cordis 插件和 Skill。类型与构造函数均从 `dsh-sla/workflow` 导入。

![领域扩展的位置：性能优化、缺陷修复、检索参数与自定义工作流，共用 SLA 能力和 DSH 宿主](images/architecture.drawio.svg)

下面按复用代码流程和定义自有流程两种方式接入。工作流与持久状态的协作见[核心架构](core.md)。

```ts
import type { Context } from '@deepseek-ai/cordis';

export const inject = ['sla'];
export function apply(ctx: Context) {
  ctx.effect(() => ctx.sla.registerWorkflow(myWorkflow));
}
```

构造函数标记工作流种类，注册时校验定义。返回的 disposer 撤销能力并取消活动执行；将它交给 `ctx.effect` 管理。

## 复用代码工作流

`defineCodeWorkflow({id, version, name, description, prepare, evaluate, validateBaseline, compare, ...})` 复用文件调查、独立候选、审查、恢复和代码交付。

仓库完整源码为 `extensions/performance.ts` 和 `extensions/bugfix.ts`；发布包提供对应的 [性能 JS](../dist/extensions/performance.js) 与 [缺陷修复 JS](../dist/extensions/bugfix.js)。

| 字段 | 契约 |
| --- | --- |
| `prepare.schema / prompt(run)` | 调查输出包含 ready、criterion；未就绪说明 reason。检查文件放 `.sla/` |
| `evaluate({cwd, criteria, signal, execute})` | 在独立副本评价，返回 `{valid, summary, display?, ...}` |
| `validateBaseline(result, criteria)` | 检查初始结果是否适合本任务；缺陷修复可以接受已复现的失败基线 |
| `compare(a, b, criteria)` | 返回 better / equal / worse / incomparable |
| `complete(result, criteria)` | 可选完成判定 |
| `qualify(result, criteria)` | 可选 `{retain, deliver}`；默认都取 valid，未通过结果不能交付 |
| `projectEvidence(result)` | 可选领域摘要，JSON 且不超过 12000 字符 |
| `review` | 可选独立检查能力：schema、prompt、evaluate；参见 `extensions/code-review.ts` |

核心不要求数值或特定输出协议。可选 `parseResult` 读取命令最后一行 `SLA_RESULT <JSON>`；正常得到失败结论也应退出 0，非零退出、取消、超时、输出截断表示评价未完成。

评价不能修改源文件或冻结的 `.sla/` 目录，临时缓存使用检查副本的 `.dsh/cache/`。`execute` 复用 DSH shell、权限和取消机制。

## 自定义制品和流程

`defineWorkflow()` 接收 `run(ctx)`、`artifacts.verify`、`evaluate`、基线与比较能力，以及可选 `deliver / recoverDelivery`。完整实现为仓库 `extensions/parameters.ts`（[发布 JS](../dist/extensions/parameters.js)）。它使用固定数据建立 JSON 基线，调用规划与参数角色，Host 评价后交付参数包。

| Context 操作 | 作用 |
| --- | --- |
| `state() / artifact(id) / evidence()` | 读取副本，不能通过修改返回值改变持久状态 |
| `status(stage, message) / saveState(value)` | 保存阶段和工作流自身的 JSON 状态 |
| `initialize({criteria, artifact})` | 校验初始制品并建立实测基线 |
| `search({plan, produce, afterTrial?})` | 使用默认 SLA 策略，提供规划与候选生产 |
| `observe(id) / reviseCriteria(criteria)` | 独立观测或事务性升级评价依据 |
| `invoke({role, prompt, schema?, blueprint, cwd?})` | 新建 DSH 子会话，使用声明的工具与结构化结果 |

`blueprint` 声明 instructions、tools（files/search/skills/shell）和可选 mount(ctx)，可在子作用域装配普通 DSH 插件。模型、输出额度和 Token 统计沿用宿主。

制品需提供 kind、digest、payload。JSON 可用 `jsonArtifact / verifyJsonArtifact`。`run` 在恢复时重新进入，应使用持久状态区分已完成阶段。

`deliver` 在每个实际写入前调用 `authorize()`，成功返回可保存的回执。`recoverDelivery` 明确返回 `{status:'delivered', receipt}`、`{status:'absent'}` 或 `{status:'unknown', reason}`；不能把未知副作用当成未发生。未实现恢复能力时，中断交付保持等待核对。

## 身份与 Skill

id/version 是探索的规则绑定，重复 id 拒绝注册；卸载会取消活动调用。改变评价语义、比较规则、交付条件或制品契约时提升工作流版本；现有探索不会自动改用另一个版本。

项目方法资源使用 `.agents/skills/<name>/SKILL.md`，也可用 DSH `ctx.skills.register`。Skill 提供方法，不能替代实际检查。

## TypeScript 扩展开发

可编译的最小例子见 [counter.ts](../examples/extensions/counter.ts)。它使用 JSON 制品和固定评价器，不调用模型；仓库与包安装验收都会严格检查该例子。

公开类型从 `dsh-sla/workflow` 导入。它们由 `src/workflow.ts`、`src/contracts.ts` 和 `src/data.ts` 生成，包中的 [workflow.d.ts](../dist/src/workflow.d.ts) 与实现同源。扩展项目使用 NodeNext、`strict: true` 和固定版本的真实 DSH 开发依赖，编译自己的 TS 后再作为普通 Cordis 插件安装；不要复制 DSH 的 Context、Agent 或工具 schema 声明。

`ctx.invoke()` 返回 `unknown`，应使用运行时 schema 或类型守卫再读取。制品 payload、工作流状态、交付回执必须是 JSON。`Evaluation` 保留领域自有字段，例如 `score` 或 `recall`；比较器应检查字段类型，不能把所有扩展强制成同一种分数。`schema` 使用 DSH 的 `ObjectJsonSchema`，固定版本不支持的字段会直接报类型错误。输入长度等业务校验仍在 Host 侧执行。

源码内包含正例和错误用法检查：无效工作流种类、工具组、比较结果、不完整交付回执、未经校验的模型结果以及不受支持的 DSH schema 字段均必须被拒绝。
