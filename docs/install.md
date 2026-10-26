# 安装与运行

## 安装 npm 包

前提：Node.js 24、Git、DeepSeek Harness 0.2.1-rc.2；Harness 已配置模型。插件沿用会话的模型、权限、输出额度和用量统计。

```sh
dsh plugin --profile web add dsh-sla@0.4.0
dsh web
```

`web` 是 profile 名，已有自定义 profile 时替换为该名称。安装后重启该 profile 的 Host，刷新 Web 页面。打开项目，以“工作区内修改”模式新建会话，选择“持续探索 · SLA”。插件需要读取项目、创建独立候选并执行检查；采用代码时才写回原项目。

## 独立体验 profile

首次创建一个新名称的 profile：

```sh
dsh --profile sla-demo --from-default-profile web
```

退出后安装并启动：

```sh
dsh plugin --profile sla-demo add dsh-sla@0.4.0
dsh --profile sla-demo
```

`--from-default-profile` 会重建指定 profile，首次创建后不再重复使用。模型配置由 DSH 管理。

## 试一个目标

从包内 `examples/clamp-bug` 复制一个目录作为工作区，发送：

> 修复 clamp(0, -5, 5) 错误返回 -5 的问题，保持其他行为，不增加依赖。

运行时可暂停，或在主对话补充约束。检查面板中的结果与改动后点击采用；原项目若已变化，插件会停止写回。探索状态和证据位于 `~/.dsh/sla-artifacts/<探索 ID>/`，详细会话可使用 DSH 导出。

## 卸载

```sh
dsh plugin --profile web remove dsh-sla
```

重启该 profile。卸载不删除探索证据目录。

## 从源码开发

在仓库根目录执行：

```sh
npm ci
npm run build:client
dsh plugin --profile sla-demo add /absolute/path/to/dsh-SLA
```

最后一条把路径替换为当前仓库的绝对路径（Windows 可使用 `E:/projects/dsh-SLA`）。本地路径由 DSH 包管理器链接；修改 Host 后重启，修改界面后重新构建并刷新。发布验证则必须安装实际 `.tgz`，不能用链接安装代替。

安装机制依据 [DSH 官方插件发布文档](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/user/develop/basic/publish.md)。
