# 参与开发

使用 Node.js 24；在仓库根目录执行：

```sh
npm ci
npm test
npm run check
npm run check:types
npm run check:package
```

`npm test` 先构建并运行全部严格类型检查，再测试 `dist/` 中的实际 JS。测试使用固定响应与临时项目，覆盖候选接续、评价事务、权限、交付恢复、文件写入与客户端渲染。性能优化、缺陷修复等任务输入保留原来的 JS。

`npm run check:types` 严格检查 Host、客户端、测试、工程脚本、宿主探针和扩展使用方正反例；`npm run check` 核对全部实现都进入严格检查，并检查产物语法。`npm run check:package` 生成 tarball，在系统临时目录仅安装生产依赖，加载每个公开运行入口，再安装固定的 DSH 开发类型依赖检查包内声明。结果和包写入 `artifacts/package/`，临时使用方目录记录在 `verification.json`。

## 源码和构建

`src/`、`extensions/`、`scripts/` 和 `test/` 使用 TypeScript。`src/data.ts` 定义持久事实及运行时解析器；`src/contracts.ts` 定义工作流契约；`src/wire.ts` 定义 Host 与客户端通信契约。外部结果从 `unknown` 开始，在使用前校验。领域评价允许自有 JSON 字段，使用方需缩窄这些字段，核心不预设数值分数。

```sh
npm run build
npm run build:client
```

完整构建先检查构建脚本类型，再清理本仓库的 `dist/`，编译 Host 与客户端，生成 JS、`.d.ts`、JS source map 和 declaration map，再打包浏览器入口 `dist/client.js`。所有 map 内嵌源内容，安装包不需要源码目录即可调试。`build:client` 只严格检查和重建浏览器 bundle，适合界面开发；修改共享契约后运行完整构建。

两个实现程序都启用 `strict`、`noEmitOnError`，不跳过依赖类型检查。固定 DSH 的 Host 与客户端对 Cordis `Context.sessions` 有不同增强，分别用 `tsconfig.json` 和 `tsconfig.client.json` 编译；共享模块不能引入另一侧的运行环境。`tsconfig.consumer.json` 和 `tsconfig.client-consumer.json` 分别从公开导出检查工作流与客户端使用方，未命中的错误断言也会使检查失败。

工程脚本与测试由 Node.js 24 直接执行 `.ts`，不另行生成脚本 JS；`erasableSyntaxOnly` 限定为 Node 可直接擦除的类型语法，`tsc --noEmit` 负责实际检查。

| 类型检查配置 | 范围 |
| --- | --- |
| `tsconfig.tools.json` | 构建、源码覆盖检查、打包及包运行验证 |
| `tsconfig.probes.json` | 真实 DSH Host 验证脚本 |
| `tsconfig.tests.json` | 核心、工作流、文件与原生日志测试 |
| `tsconfig.client-tests.json` | 客户端状态与实际 bundle 渲染测试 |

Host 探针及行为测试同时开启 `exactOptionalPropertyTypes`，符合 DSH 原生日志类型对可选字段的定义。客户端测试使用真实 Cordis Context，并按 DSH 服务方法与组件 props 检查替身。测试依旧导入 `dist/` 的运行入口；`test/state-fixtures.ts` 只构造完整状态，异常输入在对应回归用例中明确保留。

单独运行或调试测试前先构建和检查类型：

```sh
npm run build
npm run check:types
node --test test/engine.test.ts
node --inspect-brk --test --test-concurrency=1 test/client-render.test.ts
```

`examples/` 下作为优化或修复目标的 JS 项目保持原语言；其行为测试仍由 `npm test` 执行。

`dist/` 不提交；公开声明全部由源码生成，不维护手写实现声明。DSH `Context.sla` 与 Typert namespace 增强位于源码契约中，由编译器一起输出。`package.json` 的导出统一指向 `dist/`；CI 在干净安装后运行上述检查，任何检查失败都会阻止通过。

DSH 依赖固定为 `0.2.1-rc.2`，共享 API 同时声明为 peer 和开发依赖；Zod 固定为宿主 storage-domain 使用的 `4.4.3`。插件打包与安装遵循[固定版本官方指南](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/user/develop/basic/publish.md)：tarball 自带运行产物，宿主安装不执行源码构建。升级 DSH 时同时核对 API、客户端 ModuleLoader、存储与 structured output 契约。

## 在 Harness 中开发

先构建，再按[安装说明](install.md)创建开发 profile 并链接仓库：

