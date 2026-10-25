# 维护审计

## 2026-10-25：0.4.0 重构后的失效内容与注释

起点 `b8e911e`，Windows / Node.js 24.19.0 / DSH 0.2.1-rc.2。在隔离分支审计生产入口、公开导出、持久化迁移、全部测试/示例/脚本及注释；注释清单覆盖 60 个受控 JS/MJS/TS 文件（含生成客户端），保留每个文件的原文和行号。下面的删除决定均在修改前写入 `artifacts/audit/`，交付归档位于主仓库 `artifacts/maintenance-audit-20261025/`。

### 删除与修改依据

| 内容 | 可核查证据 | 结果 |
| --- | --- | --- |
| `runtime.js` 的 `evaluate` 转发器 | `fe2476f` 将评价和审查迁入 `CodeWorkflow`；`CodeWorkflow.execute → finishReview(this)` 传入工作流自身，`review.js` 的评价调用直接到 `CodeWorkflow.evaluate`。Host/工具通过 action/get/recover，公开 exports 和类型未承诺此方法；不涉及持久字段。 | 删除遗留转发器，保留两种工作流的实际评价实现。 |
| `engine.test.js` 的 `adopt` 导入 | 该文件通过 `engine.action` 采用，直接文件写回测试在 `workspace.test.js`；同一 workspace 模块仍由 inventory/snapshot 导入，无注册或副作用丢失。 | 只删除无运行作用的绑定。 |
| UI 缺少 settings 时的“3 次 / 20 分钟”回退，以及重复的 24 步 / 5 分钟默认值 | Host 的 get/action 等待初始化与 recover；持久 schema 要求 id，recover 和新建路径都调用 `initializeResearch` 补齐设置。旧记录和格式 3 记录经真实恢复读回验证，配置值保留；23 个组件场景修改前后可见树一致。 | 删除客户端第二套默认值及中英 allowance 字典，保留 Host 的旧格式迁移；重建 client.js。 |
| Git 忽略文件冲突测试旁的两条历史注释 | 旧用例在封存后添加文件，先被封存守卫拒绝。隔离突变移除目标碰撞保护后，旧用例仍通过；它没有覆盖标题所说的边界。 | 删除误导注释；候选改为由 Worker 正常产生，真正测试忽略文件冲突；另保留独立封存篡改回归。 |
| `code-runtime.js` 将关闭 Node 测试隔离称为“原样执行” | 该文字进入性能/缺陷修复/审查的模型提示。两个依赖进程隔离的测试在原命令下 2/2 通过，关闭隔离后 1/2 失败。 | 要求先跑原检查；EPERM 诊断绑定实际错误；关闭隔离只能帮助定位，不能代替必需检查。 |
| workspace 的“首版”错误文案，design 的未标版本限制 | 当前代码仍执行普通文件、100 MiB / 15000 文件限制；DSH Schema 的 maxLength 限制来自固定 0.2.1-rc.2。 | 去掉早期时态，并为外部限制标明版本；不改变限制本身。 |

详细证据：`core/decision.md`、`tests/decision.md`、`comments/review.md`、`comments/comment-inventory-baseline.json`、`ui-decision.md`。调用搜索只用于补充入口和契约证据，不单独作为删除理由。

### 修复与验证

原生工作流交付失败后只在内存保存错误，先等待恢复回调，再写持久存储。恢复挂起或进程中断会丢失原始失败原因，与核心契约冲突。现在先保存失败原因，再核对副作用。新增回归在恢复等待期间读取 store 和 `report.json`，重开引擎后仍保留失败原因，未知副作用继续阻止采用。原实现失败输出见 `core/delivery-regression-red.txt`。

忽略文件冲突测试修正后能拒绝同一个隔离突变，失败为 `Missing expected rejection`；生产实现的冲突与封存两项均通过。突变只存在于证据目录，没有替换生产文件，也没有降低断言。

最终检查结果见本页对应的[验收记录](validation.md)。本次不删除任何整项测试、示例或 Host 验证脚本：两个 duplicates 示例可独立复制运行；跨示例迭代、文件/JSON 工作流、可选 review、纯内核身份拒绝、真实 Host 装配均有各自边界。保留 0.1 身份映射、格式 3 独立重测、旧 pendingReview 历史测量、registerTask 与 parseResult 契约，以及解释作用域、计数时序、冻结评价、采用回滚和未知状态的注释。

