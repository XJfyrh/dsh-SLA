# 验收记录

## 0.2 可扩展任务

2026-10-23，在同一 Windows / Node.js 24.19.0 / DeepSeek Harness 0.2.1-rc.2 Web profile 验证。代码性能和缺陷修复均通过普通 Cordis 插件注册；核心不导入具体任务，也不要求数值分数。

`npm test`：43 项通过，0 失败、0 跳过；`npm run check` 检查 18 个 JavaScript 文件；客户端构建通过。测试覆盖无分数评价、失败缺陷基线、原生评价器、空评价目录、运行缓存、固定文件防篡改、扩展卸载取消、版本不匹配、结果与核心元数据隔离、只读权限和采用回滚。

实际 Host 中，`scripts/verify-researcher.mjs` 使用固定模型适配器完成 35 次请求、6 个独立子会话，不调用外部模型。其中 24 次专门验证剩余步数提醒、到达上限后的停止与清理。已验证真实文件写入与 PowerShell 读回、运行时与项目目录两种 Skill 加载、首个请求的工具和阶段提示、结构化输出、主会话工具不变、私有工具释放、普通插件注册/卸载/升级，以及原生评价器无法绕过只读采用限制。项目 Skill 起初返回 unknown：修复为与官方 standard preset 一样，同时装配 `dsh-skill-filesystem` 和 `dsh-tool-skill`，随后项目目录加载通过。证据在 `artifacts/extensibility/researcher/verification.json`，复跑仍使用本文末尾的临时 patch；正常 Web 不加载该验证插件。

真实缺陷流程先暴露了阶段职责问题：Scout 完成缺陷复现后继续修改了 `clamp.js`，核心拒绝这套评价依据，原项目未写回。现按每次调用的角色装配 DSH persona 系统提示，明确调查完成即提交、修复由 Worker 执行；文件内容校验继续承担实际阻断。失败记录保留在 `artifacts/extensibility/live/bugfix-discovery-rejected.json`。

缺陷修复真实探索 `0310992e-7306-4d36-aa79-796ced02aafe`：Web 一句话自动选择 `code-bugfix@1.0.0`，实际完成暂停、重启、继续、无分数结果展示与采用。第一候选通过原评价，但独立反例发现它把非目标边界的 `-0` 改成 `+0`；通过主对话补充两个反例后，旧结果不再可采用，判断依据升至版本 2。第二候选只删除 `value || min` 的错误兜底，目标零值修复、原有 4 项测试和 2 项有符号零回归均通过，采用前再次复验并仅写回 `clamp.js`，源项目字节与候选一致。

使用同一版冻结检查脱离模型重放：初始项目为 `reproduced:true / regressionPassed:true / valid:false`；旧候选为 `reproduced:false / regressionPassed:false / valid:false`；最终候选为 `reproduced:false / regressionPassed:true / valid:true`。完整输出在 `artifacts/extensibility/live/bugfix-replay/`；运行 `node .sla/evaluate.mjs` 可分别重放其中 `initial`、`rejected-v1`、`best` 三个目录。最终界面截图为 `live/bugfix-adopted.png`。

性能真实探索 `764d9e18-e26b-4d35-ad40-12ffb11b2365`：自动选择 `code-performance@1.0.0`。第一版检查未覆盖数组自定义迭代器，索引快路径因此被误保留；独立反例在采用前发现，主对话补充后重建依据。重建曾两次达到 24 步而未提交结果：补充已实测的 Node 主进程测试入口，并通过 DSH 原生动态上下文提示剩余步数，保留原上限，随后完成调查与实验。

第二版固定工作负载为两个 50,000 元素数组：一组每个值出现两次，一组几乎无重复；预热后重复 3 次，取两组合计耗时的中位数。基线 **1214.226 ms**，最终候选 **6.162 ms**，采用前复验 **6.161 ms**；17/17 项检查通过，含原有 3 项测试、迭代协议反例与 300 组确定性随机对照。最终只写回 `index.js`，保留 `for...of` 并改用 Set 查找，源项目字节与候选一致。第一版的 583.66 / 4.39 ms 使用另一套负载，不能与第二版比较。

