# DSH SLA · 持续探索

**告诉它你希望什么变好，让它调查项目、建立判断依据、尝试不同办法，交出可检查、可采用的结果。**

DSH SLA 是 DeepSeek Harness 的社区插件，受 Stateless Language Agents 论文启发。你从一句目标开始，插件组织独立的调查、规划、执行和复验；候选、失败与改进方向保存在会话之外，供下一轮接续。

> 让这个项目在大数组上运行得更快，保持现有行为，不增加依赖。

![持续探索的结果面板](https://unpkg.com/dsh-sla@0.4.0/docs/images/exploration.png)

参数工作流验收界面：查看结果、检查与候选内容。

## 安装

需要 **DeepSeek Harness 0.2.1-rc.2、Node.js 24 和 Git**。先在 Harness 配置可用模型，再把插件安装到你使用的 profile：

```sh
dsh plugin --profile web add dsh-sla@0.4.0
dsh web
```

已有 Web 服务请重启，然后刷新页面。在项目中新建会话，选择 **持续探索 · SLA**，发送目标即可。调查和实验会话由插件创建，模式菜单只有一个 SLA 入口。

使用自定义 profile、卸载或从源码开发，见[安装说明](https://unpkg.com/dsh-sla@0.4.0/docs/install.md)。本次发布的 Host 集成在 Windows + Web 验证；其他系统与桌面分发见[验证范围](https://unpkg.com/dsh-sla@0.4.0/docs/validation.md)。

## 可以做什么

| 工作流 | 可以直接发送的目标 | 交付内容 |
| --- | --- | --- |
| 代码性能 | 让大数组去重更快，保持输入顺序与已有行为 | 通过正确性检查和性能复验的代码候选 |
| 缺陷修复 | 修复 `clamp(0, -5, 5)` 错误返回 `-5`，保持其他行为 | 复现缺陷后得到的修复与回归检查 |
| 检索参数 | 利用已有评测集改善检索效果 | 经固定评测器测量的 JSON 参数包 |

从 [duplicates-baseline](https://unpkg.com/dsh-sla@0.4.0/examples/duplicates-baseline/README.md)、[clamp-bug](https://unpkg.com/dsh-sla@0.4.0/examples/clamp-bug/README.md) 或 [retrieval-parameters](https://unpkg.com/dsh-sla@0.4.0/examples/retrieval-parameters/README.md) 复制一个练习项目开始。检索示例使用小型英文词项评测集，展示参数工作流接入方式。

顶部 **持续探索** 入口打开右侧面板：先看当前结果、改动理由和检查，再展开实验与文件差异。可以在主对话补充要求、暂停、继续，也可以在面板调整探索设置。

**采用由你决定。** 采用代码前会复验候选，并核对原项目；原项目已有新改动时停止覆盖。参数工作流生成独立交付包。模型用量、完整会话日志与导出使用 DSH 原有入口。

## 怎样持续探索

插件保留各方向的局部候选，让暂时落后全局最佳的方法继续发展。下一轮规划会看到成功、失败与未完成的依据。补充要求或发现遗漏检查时，先按新依据重测候选，再更新排序。

默认每轮 **8 次尝试、20 分钟**；每次模型调用 **24 个工作步 + 1 个结果提交步、5 分钟**。额度可在面板修改，继续会增加一轮有限额度。模型调用会消耗你在 DSH 配置的 API 用量，时间与步数不是费用硬上限。

当前为串行多方向探索。代码工作流使用文件副本，跳过依赖目录、构建目录和 `.env`，遇到链接停止；优先用于无依赖或依赖由系统提供的子项目。文件副本不提供进程或网络隔离。评价结论覆盖实际执行的检查，完整边界见[核心规则](https://unpkg.com/dsh-sla@0.4.0/docs/core.md)。

## 扩展

方法指引使用 DSH Skill，程序能力使用普通 DSH 插件。扩展统一调用 `ctx.sla.registerWorkflow()`：

- `defineCodeWorkflow()`：复用调查、代码候选、独立审查和文件交付，定义领域评价。
- `defineWorkflow()`：定义 JSON 等制品，自行组合准备、探索、评价升级与交付。

两者共用尝试、制品、观测与决定的内核。见[扩展开发](https://unpkg.com/dsh-sla@0.4.0/docs/extensions.md)。

## 项目资料

- [开发与验证](https://unpkg.com/dsh-sla@0.4.0/docs/development.md) · [当前验证结果](https://unpkg.com/dsh-sla@0.4.0/docs/validation.md)
- [论文与实现范围](https://unpkg.com/dsh-sla@0.4.0/docs/research.md)
- [MIT License](https://unpkg.com/dsh-sla@0.4.0/LICENSE)