没有重跑付费长程模型实验或浏览器布局验收；组件等价检查不证明布局或模型搜索效果。临时 Host 已停止，3091 端口不监听，本次链接已通过 DSH CLI 卸载；正式 sla-dev profile 未修改。当前未遗留本次已确认的待修缺陷。

---

## 2026-10-24 维护审计（历史记录）

审计起点：`d86919b`（0.3.3），Windows / Node.js 24.19.0。范围包括全部受版本控制的源码、类型、测试、示例、开发脚本和代码注释，以及 README、当前契约与历史调研的引用关系。历史验收记录保留其当时语境；当前规则以 README、`docs/core.md`、`docs/extensions.md` 和实现为准。

### 删除前的证据与决定

以下决定先于实现修改记录；原始基线输出、反例与执行日志在隔离 worktree 的 `artifacts/audit/`，交付时逐字节核对复制到主仓库 `artifacts/maintenance-audit-20261024/`。

| 内容 | 可核查依据 | 决定 |
| --- | --- | --- |
| `src/prompts.js` 的 `workerSchema` 及专用 `strings`，engine 的对应参数 | 生产 `SlaService.invoke` 对 Worker 明确不传 `outputSchema`，读取普通文本；`workerPrompt`、`docs/extensions.md` 都规定 Markdown。engine 只读取 `report.summary`，文件变化由 `inventory/changedFiles` 实测。这套 schema 既不约束真实模型输出，也不参与持久化恢复。 | 删除 schema、导入与传参，保留其它角色的结构化结果契约。 |
| Host Worker 返回的 `changes: []` 和测试 fake 的 `changes` | Host 总返回空数组；engine 完全不消费该字段，真实变化保存到 `trial.changes`，来自实际文件摘要比较。生命周期测试保留，fake 改成生产的文本报告形状。 | 删除虚构字段，保留实测变化。 |
| engine 构造器保存的 `this.maxTrials/this.maxMinutes` | 构造参数仍通过 `settings` 校验并写入 `this.defaults`；新运行和续轮读取 `run.settings/limit/timeLimitMs`。字段没有运行读取方；package exports 的服务入口也不公开此构造器属性。 | 只删除多余实例属性，保留参数与额度行为。 |
| `src/remote.js` 的泛泛开场注释 | 同文件的 `package/descriptors` 已给出实际 Typert 契约；“small explicit contribution”没有设计原因或外部约束。 | 删除，保留 wire codec 与描述符。 |
| `verify-presentation.mjs` 的“Temporary / new”时态 | 脚本仍是独立的真实 spawn/structured-output 回归探针，曾发现 DSH schema 不支持 `maxLength`；它不是已失效的一次性实现。 | 保留脚本，将注释写成可复跑的开发入口。 |
| 客户端 `.sla-scores/.sla-value/.sla-adopted` 样式，以及中英文 `best/recheck/original/purpose` 标签 | `git show 1bd56dd -- src/client-factory.js` 明确记录分数卡、采用卡及旧检查说明被 Decision/CheckOrigin 替换，遗留规则没有对应 DOM；动态 class 只组合检查状态。`best/recheck/purpose` 的旧调用随迁移移除；`original` 从引入起未进入有效 label 域，`Original` 现默认用 `raw`。完整动态翻译域不含这四个键。 | 删除已失效或未进入渲染路径的残片，重建浏览器产物；保留动态状态标签。 |
| README 和 design 的本机状态、构建来源和长程脚本注释 | “本机已完成”“本开发环境没有工具”是历史机器状态；生成注释漏列实际嵌入的 remote；长程检查点的目录只按约定保留，真实性靠哈希校验。 | 文档改为首次设置与 CLI 操作；注释列全来源，并删除“所有目录不可变”的绝对断言。 |

### 实现问题与修复

1. `verifyEvaluation` 只校验 manifest 中已有文件，允许评价运行时向冻结的 `.sla/` 新增代码。现有缓存测试还将 `.sla/__pycache__` 的新增当作成功，与当前“缓存写 `.dsh/cache/`、评价目录冻结”的契约冲突。保留缓存测试并迁移路径，新增真实评价执行反例，修复完整目录校验。
2. `adopt` 在核对源清单和备份后等待授权，授权期间的用户编辑会被覆盖。回滚又遍历所有备份，会覆盖尚未由本次写入的用户文件。需要在授权后复核当前预期文件状态，只回滚本次写入且仍匹配本次内容的文件；歧义保留原内容并阻止自动恢复完成。