```sh
dsh plugin --profile sla-demo add /absolute/path/to/dsh-SLA
```

替换为仓库绝对路径，Windows 可使用 `E:/projects/dsh-SLA`。修改 Host 后重新构建并重启；修改界面后执行 `npm run build:client` 并刷新。Node 调试可设置 `NODE_OPTIONS=--enable-source-maps`，浏览器开发者工具可直接查看 bundle map 中的 TS。

## 真实 Host 验证

使用独立 `DSH_HOME` 和 Web profile，安装待验收的 `.tgz`。profile 本身不隔离全局存储。此次迁移不转换历史格式；不应将旧记录复制到验收存储中。以下 PowerShell 命令建立独立环境，最后一个命令启动服务：

```powershell
$env:DSH_HOME = Join-Path (Get-Location) 'artifacts/dsh-acceptance'
dsh --profile sla-release-check --from-default-profile web --dump-config
$package = (Resolve-Path ./artifacts/package/dsh-sla-0.4.1.tgz).Path
dsh plugin --profile sla-release-check add $package
dsh --profile sla-release-check --no-open --port 3092
```

`--from-default-profile` 只在首次创建使用。浏览器打开启动日志中的含 token 的 URL。以下脚本作为临时 `--patch` 插件挂载，每次单独运行；脚本提供固定模型响应，不请求外部模型：

- `scripts/verify-workflow.ts`：参数工作流，从注册到交付。
- `scripts/verify-presentation.ts`：Worker 与 Reviewer 的真实 structured_output 契约。
- `scripts/verify-researcher.ts`：子会话工具、Skill、调用额度、注册卸载与只读权限。

临时 patch（将路径替换为该脚本的绝对文件 URL）：

```yaml
- insert:
    - id: sla-verification
      name: file:///absolute/path/to/scripts/verify-workflow.ts
```

```sh
dsh --profile sla-release-check --patch ./artifacts/verify.patch.yml --no-open --port 3092
```

结果写入仓库 `artifacts/`。检查 JSON 的 passed 和具体断言，随后退出验证服务。设置 `SLA_VERIFY_UI=1` 时，参数探针保留未交付候选，供浏览器验证设置保存、内容预览和采用；该模式的报告不声称已验证交付，需另核对 UI 交付及其磁盘回执。正式 profile 不挂载验证插件。

pnpm 会缓存同版本、同路径的 tarball 安装。反复验收本地包时，先按内容摘要复制成唯一文件名再安装，并核对安装目录与构建输出的哈希。

`scripts/verify-long-horizon.ts` 是可选真实模型实验工具，通过 `SLA_CAMPAIGN_INPUT` 读取目标、工作区、输出目录和额度；会消耗模型用量。它复用固定版本 DSH 的会话导出与 Token 用量计算；输入配置、检查点和原始归档均经过运行时校验。原生日志只接受当前格式，使用官方解析器检查，且必须保留原始事件，不补写中断 Turn。脚本不进入 npm 安装包。

模型实验输入包含 `cwd`、`goal`、`output` 和 `settings`；可选 `checkpoint`、`maxTokens`。只导出已有会话时使用 `exportSession`、`report`、`output`。两种输入均可带 `priorExport: { report, output }`，先保存上一份原生归档。运行真实模型前先确认目标和预算。

## 维护文档配图

配图按读者的问题组织：[产品概览](images/exploration-flow.drawio.svg)、[状态接续](images/state-lifecycle.drawio.svg)、[扩展架构](images/architecture.drawio.svg)、[候选演进](images/candidate-branches.drawio.svg)。同一张图在不同文档中引用同一文件。

图内保留节点、关系和必要图例；完整说明放在正文。修改后按文档中的显示宽度检查文字与连线。

`docs/images/*.drawio.svg` 内嵌 draw.io 源图，可以直接在 draw.io 中打开编辑。导出 SVG 时保留图表数据、关闭字体嵌入，再替换原文件。

## 发布

包内容由 package.json 的 files 白名单控制：生成的 JS、声明和 map、Cordis patch、图标、语言文件、说明与示例。实现源码、测试、验证脚本、调研原稿和本机证据不进入包。`npm pack` 的 prepack 自动完成完整构建。

```sh
npm pack --pack-destination artifacts
npm publish ./artifacts/dsh-sla-0.4.1.tgz --access public --registry https://registry.npmjs.org
```

发布前完成回归、Host tarball 安装和内容检查。发布后从 npm 重新下载，核对 integrity 并在独立 profile 安装。版本发布后不可原样覆盖。
