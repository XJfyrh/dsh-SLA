# 论文与实现范围

研究来源：Qizheng Zhang 等，[*Stateless Language Agents: Scaling Long-Horizon Automated Research*](https://arxiv.org/abs/2610.07625)，2026，arXiv:2610.07625。

本项目把“会话之外的持久研究状态 + 新会话执行 + 基于实验反馈继续搜索”用于 DeepSeek Harness。

| 机制 | 当前实现 |
| --- | --- |
| 无状态角色调用 | 每次调用 fresh spawn，目标与已保存证据重新组装 |
| 研究状态持久化 | 制品、观测、尝试、分支与决定存于 Host |
| 多方向接续 | 各方向局部候选与全局候选分别保留 |
| Advisor 规划 | 按方向汇总正负反馈、执行失败与待重测结果 |
| 评价可靠性 | 独立评价；代码检查冻结；补充检查复验后发布 |
| 长期自主研究 | 支持有限轮次接续；尚无本版本长时真实模型收益结论 |
| 并行与隔离 | 当前串行；无容器级进程和网络隔离 |

仓库的当前验证覆盖状态规则、工具调用和 Host 接入，见[验证结果](validation.md)。

DSH 集成依据：[官方插件发布文档](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/user/develop/basic/publish.md)。SLA 复用宿主的插件安装、会话、工具、Skill、用量和会话导出。