冻结目录现在核对完整文件集合和内容，拒绝新增、缺失、篡改与链接。采用在授权前后比较同一阶段的项目清单，逐文件核对目标内容和根/父目录链接；回滚只处理本次实际尝试写入、且仍能确认归属的文件。用户再次修改的内容保留，持久日志记录冲突，恢复时进入 `adoptionPending/blocked`。

旧运行仍可读取，身份和精确扩展版本绑定保留；若旧冻结评价运行时向 `.sla/` 写缓存，继续或采用现在会拒绝该评价。应通过补充要求重建评价依据，将缓存移到 `.dsh/cache/`；不能直接改写已有冻结文件或绕过检查。

独立复核额外发现逐文件授权中新加源文件漏验，以及根目录被替换成 junction 后新文件可能写入外部目录，均已补回归并修复。为支持候选合法修改 `.gitignore`，授权前后在同一写入阶段比较清单，最终按既有源文件与候选路径直接核对；没有加入忽略文件例外分支。

### 保留依据

- 0.1 任务身份迁移、旧运行缺失 settings/方向/评价字段的初始化和展示回退，对应真实持久化格式；默认任务已升为 `1.1.0`，旧 `1.0.0` 绑定仍须保留，不能静默改绑。
- `examples/duplicates` 与 `duplicates-baseline` 的相似测试分别随可独立复制运行的示例交付；跨示例迭代协议检查有额外行为覆盖。没有充分删除证据，全部保留。
- 无 review 的生命周期测试和带 review 的 Epoch 测试覆盖不同扩展契约；真实 Host 探针覆盖 mock 无法证明的工具装配、权限和 DSH schema，均保留。
- 解释步数计数时序、fresh spawn 工作目录边界、采用路径链接检查、评价版本事务和历史证据投影的注释有真实约束，保留。Windows 运行时指引需绑定实际错误，不能作为跳过必需检查的授权。

### 验证

| 检查 | 本次结果 | 本机证据 |
| --- | --- | --- |
| 原实现反例 | 用 `d86919b:src/workspace.js` 和当前回归夹具执行，7 项全部失败；生产工作目录未被替换 | `red-regressions-final.txt`、`red-baseline/` |
| 完整回归 | 从 80 项增至 **88 通过、0 失败、0 跳过**；没有删除整项测试 | `baseline-test.txt`、`final-test.txt` |
| 语法与客户端 | 26 个 JavaScript 文件通过；客户端重建成功；diff 空白检查通过 | `final-check.txt`、`final-build.txt` |
| 真实 DSH Host | 独立临时 profile，展示契约 2 个固定响应请求；工具/步骤/取消/权限与作用域探针 219 个固定响应请求、17 个子会话，全部通过；未调用外部模型 | `host-presentation.json`、`host-researcher.json` |
| UI 等价 | Git 基线、当前源码、生成客户端的 23 个组件场景可见树摘要逐项一致；状态翻译动态域逐项核对 | `ui-before.json`、`ui-after.json`、`ui-client.json`、`ui-translation-audit.md` |
| 独立文件系统复核 | 新增/删除、忽略规则、授权期间修改、回滚恢复、忽略文件冲突、根/父 junction 共 7 场景通过 | `independent-workspace-final.json`、`independent-workspace-probes.mjs` |

注释审计覆盖 `src/`、`extensions/`、`scripts/`、`test/`、`examples/`、类型声明和生成客户端；保留项见上文。历史调研和旧验收没有被改写成当前结论。审计遵循“迁移调用方再删除旧接口”和“验证行为”：生产入口证明旧 Worker 协议失效，反例证明实现缺陷后修复，没有通过删测试或放宽断言取得通过。

当前未遗留已确认的待修缺陷。没有重跑付费长程模型实验或浏览器布局验收；组件探针不证明浏览器布局。文件清单和授权边界检查不提供跨进程文件系统事务：最终核对后的外部同时写入仍需操作系统层面的隔离。时间/步骤、读隔离及旧扩展版本边界沿用现有契约。

临时 Host 已停止，3086 端口已不监听；已通过 DSH CLI 从 `sla-audit-20261024` profile 卸载本次链接。自动审批拒绝删除该临时 profile 目录，返回 `blocked by policy`，未提供更具体原因，因此保留该目录，不再尝试递归删除。

从主仓库复核：

```powershell
npm test
npm run check
npm run build:client
node artifacts/maintenance-audit-20261024/independent-workspace-probes.mjs
node artifacts/maintenance-audit-20261024/ui-probe.mjs --source client.js --compare artifacts/maintenance-audit-20261024/ui-before.json --output artifacts/maintenance-audit-20261024/ui-recheck.json
```
