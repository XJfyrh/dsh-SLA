# SLA 最小版本

一句目标启动；系统发现项目、建立评价依据、提出方向、修改候选并运行检查。用户只通过对话表达约束，界面展示当前依据、实验结果、暂停/继续和采用。

0.3 采用串行多方向 Epoch，状态与恢复契约见[核心规则](core.md)。Host 拥有持久状态；选择任务、调查、规划、执行分别调用全新 spawn 子会话，不继承主对话。项目快照承接候选；评价文件在调查后固定，插件独立执行。未满足任务检查或未完成评估的候选不能成为最佳改进。缺陷任务允许初始基线复现失败，通过修复与回归检查后才能采用。主项目只在用户采用且源文件未变时写入。

## 0.2 扩展边界

任务扩展是普通 DSH 插件，通过 `sla` 服务注册；默认的性能和缺陷修复也走同一接口。核心负责状态、候选和证据，扩展负责调查与比较。[扩展契约](extensions.md)是该接口与生命周期的正文。子会话通过官方 Skill 工具加载任务方法，宿主继续提供用量、存储、权限和界面。

0.1 中的 Node 评价命令、输出格式、分数方向和基线通过要求已移到性能扩展。核心接受非数值结果，保留任意 JSON 评价载荷，且不允许载荷覆盖实验编号等核心身份。运行保存扩展版本；缺失、升级或卸载不会自动替换既有规则。采用权限在核心写回路径再次检查，不依赖扩展是否调用 shell。

## 实施顺序与验收

1. 新版 Web 中安装 bundle，验证原生 slot、Host/Client 调用和模式注册。
2. 从自然语言建立项目快照与可执行检查；真实子会话完成多轮尝试并由实际检查选择结果。
3. 验证补充约束、暂停/继续、重启恢复和采用冲突；通过 Web 完整操作并保存证据。

默认每轮最多 8 次尝试、20 分钟；每次子会话另设步骤上限。时间和轮次是运行上限，不宣称为费用硬限。进程重启后保留证据并暂停，用户继续才调度。Windows 的文件策略不构成读隔离或网络隔离。

## 实现中确认的边界

- 新版 `spawn` 的 `cwd` 改变工作目录，权限根仍来自父会话不可变的 `header.cwd`。因此每次调用先创建一个不执行模型的临时 owner，将其 `cwd` 设为当前快照，再从这个 owner 创建 fresh spawn。调用结束或取消后，按 child、owner 的顺序释放。
- 模式菜单只注册“持续探索 · SLA”。内部实验在串行、可等待的 `agent/created` 事件中，通过子会话的 scoped Context 装配 persona、文件、搜索、Skill 和平台 shell 插件；工具就绪后才开始模型请求，随子会话释放。临时 owner 按调用绑定阶段职责，persona 明确当前阶段的读写与完成边界；只匹配该 owner 的直接子会话，不继承主会话的控制工具。DSH 0.2.1-rc.2 的 preset 没有隐藏字段，因此内部角色不注册为 preset。
- 每次调查将评价目录冻结到唯一目录，保存所有辅助文件的 SHA-256。Worker 无评价文件；Host 在另一个副本中重放评价。固定文件在执行前后核对；新缓存留在一次性检查目录，不进入下一次评价。扩展可只复用现有检查，使用空的评价目录。结果解析失败、超时、截断、错误退出及正确性失败分别留下证据，不获得有效最佳结果。
- 新约束使旧依据失效，旧候选不能直接采用。补充要求不会偷偷增加已用完的轮次；需要点击继续才领取新额度。中断中的用时在恢复时计入，最多计到已有额度。
- 采用先复验，再核对源项目全部已纳入快照的文件。快照之外已存在的同名文件也拒绝覆盖。写入和字节复验失败时回滚；进程中断由 adoption journal 与实际文件共同判定完整采用、未采用或需要人工处理，绝不自动覆盖冲突。
- UI 使用 Host 提供的真实状态；模式菜单启动、自然语言控制、顶部入口和原生右侧面板共用一个服务。`client.js` 通过官方 ModuleLoader 与 slot 机制加载。字符串 RPC 使用显式 Typert 严格描述符，绑定当前固定版本；升级 Harness 要重跑接口与运行验收。