性能离线重放在 `artifacts/extensibility/live/performance-replay/`：初始项目 17/17、1213.575 ms；旧候选仅 12/17，通过更快也判无效；最终候选 17/17、6.655 ms。每个目录的 `node .sla/evaluate.mjs` 可独立复跑，原始输出与 SHA-256 清单保留。两个例子均有人工反例纠偏，不代表模型自动生成的检查已覆盖所有行为；反例方法已加入随包示例 Skill。

扩展接口与示例见[扩展说明](extensions.md)。本版本仍以文件项目为候选，没有远程系统快照适配器、多方向并行 Epoch 或独立 Token 计费账本。

## 0.1 首版验收

2026-10-23，Windows / Node.js 24.19.0 / DeepSeek Harness 0.2.1-rc.2，Web profile `sla-dev`，模型 DeepSeek-V4.1-Flash（High）。本机 Web 从 0.1.5-rc.3 升级；桌面版未修改。插件按[官方契约](design.md#官方依据)链接安装，旧第三方插件不纳入兼容范围。

## 真实模型与 Web 操作

在 `examples/duplicates` 工作区选择“持续探索 · SLA”，发送：

> 让这个项目在大数组上运行得更快，保持现有行为，不增加依赖。

插件自行调查项目、生成评价脚本、测量基线、规划并修改候选。人工没有提供初始评价入口。Web 的暂停、继续、补充要求、采用和重启恢复均实际操作过。

真实探索 ID：`19bd3cd2-ffa1-40a9-9bfa-ea2915d4d873`。原始证据目录：`C:\Users\12898\.dsh\sla-artifacts\19bd3cd2-ffa1-40a9-9bfa-ea2915d4d873`。

| 阶段 | 实际结果 |
| --- | --- |
| 第一版评价 | 12 项检查；三类数组工作负载各测 3 次，三个中位数之和作为分数；基线 919.16 ms |
| 暂停与恢复 | 第 1 次尝试被手动暂停，记录为 inconclusive；重启后保留基线，继续才再次调度 |
| Worker 协议失败 | 第 2 次尝试没有返回 DSH 要求的结构化结果，记录为 inconclusive；将 Worker 改为普通完成输出，以文件和 Host 评估为准 |
| 第一版候选 | 第 3 次尝试通过 12/12，7.22 ms；采用前确认原项目文件未变 |
| 评价遗漏 | 独立反例发现数组索引快路径忽略自定义 Symbol.iterator：原实现返回 `[2]`，候选返回 `[1]` |
| 自然语言纠偏 | 补充“按传入对象的迭代协议遍历，不能直接使用数组索引快路径，把这个行为加入正确性检查”；旧结果立即禁止采用，点击继续后重建评价 |
| 第二版评价 | 15 项检查；80,000 元素、40,000 个值各两次，确定性打乱，测 3 次取中位数。用此检查重放旧候选，2/15 失败 |
| 第二版候选 | 基线 **1333.28 ms**；第 4 次尝试 **4.33 ms**，15/15 通过。保留 for...of，使用 Map 查找 |
| 反馈与时间上限 | 后续 Advisor 已收到有效实验反馈；累计 20 分钟额度耗尽后暂停，保留最佳候选 |
| 采用与重启 | 点击采用，独立复验 **4.92 ms**，15/15 通过；仅写回 index.js，核对项目文件与候选字节一致。重启 Web 后仍显示“已采用”和复验结果 |

两版评价的工作负载不同，分数不能跨版本比较。上表的性能是此示例与此机器的实际测量，不代表一般项目或 SLA 架构的普遍收益。第一版遗漏也说明自动生成的检查需要结合任务审阅；补充要求可以修订依据。

## 本地回归与独立审查

`npm test`：**22 通过，0 失败，0 跳过**；`npm run check` 通过。协议回归使用模拟模型适配器和真实 Node 评价进程，不能替代上述真实模型验收。

覆盖最佳候选保留、错误与未完成评估、暂停/继续、修订隔离、评价目录篡改、源文件变化、忽略文件冲突、采用日志恢复、损坏日志、用时恢复和关闭期间采用操作的取消与结算。示例检查包含自定义迭代器反例。

独立审查发现并修复了旧依据采用、忽略文件覆盖、评价辅助文件残留、中断采用恢复、用时丢失及关闭未等待采用等边界问题。真实集成另外修复了 Typert 描述符与响应封装、storage domain 命名、spawn 工作目录与权限根分离、Worker 输出契约问题。失败尝试保留在历史中。

## 本机证据与复跑

`artifacts/acceptance/` 是忽略的本机验收产物：

- `web-result.png` / `reopened-ui.txt`：服务重启后的实际界面。
- `paused.json`：暂停检查点；`before-adopt.json`：第一版候选产生后、采用前的源文件未变证明。
- `revision1-counterexample.json` / `revision2-rejects-old.txt`：语义反例和新版检查拒绝旧候选。
- `adopted.json`：最终运行报告；`export/`：选定证据的副本，包含初始项目、最终候选、冻结评价、原始基线/最佳/采用输出、写回日志与 patch。`manifest.json` 记录 15 个导出文件的 SHA-256，导出时逐字节核对来源。
- `../tests.txt`：本地回归输出；`../work-log.tsv`：实施决策、失败和证据记录。

导出的候选与评价可脱离模型复跑：

```powershell
Set-Location E:\dev\dsh-plugins\dsh-SLA\artifacts\acceptance\export\best
node ../criteria/.sla/evaluate.mjs
```

该命令已实际执行，15/15 通过；输出保存在 `export/replay-output.txt`。计时会随机器负载改变。重新体验完整探索请复制 `examples/duplicates-baseline`，按 [README](../README.md) 新建会话。`examples/duplicates` 保留本次已采用的结果。

## 交付边界

已验证这个无依赖代码项目的完整闭环，以及列明的协议故障路径。首版是串行探索，没有论文完整多方向 Epoch；未验证桌面版、其他 Harness 版本或大型依赖项目。评价由模型生成，Windows 文件策略不提供读隔离或网络隔离，时间和步骤限制不等于费用硬限。

## 0.1.1 界面调整

把输入区大卡片迁移为顶部状态入口与原生右侧探索页签；停止后的摘要位于启动探索的对话轮次中。补充要求统一走主对话。

使用已有真实运行验证顶部打开、原生收起、摘要重新打开、实验与依据展开、切换到无探索会话、切回后恢复以及刷新。此次没有重新调用模型或再次写回示例项目。采用后自动收起的成功路径，以及期间切换会话/页签时保持当前视图，通过本地行为测试覆盖。

新增客户端测试还覆盖多组件共享轮询、迟到响应、重复操作、失败信息和卸载后停止更新；本地测试合计 29 项。当前截图与输出保存在 `artifacts/ui-layout/`，原始 0.1.0 验收证据仍保留。

## 0.1.2 内部执行入口调整

移除公开的“SLA 实验执行”模式，内部工具按子会话作用域装配。实际 Web 菜单只显示一个“持续探索 · SLA”，仍可正常选择；截图和可访问性树位于 `artifacts/private-researcher/menu.png`、`menu-state.txt`。

`npm test` 29 项通过；语法检查通过。另用 `scripts/verify-researcher.mjs` 在实际 `sla-dev` Host 中调用生产的 `sla.invoke`：两个 Worker 各自写入文件并通过真实 PowerShell 读回，一个 Scout 通过真实 structured_output 工具提交结果。7 次模型请求全部由固定脚本适配器响应，没有调用外部模型。验证了首个请求已有实验工具、主会话工具不变、子会话没有 sla_control、运行中菜单不出现内部模式，以及子会话结束后工具与调用记录释放。

第一次检查的 shell 参数缺少 description；补齐后，仓库 artifacts 下的实验目录遇到 Windows grantWrite / Win32 5。改为使用生产探索相同的 `~/.dsh/sla-artifacts/` 目录后通过，没有修改原目录的 ACL。失败证据和最终 `verification.json` 保存在 `artifacts/private-researcher/`。这次验证针对工具装配和隔离，不重复首版的真实模型性能实验。

复跑时暂停同 profile 的 Web 进程，临时 patch 插入验证插件，然后启动一次：

```yaml
- insert:
    - id: sla-private-researcher-verification
      name: file:///E:/dev/dsh-plugins/dsh-SLA/scripts/verify-researcher.mjs
```

```powershell
dsh --profile sla-dev --patch ./artifacts/private-researcher/verify.patch.yml --no-open --port 3080
```

验证结果写入 `artifacts/private-researcher/verification.json`；检查 passed 为 true。结束后退出，再用 README 中不带 --patch 的命令恢复正常 Web 服务。临时验证插件不写入 profile 配置。
