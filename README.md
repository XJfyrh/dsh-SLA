# DSH SLA

给项目一句改进目标，SLA 自己调查项目、建立可执行判断依据，并连续尝试改进。你可以随时补充要求、暂停或继续；每次尝试留下检查结果，最后由你选择是否采用。

这是面向 **DeepSeek Harness 0.2.1-rc.2 / Node.js 24** 的最小插件，使用原生会话卡片和独立实验会话。

## 安装和使用

需要 Node.js 24、Git、DSH 0.2.1-rc.2 和已登录的模型账号。新机器先运行一次 `dsh --profile sla-dev --from-default-profile web` 建立 Web profile，退出后再安装；本机已完成此步骤。

```powershell
npm install --legacy-peer-deps
npm run build:client
dsh plugin --profile sla-dev add E:\dev\dsh-plugins\dsh-SLA
dsh --profile sla-dev --no-open --port 3080
```

打开命令输出的地址，在工作区选择一个项目，新建会话并选择 **持续探索 · SLA**，直接发送目标，例如：

> 让这个项目在大数组上运行得更快，保持现有行为，不增加依赖。

随附的 `examples/duplicates-baseline` 是无第三方依赖的初始练习项目，可复制后作为工作区；`examples/duplicates` 用于本次真实 Web 验收。插件不会要求你事先编写评价脚本。

- **补充要求**：保存约束并重建评价依据，旧实验仍可查看；旧版本分数不与新版本混比。
- **暂停 / 继续**：停止当前调用并保留结果；额度用完后，继续会开启新的有限轮次。
- **查看依据与实验**：查看实际检查、各次尝试和本地证据目录。
- **采用这个结果**：重新检查最佳候选，确认原项目没有变动后写回。原始快照保留；有本地改动时拒绝覆盖。

## 首版范围

适合可在本机运行检查的代码项目。调查、规划和执行使用新会话；Host 保存状态、冻结评价文件并独立执行每次检查。默认每轮最多 3 次尝试、20 分钟，每次模型调用最多 24 步和 5 分钟。时间、步骤与轮次上限不是费用硬限。

实验在 `~/.dsh/sla-artifacts/<探索 ID>/` 中，保留初始快照、评价依据、候选、原始检查输出和 `report.json`。重启后暂停，点击继续才恢复。文件快照上限 100 MiB / 15000 文件；跳过 Git 忽略项、依赖/构建目录和 `.env`，遇到符号链接停止。依赖目录不会复制，所以首版优先用于无依赖或依赖已由系统提供的子项目。

自动建立的评价依据应结合任务检查；“通过”表示通过这套检查。首版串行探索一个方向，不包含论文的多方向并行 Epoch。Windows 文件策略限制写入，不提供进程读隔离或网络隔离。

## 开发

```powershell
npm test
npm run check
npm run build:client
npm pack --pack-destination artifacts
```

`src/client-factory.js` 是界面源码，`client.js` 是随包交付的浏览器产物。修改 Host 后重启 Harness；修改界面后先构建，再刷新页面。

[设计与官方依据](docs/design.md)记录版本、插件契约和与 SLA 论文的对应范围；[首版验收](docs/validation.md)记录真实 Web 流程、失败修复和复跑方法。原有调研在 `research/`。