## 界面布局

顶部 `conversation.session.header.actions` 提供状态入口，点击通过 `sidebarRight` 打开 `dsh-sla` 页签；详细内容注册到 `sidebar.right.pane.tab`。输入区不再注册 SLA 卡片或第二个输入框，约束通过主对话提交。

0.3.2 的紧凑状态摘要通过 `conversation.chat.turnTail` 与原生 `useChat` 绑定到探索启动之后最近一轮已完成的对话。新一轮关闭后摘要移动过去，运行、暂停、审查与采用状态均持续更新；原消息保持原样，摘要明确标为“探索最新状态”并附更新时间。摘要属于可滚动的对话内容。顶部、摘要和面板共用按会话订阅的状态源，避免重复轮询和迟到响应覆盖采用结果；同步失败时保留上次状态并标出失败。

采用成功仅在原会话、原探索页签仍处于前台且面板展开时收起；期间切到其他会话或文件页签时保留用户当前视图。页签的关闭、全屏和会话间布局恢复使用宿主原生行为。

0.3.1 的正文与改动分别复用 `@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText` 和 `DiffBlock`。调查与审查 Agent 编写简短中文说明和 Markdown；界面根据实际评价字段生成检查结论与数量，不额外调用模型整理旧证据。旧版单段依据只补段落和列表，原始记录保持不变。

改动预览按需读取运行保存的初始与最佳快照，核对文件哈希，返回相对文件名及文本。单文件超过 128 KiB、总预览超过 512 KiB 或文件不是 UTF-8 文本时保留文件条目并说明去证据目录查看；快照变化时拒绝预览，原补丁仍可展开。当前依据的复验结果优先于历史评价，未完成、失败与未复验分别显示。

0.3.2 将侧栏首屏按采用决策组织：当前候选及评价版本、实测变化、实际改动说明、保留理由和未验证范围。主对话与侧栏使用同一个结果投影；采用后展示采用时的复验值，并注明与实验测量的区别。新目标尚在重建时隐藏旧比较；失败、未完成或未完成审查的结果不展示可采用入口。

检查名称与保护行为由审查者提供，当前检查状态来自实际执行；历史发现放在独立的来源折叠项，注明提出时的候选、评价版本及纳入版本。旧记录缺少结构化说明时不推断、不改写。说明输出约定见[扩展接口](extensions.md)。DSH 当前结构化输出只接受其 Schema 子集，长度要求使用 description，Host 保存元数据时独立限长，不能使用 maxLength。

## 与原论文的对应

[SLA 原论文 v1](https://arxiv.org/html/2610.07625v1) 的关键思想在此体现为：长程状态归 Host 所有，每次 Advisor/Worker 使用新上下文，已完成实验的可执行反馈进入下一次规划。调查评价入口由插件补齐，用户只给目标与约束。

0.3 增加方向局部候选、分角色证据重建与串行 Epoch；尚未并行调度，不以示例项目的收益证明 SLA 的普遍效果。独立反例审查是针对自动生成评价的产品补充，不属于论文原有机制。

## 官方依据

研究日期 2026-10-23，npm DSH 0.2.1-rc.2；官方源码快照 687f282e8625c6b8d11ff58211a90524be2e4317。

- [插件入门](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/user/develop/basic/index.md)：effect 生命周期、inject 和 patch。
- [打包安装](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/user/develop/basic/publish.md)：bundle、版本声明、官方 CLI 链接安装。
- [官方开发技能](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/preset/agent-preset/skills/cordis-plugin-development)：Host/Client、原生 slot、用户动作与工具共用服务、验证。
- [子会话](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subagent)：spawn 不继承父上下文，structured output、caller delivery、明确 disposal。
- [持久域](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/storage/storage-domain)：读回与持久写入，不自创 session event。
- [API Gateway](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/api-gateway.md)：严格描述符、Agent lookup、同源 RPC。

官方开发技能面向 Harness 内运行的 Agent，要求使用其 plugin_manager 工具；本开发环境没有该工具，安装改用同一官方教程公开的 dsh plugin add，避免手写 profile。
