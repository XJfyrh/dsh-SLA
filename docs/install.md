# 安装 SLA

准备好 Node.js 24、Git 和 DeepSeek Harness 0.2.1-rc.2，并在 Harness 中配置可用模型。

## 加入正在使用的 Harness

```sh
dsh plugin --profile web add dsh-sla@0.4.1
dsh web
```

`web` 是 profile 名；使用自定义 profile 时替换为它的名称。已有 Web 服务请重启，再刷新页面。

在工作区选择项目，新建会话，选择 **持续探索 · SLA**。发送一个改进目标，便会开始调查与探索。第一次可以跟着[使用指南](usage.md)尝试修复一个小缺陷。

## 单独建一个体验环境

首次创建名为 `sla-demo` 的 profile：

```sh
dsh --profile sla-demo --from-default-profile web
```

退出后安装插件，再启动：

```sh
dsh plugin --profile sla-demo add dsh-sla@0.4.1
dsh --profile sla-demo
```

以后启动只用最后一条命令。`--from-default-profile` 会重建指定 profile，创建后不再重复使用。模型仍在 Harness 中配置。

## 获取练习项目

在一个空目录中下载并解压 npm 包：

```sh
npm pack dsh-sla@0.4.1
tar -xf dsh-sla-0.4.1.tgz
```

示例在 `package/examples/`。复制其中一个项目到自己的工作目录，再通过 Harness 添加为工作区。

## 卸载

```sh
dsh plugin --profile web remove dsh-sla
```

重启对应 profile。已有证据仍保留在 `~/.dsh/sla-artifacts/`。

开发者使用源码安装，见[参与开发](development.md)。
