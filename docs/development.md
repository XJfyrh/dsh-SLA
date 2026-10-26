# 参与开发

使用 Node.js 24；在仓库根目录执行：

```sh
npm ci
npm test
npm run check
npm run check:types
npm run build:client
npm run check:package
```

测试使用固定响应与临时项目，覆盖候选接续、评价事务、权限、交付恢复和文件写入。公共类型从包导出路径导入并使用真实 DSH 类型检查。`client.js` 是生成物，源文件是 `src/client-factory.js`、`src/client-state.js` 和 `src/presentation.js`；生成后不应出现未提交差异。

## 在 Harness 中开发

先按[安装说明](install.md)创建一个开发 profile，再链接仓库：

```sh
dsh plugin --profile sla-demo add /absolute/path/to/dsh-SLA
```

替换为仓库绝对路径，Windows 可使用 `E:/projects/dsh-SLA`。修改 Host 后重启；修改界面后执行 `npm run build:client` 并刷新。

## 真实 Host 验证

使用独立 Web profile，安装待验收的 `.tgz`。以下脚本作为临时 `--patch` 插件挂载，每次单独运行；脚本提供固定模型响应，不请求外部模型：

- `scripts/verify-workflow.mjs`：参数工作流，从注册到交付。
- `scripts/verify-presentation.mjs`：Worker 与 Reviewer 的真实 structured_output 契约。
- `scripts/verify-researcher.mjs`：子会话工具、Skill、调用额度、注册卸载与只读权限。

临时 patch（将路径替换为该脚本的绝对文件 URL）：

```yaml
- insert:
    - id: sla-verification
      name: file:///absolute/path/to/scripts/verify-workflow.mjs
```

```sh
dsh --profile sla-release-check --patch ./artifacts/verify.patch.yml --no-open --port 3092
```

结果写入仓库 `artifacts/`。检查 JSON 的 passed 和具体断言，随后退出验证服务。正式 profile 不挂载验证插件。

`scripts/verify-long-horizon.mjs` 是可选真实模型实验工具，通过 `SLA_CAMPAIGN_INPUT` 读取目标、工作区、输出目录和额度；会消耗模型用量。它复用 DSH 原生会话导出，相关测试校验导出的根会话身份与检查点，未纳入 npm 安装包。

## 维护文档配图

配图按读者的问题组织：[产品概览](images/exploration-flow.drawio.svg)、[状态接续](images/state-lifecycle.drawio.svg)、[扩展架构](images/architecture.drawio.svg)、[候选演进](images/candidate-branches.drawio.svg)。同一张图在不同文档中引用同一文件。

图内保留节点、关系和必要图例；完整说明放在正文。修改后按文档中的显示宽度检查文字与连线。

`docs/images/*.drawio.svg` 内嵌 draw.io 源图，可以直接在 draw.io 中打开编辑。导出 SVG 时保留图表数据、关闭字体嵌入，再替换原文件。

## 发布

包内容由 package.json 的 files 白名单控制。只包含运行文件、必要说明与示例，测试、验证脚本、调研原稿和本机证据不进入包。

```sh
npm pack --pack-destination artifacts
npm publish ./artifacts/dsh-sla-0.4.0.tgz --access public --registry https://registry.npmjs.org
```

发布前完成回归、Host tarball 安装和内容检查。发布后从 npm 重新下载，核对 integrity 并在独立 profile 安装；不能用 npm publish 的成功回执替代下载与安装验证。版本发布后不可原样覆盖。
