# 2026-10-24 维护审计

审计起点：`d86919b`（0.3.3），Windows / Node.js 24.19.0。范围包括全部受版本控制的源码、类型、测试、示例、开发脚本和代码注释，以及 README、当前契约与历史调研的引用关系。历史验收记录保留其当时语境；当前规则以 README、`docs/core.md`、`docs/extensions.md` 和实现为准。

## 删除前的证据与决定

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

## 实现问题与修复

1. `verifyEvaluation` 只校验 manifest 中已有文件，允许评价运行时向冻结的 `.sla/` 新增代码。现有缓存测试还将 `.sla/__pycache__` 的新增当作成功，与当前“缓存写 `.dsh/cache/`、评价目录冻结”的契约冲突。保留缓存测试并迁移路径，新增真实评价执行反例，修复完整目录校验。
2. `adopt` 在核对源清单和备份后等待授权，授权期间的用户编辑会被覆盖。回滚又遍历所有备份，会覆盖尚未由本次写入的用户文件。需要在授权后复核当前预期文件状态，只回滚本次写入且仍匹配本次内容的文件；歧义保留原内容并阻止自动恢复完成。

冻结目录现在核对完整文件集合和内容，拒绝新增、缺失、篡改与链接。采用在授权前后比较同一阶段的项目清单，逐文件核对目标内容和根/父目录链接；回滚只处理本次实际尝试写入、且仍能确认归属的文件。用户再次修改的内容保留，持久日志记录冲突，恢复时进入 `adoptionPending/blocked`。

旧运行仍可读取，身份和精确扩展版本绑定保留；若旧冻结评价运行时向 `.sla/` 写缓存，继续或采用现在会拒绝该评价。应通过补充要求重建评价依据，将缓存移到 `.dsh/cache/`；不能直接改写已有冻结文件或绕过检查。

独立复核额外发现逐文件授权中新加源文件漏验，以及根目录被替换成 junction 后新文件可能写入外部目录，均已补回归并修复。为支持候选合法修改 `.gitignore`，授权前后在同一写入阶段比较清单，最终按既有源文件与候选路径直接核对；没有加入忽略文件例外分支。

## 保留依据

- 0.1 任务身份迁移、旧运行缺失 settings/方向/评价字段的初始化和展示回退，对应真实持久化格式；默认任务已升为 `1.1.0`，旧 `1.0.0` 绑定仍须保留，不能静默改绑。
- `examples/duplicates` 与 `duplicates-baseline` 的相似测试分别随可独立复制运行的示例交付；跨示例迭代协议检查有额外行为覆盖。没有充分删除证据，全部保留。
- 无 review 的生命周期测试和带 review 的 Epoch 测试覆盖不同扩展契约；真实 Host 探针覆盖 mock 无法证明的工具装配、权限和 DSH schema，均保留。
- 解释步数计数时序、fresh spawn 工作目录边界、采用路径链接检查、评价版本事务和历史证据投影的注释有真实约束，保留。Windows 运行时指引需绑定实际错误，不能作为跳过必需检查的授权。

## 验证

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
