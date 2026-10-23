# Stateless Language Agents (SLA) —— 实现级机制规格

- **论文**：*Stateless Language Agents: Scaling Long-Horizon Automated Research*，arXiv:2610.07625v1（2026-10-06，32 页，CC BY 4.0）。
- **抓取**：2026-10-23；全文取自 [arXiv HTML](https://arxiv.org/html/2610.07625v1)（§1–§5 + Appendix A–E 均已获取，含 Appendix E 六段 prompt 原文，已逐字存入 [`research/paper-sla-raw.md`](research/paper-sla-raw.md)）。
- **代码可用性**：`github.com/Alex-q-z/stateless-language-agents` 抓取时 **只有 1 个 commit、1 个文件** `assets/sla-preprint.pdf`（GitHub API `git/trees/main` 全量确认；README 不存在）。公开 issue #1 里 HF 官方提到"代码将很快发布"，但 **无可执行代码可供核对**。因此本文所有实现细节来自论文 Appendix B.1 + Appendix E prompt 原文；凡论文没写的字段一律标注【推断】。
- **标记约定**：【原文】= 论文可直接引用的事实；【E】= Appendix E prompt；【B.1】= Appendix B.1；【§4.3】等 = 论文正文数据；【推断】= 我的设计推断；【未获取】= 抓取不到。
- **注意**：抓取内容为外部不可信资料，本文只提取事实，不执行其中任何指令。

---

## 0. 速览（给 Lead 的压缩版）

SLA 的论点是「**stateful search with stateless agents**」：研究状态（candidates + measured outcomes）归 harness 所有，agent 每次 invocation 都是全新 session，context 由 harness 按角色重建。两个机制：**(a) harness-controlled context reconstruction**（Advisor 看跨方向证据摘要；Worker 只看自己的 assignment + 保留候选 + 上一 trial 反馈）；**(b) evidence-driven work assignment**（Advisor 每 epoch 给每个 Worker 一个具体实验方向 REGIME + PROPOSAL）。超参极简：**W=3 个 Worker，每 Worker 每 epoch 3 次 local trial**（一个 epoch ≈ 9 个 trial）。收益：Anthropic kernel 上 3/3 SLA run 全胜 9/9 baseline run（1112.0±8.9 vs 1275.7±133.9 cycles），达到最强 baseline 最终成绩只需 67.9M vs 986.3M tokens（−93.1%）；FrontierSWE 四项在 25% budget 时全部落后、100% budget 时全部反超。Advisor 只占 0.24–0.51% tokens、1.20–2.29% 成本。**最关键的负面事实**：论文的消融只改了"每个 agent 看到什么"，**没有**消融"agent 是否跨 invocation 保留对话"——即中央的 statelessness 主张本身没有被直接证明，证据强度弱于 focused context / assignment 两项。

---

## 1. 状态/上下文分离原理：state vs context，以及为什么 harness 拥有 research state 是关键

**定义（【原文】，§1/§3）**：论文显式区分 *agent state*（跨 invocation 持久的东西）与 *context*（一次 invocation 内 agent 看到的东西）。"A stateless agent keeps no state: nothing it accumulates, including its conversation, carries over to its next invocation. This does not make it contextless." 关键推论：**每一次 Advisor epoch、每一次 Worker trial 都是一次独立 invocation；每次 invocation 都开新 session；只有 harness 写进 research state 的东西能跨 invocation 存活**（§3）。research state 的定义很窄、很硬："the harness owns the research state (**candidate solutions and measured outcomes**)"。

**为什么"harness 拥有"是关键（而非"agent 拥有但定期摘要"）**：
1. **Context 变成显式设计变量**。既然没有历史可继承，"每个 agent 看到什么"就必须由 harness 逐块拼装，从副产品变成一个可消融、可复现的设计选择（【原文】§1）。
2. **切断长会话的三类失效**（§1/§2.2 的动机数据）：CORAL 一次 GPU kernel run 里最后一次改进发生在 231M tokens，之后 **最后 1,500 个 session 中 98% 不再发出任何 tool call**，但 token 继续烧；CORAL 的 restart 会 *resume 同一个 session*，于是"一个已经决定停止的对话"被反复续写，更多推理只是在重复那个决定。SLA 的对策是"restart 时不 resume 对话，而是从 measured state 重新推理"——【E】原文一句话总结：**"Reset means fresh reasoning from measured state, not amnesia."**
3. **可检查、可回滚、可 checkpoint**（§5）：所有持久状态都在 harness 里，人能审计/rollback；不存在"某个 agent 把计划或注入指令带进自己的对话里"的通道。
4. **可做受控实验**：research state 可 checkpoint，消融从**同一个 checkpointed research state** 继续（§4.3），否则并行多 agent 的实验无法比较。
5. **使"分工"成为可能**：状态在 harness → Advisor 能看到跨方向证据，Worker 只能看到局部证据，信息差是被设计的（§3.2）。

**与 native subagent orchestration 的区别（【原文】§3 "Relation to native subagent orchestration"）**：Codex/Claude Code 的 native subagent 并行、context 分离，**但 orchestrator 本身仍是有状态的**：它保留自己的对话，并由它决定每个 subagent 看到什么、何时停。SLA 与这类工具兼容，但**连 Advisor 也是 stateless**，且"what each context contains"由 harness（而非某个 agent）决定。实践含义：在 DSH 里做 SLA，不能"让主 agent 自己 fork 子 agent 并管理它们"——主 agent 必须降级为一次性的 Advisor invocation，编排权在 harness。

---

## 2. Research state 数据模型

论文**没有给出 schema、字段名或存储格式**【未获取】；只有散落的事实约束。下表把论文的散点重组成可实现的数据模型，逐字段标注来源。核心实体：`candidate`、`trial/outcome`、`lane(worker)`、`global_best`、`ledger`、`token_account`、`budget`、`checkpoint`、`task_adapter`。

### 2.1 Candidate（候选解）

| 字段 | 含义 | 依据 |
|---|---|---|
| `candidate_id` | 全局唯一 ID | 【推断】 |
| `artifact` | 真正的解：kernel 是 `submission.py` 全文；FrontierSWE 是 `candidate.bundle`（多文件累积包，自定义 `=== FILE: path ===` 格式）；Anthropic kernel 是单个 `{editable_file}` | 【E】 |
| `score` | 外部 evaluator 测得的标量（cycles / frontier_reward / SOL score / SOL cost / FrontierCS score） | 【原文】§3；【E】 |
| `score_direction` | `min`（cycles↓、SOL cost↓）或 `max`（frontier_reward↑、SOL↑） | 【E】 |
| `parent_id` | 从哪个候选改出来的（用于 lineage 与"同 parent 重复劳动"检测） | 【§2.2/D.2 追踪分析使用 parent 列】 |
| `direction` / `regime` | 该候选属于哪个搜索方向（kebab-case tag，如 `text-decode`；SOL 里叫 REGIME） | 【E】 |
| `worker_id` / `lane` | 产生它的 lane；每个 lane 有私有 workspace，**不能互相拷贝** | 【E】 |
| `retention` | `global_best` / `lane_local_best` / `archived` / `rejected` | 【原文】§3.2 +【E】local reward rule |
| `eval_status` | `sealed_valid`（评测通过且拿到分）/ `inconclusive`（impl/运行时/正确性失败）/ `rejected_precheck`（反作弊/契约违规） | 【原文】§3.1 +【E】 |
| `diagnostics` | 正确性 case 通过数（trace 里出现过 "20 → 22 out of 31 namespace tests"）、build/materialize 状态、anti-cheat 状态、可信 aggregate engine 统计 | 【E】+【Appendix D.3】 |
| `report` | Worker 自报：`Implemented`（≤80 字符，进结果日志）、`Technical detail`、`Rationale`、`Deviation` | 【E】 |
| `tokens` | 产出该候选的 invocation 的 token（cached/uncached input + output） | 【B.1】 |

要点：**分数只来自 evaluator，绝不来自 agent**——【E】"A separate trusted process loads the frozen evaluator … candidate output is never a score"，且"A candidate can never be accepted on agent output alone"。

### 2.2 Trial / measured outcome（每次实验一条记录，chronological record 的原子）

```
Trial { trial_id, epoch, worker_id, regime,
        input_candidate_id, output_candidate_id,
        status: sealed_valid | inconclusive_impl | runtime_error | correctness_fail | rejected_precheck,
        score, delta_vs_lane_best, delta_vs_global_best,
        diagnostics{ build, correctness_cases, anti_cheat, aggregate_stats },
        report{ implemented<=80ch, detail, rationale, deviation },
        tokens{ c_in, u_in, out }, wall_clock, evaluator_version }
```
依据：【B.1】"SLA saves candidate snapshots, evaluation outputs, and event logs"；【E】report 格式与 ≤80 字符；§3.1 "full chronological record of every experiment"。同一 parent 被多个 Worker 重复实现的情况在 CORAL trace 里被记录下来，SLA 也必须有 parent 才能检测 duplication。

### 2.3 Lane / Worker

```
Lane { worker_id, regime, workspace_path, status: active|paused|redirected|error,
       local_best_candidate_id, local_anchor_score, trials_run, last_feedback{status,score,diagnostics} }
```
依据：【原文】§3.1/§3.2（保留 local candidate，即使落后 global best；redirect 后从头开始）；【E】"A worker you omit is paused for the whole epoch"；【E】discard/error → `submission.py` 回滚到 lane best。

### 2.4 派生视图：evidence summary + sanitized ledger

- **evidence summary**：由 harness 从 trials/candidates 聚合出的**只读视图**（不是 agent 写的笔记）：recent attempts、按 direction 分组的 outcomes、Worker status、recent progress（frontier 的移动斜率/age）、task-specific diagnostics（§3.1）。
- **sanitized scalar research ledger**（【E】kernel advisor prompt）：mechanism/direction → 标量结果与"strong negative evidence"，**只保留标量与机制标签，不放 raw rejected code**；用途原文："Use the sanitized ledger to avoid repeating mechanisms with strong negative evidence"。
- 注意：SLA **没有 CORAL 式的 agent 自由文本 notes/claims 机制**——SLA 用 harness 记录替代了 notes；CORAL 的 notes 只在 Appendix D.1/D.2 作为对照失败案例出现。若复刻时想要 notes，那是我们的加法，不是 SLA 的机制。【推断】

### 2.5 其他状态

- `global_best`：`{candidate_id, score, epoch, trial, frontier_age}`；§3.1 要求 Advisor 每 epoch 看到"current global best **code** and score"。
- `token_account`：按 role 分开记 **cached input / uncached input / output**（【B.1】），支持 budget 强制与成本分析（§4.4 用 GPT-5.5 的 $5/$0.50/$30 per M 计价）。
- `budget`：**外部** cumulative token counter，"never exposed to the agents"，达到即停（§4.1/B.2）。实际值：Anthropic kernel 1B、FrontierSWE 每任务 700M、SOL 每任务 500M、FrontierCS 200M。
- `checkpoint`：完整 research state 快照 = candidate snapshots + evaluation outputs + event logs（【B.1】），可 resume，可供消融在 10%/20% budget 处切分（§4.3）。
- `task_adapter`：见 §7。

---

## 3. 循环协议

### 3.1 伪代码（按 §3 + B.1 + E 重组；控制流是【原文】，字段名是【推断】）

```python
while budget.spent_tokens < budget.total:          # 外部 counter，agent 不可见
    epoch += 1
    ctx_a = build_advisor_context(state)           # 见 §4.1，每 epoch 重建
    out   = invoke(role="advisor", session="new", context=ctx_a, tools=[])   # 1 invocation
    a     = parse(out)  # STATE / SEARCH POSTURE / REGISTRY / DIRECTIVES / PROPOSALS[worker_i]
    for lane in lanes_requested_by(a):              # 未列出的 lane 整个 epoch 暂停
        if a[lane].regime != lane.regime:           # 方向切换 = redirect
            lane.workspace := global_best.artifact  # 从 global best 重启
            lane.local_best := None
        for t in 1..3:                              # mini-epoch，默认 3 次 local trial
            ctx_w = build_worker_context(state, lane)          # 见 §4.2
            res   = invoke(role="worker", session="new", context=ctx_w)  # 1 invocation
            cand  = read_artifact(lane.workspace)              # 以磁盘产物为准
            ev    = sealed_evaluate(cand)                      # Worker 环境之外，protected evaluator
            record(Trial(...))                                 # 回填 score/status/diagnostics/report/tokens
            if ev.sealed_valid and better(ev.score, lane.local_best): lane.local_best = cand
            elif ev.failed: restore(lane.workspace, lane.local_best)   # 失败/丢弃 → 恢复保留候选
            if better(ev.score, global_best): global_best = cand
        update_ledger_and_lane_status()
    checkpoint_if(epoch)
```

### 3.2 Invocation 边界（这是 SLA 的第一性约束）

- **1 个 epoch = 1 次 Advisor invocation**（新 session），**1 个 trial = 1 次 Worker invocation**（新 session）。任何跨 invocation 的信息流只能经过 research state（§3）。
- 因为 Advisor 也是 stateless，它**每 epoch 都从当前证据重新推导 assignment，而不是接着上一 epoch 的推理往下想**（§3.2 原文）。这既是"避免确认偏差"的机制，也是"每 epoch 都要付一次全量证据读取成本"的代价（实测仍只有 0.24–0.51% tokens）。
- 一个 Worker 的 3 次 local trial 共用**同一个 assignment**（【E】"The same assignment is reused for several trials in a mini-epoch"），每次 trial 只做"一个 coherent edit"，在 lane-local best 上继续堆。

### 3.3 Advisor 的输入/输出契约

**输入**：见 §4.1 的块清单。
**输出**（【E】；kernel prompt 说"The SLA runner supplies the exact multi-worker STATE, SEARCH POSTURE, REGISTRY, DIRECTIVES, and PROPOSALS response format"；SOL prompt 给出了唯一一份**逐字可用的输出模板**）：

```
## STATE           2–5 句：frontier 在哪、哪些 regime 还在下降、哪些已平坦、哪些 cross-regime 判决现在有效、下一个高杠杆面
## REGISTRY        | regime | best_cost | n | status | workers |    status ∈ {maturing, mature-WIN, pruned}
## DIRECTIVES      - AVOID: <phrase> (rationale: ≤15 words)
                   - TRY:   <phrase> (rationale: ≤15 words)
                   - MANDATE workerN: <strategic direction> | <rationale>   (可选)
## PROPOSALS
### worker0
REGIME: <short-kebab-tag>
PROPOSAL: <one coherent implementation direction for this worker's next trials>
### worker1 ...
```
关键语义（【E】逐字）：**REGIME 复用 = 继续该 lane；REGIME 换新 = 该 lane 被 re-seed 到当前 global best kernel 并清空 local anchor**；"Emit one ### workerN section for every active worker. A worker you omit is paused for the whole epoch"；"You get {worker_steps_per_advisor} local trials per worker per epoch. One PROPOSAL must therefore describe a coherent direction worth several edits, not a single tweak."

### 3.4 Assignment 的格式：什么叫"具体实验"

不是"去优化 X"，而是必须包含可验收的机制描述。kernel prompt 要求每个 proposal 必须给出：(a) **它移除或重叠的 operation family**；(b) **expected saving scale**（相对当前 frontier 的节省量级）；(c) **它依赖的 public correctness invariant**。FrontierSWE 版本要求：concrete surface + 要扩展/替换的当前机制 + **regression invariant** + "the signal that would support or falsify the hypothesis"（即 falsification 条件），并禁止指定行号或编造 frontier 里没有的细节。

**"Acceptance criterion" 在 paper 里不是一个独立字段**【推断】：真正的验收由 harness 的 sealed evaluator 执行（score 是否高于 lane best / global best），prompt 只负责声明 (a)(b)(c) 与回归不变量；论文明确禁止 Advisor 用"另一个 run 的固定分数阈值"来验收（"do not use a fixed score threshold from another run"）。复刻时建议把 (b)(c) 当作 assignment 的必填结构，验收仍以 measured score 为准。

### 3.5 终止/预算条件

- **唯一硬终止：外部 cumulative token counter 触顶**（input+output 全角色累计），agent 不可见（§4.1、B.2）。没有"连续 k 次无改进就停"的机制；停滞由 Advisor 的策略处理（kernel prompt："When measured progress has stalled, explicitly consider whether the current representation is the constraint"）。
- 另有软边界：Advisor 可暂停某 lane（不在 PROPOSALS 里出现）；Worker 输出被截断时有 recovery 路径（capability-limited runtime 用"fresh forced-write recovery turn"；native runtime 保留已落盘的 checkpoint，由 SLA 走同一个 sealed evaluator 判定）【E】。
- 预算切分：消融用 10%/20% checkpoint + 100M continuation；主实验用 25%/100% 两个报告点。

### 3.6 Worker 被 redirect 时如何重启（关键细节，容易实现错）

【原文】§3.2 + 【E】一起给出一条精确语义：
1. Advisor 给某 lane 分配**新的 REGIME** ⇒ harness 把该 lane 的 workspace（`submission.py` / `candidate.bundle`）**重置为当前 global best**，并清空 local anchor。
2. 该 lane 的**第一个成功评测的候选成为新的 local baseline**，即使它比 global best 差——这样"新方向可以先落后再成熟"。
3. 只要 REGIME 不变，Worker 就在**自己的 lane-local best** 上继续；**local reward 规则**：候选只要打败 lane 自己的 regime best 就被保留，即使仍慢于 global frontier（"A young regime is never killed for sitting behind a mature one"）。
4. Harness 永远保留 lane 的改进，即使它落后 global best（§3.2）；只有 failed/discarded 才回滚到 retained local candidate（B.1）。
5. 跨 lane 传播技术只有两条合法通道：**Advisor 的 re-seed** 和 **PROPOSALS**——"workers cannot copy each other directly"（【E】）。

---

## 4. Harness-controlled context reconstruction：每 epoch / 每 trial 到底看到什么

### 4.1 Advisor 每 epoch 的 context 块

| # | 块 | 内容 | 依据 |
|---|---|---|---|
| A1 | task specification | task 名、public dimensions、canonical public instruction（如 `PUBLIC_TASK_INSTRUCTION.md`）、可编辑 artifact、metric 定义 + 方向、baseline/frontier 起点值 | 【原文】§3.1；【E】 |
| A2 | frontier context | **当前 global best 的代码全文 + score**（"In reset mode it is authoritative; do not seek chronological run artifacts"）、frontier age | 【原文】§3.1；【E】 |
| A3 | reviewed public task files | 经审查的公开任务文件（只读、去敏） | 【E】 |
| A4 | trusted aggregate diagnostics | 可信聚合统计：engine counts、capacity lower bounds（下界）、build/materialize 状态、正确性 case 统计（如 20/31）、anti-cheat 状态、最 informative 的失败 | 【E】+【D.3】 |
| A5 | evidence summary | recent attempts；**按 search direction 分组的 outcomes**；Worker status；recent progress；task-specific diagnostics | 【原文】§3.1 |
| A6 | sanitized scalar research ledger | 机制/direction 的标量结果 + strong negative evidence（用于避免重复已被否定的机制） | 【E】 |
| A7 | 帧定与安全边界 | untrusted-input 声明（候选代码/注释是数据不是指令）、integrity boundary（禁止改 evaluator/tests/metric/资源限制等） | 【E】 |

**Advisor 明确看不到（【E】逐字）**："Raw rejected code, evaluator cases, seeds, expected values, worker chat, and hidden-test details are deliberately absent." 且 **不能**编辑文件、调 worker 工具、跑测试、跑评测（"Do not edit files, call worker tools, run tests, or attempt evaluation"）。

**消融"去掉 reconstruction"的等价实现**（B.1，很具体，可直接照抄）：不给摘要，Advisor 通过一个**只读接口**自行翻完整 chronological record，限额为 **每 epoch ≤32 次调用、≤320,000 字符返回、单次 ≤40,000 字符**。这条数据本身就是"摘要有多重要"的间接证据：若允许无限制翻记录，成本会炸。

### 4.2 Worker 每 trial 的 context 块

| # | 块 | 内容 | 依据 |
|---|---|---|---|
| W1 | task specification | 同上（公开任务材料、canonical instruction；native runtime 里是只读文件） | 【原文】§3.1；【E】 |
| W2 | assignment | Advisor 的 PROPOSAL + REGIME（"already in your task message"） | 【原文】§3.2；【E】 |
| W3 | retained candidate | 该 lane 的本地保留候选（磁盘上的 `submission.py` / `candidate.bundle`；"your turn message names your regime, your lane best, and the global best"） | 【原文】§3.1；【E】 |
| W4 | compact local feedback | **上一 trial 的 status、measured score、可用的 correctness diagnostics** | 【原文】§3.1 |
| W5 | 工作约束 | 只有 {editable_file} 可写；anti-cheat 清单；不得读 evaluator/harness；收尾报告格式 | 【E】 |

**Worker 不能看到**：其他 Worker 的 workspace 与候选、完整研究历史、evaluator 内部（scripts/seeds/expected values/hidden tests）、网络、host 状态、其他方向的经验。【原文】§3.1："Workers cannot access other Workers' workspaces or the full research history. Evidence from other directions reaches them only through the Advisor's assignments."

### 4.3 "Measured non-improvement" vs "inconclusive failure" 的区分（本论文最容易被复刻漏掉的语义）

这是 §3.1 点名的一个机制，并在 kernel advisor prompt 里被写成决策规则（【E】逐字）：

> "An implementation/runtime/correctness error is **inconclusive evidence** about a broad mechanism. A **sealed-valid non-improvement** is **negative performance evidence**; repeated independent sealed-valid outcomes are stronger evidence, but still do not prove every implementation of a broad idea is exhausted."

实现含义（【推断】）：state 里每个 trial 必须有可判别的 `status`，且 evidence summary **不能把两类混成一个"失败"计数**。否则会产生两种典型错误：(1) 把一个实现 bug 当成"该方向已死"，过早剪枝；(2) 把"跑失败了 20 次"当成"这个机制试过了"，其实一次都没真正测到分数。Advisor 的 REGISTRY 里 `n`、`status ∈ {maturing, mature-WIN, pruned}` 也必须区分：只有 **mature-vs-mature**（两个 regime 都成熟、近期改进斜率进入噪声底）才允许跨 regime 判决；"A still-descending regime is never declared a loser"；且"Treat SOL-cost differences within the measurement error as noise, not signal"。

---

## 5. Evidence-driven work assignment：为什么它是消融里最重要的部分

**证据（§4.3 Table 4，从共享 checkpoint 续 100M tokens，3 次重复，数字是"相对全 SLA 进度的下降%"）**：

| 消融变体 | kernel 100M→200M | kernel 200M→300M | libexpat 70M→170M | libexpat 140M→240M |
|---|---|---|---|---|
| w/o Advisor reconstruction | −23.3% | −69.3% | −72.2% | −43.4% |
| w/o Worker isolation | −42.8% | −17.4% | −74.8% | −14.8% |
| w/o Advisor assignments | −10.5% | −45.6% | **−84.2%** | −52.5% |

三个变体在**全部 4 列**都变差（方向一致，这是论文最强的消融结论）；幅度差异很大，其中 libexpat 70M 列的 −84.2%（进度 2.66 → 得分掉 2.24，std 0.92/0.33）是统计上最扎实的一格；kernel 200M 列的 −17.4%（≈4.7 cycles，std 4.5/14.2）基本是噪声。更关键的**长期效应**：单独把"去掉 Worker isolation"跑到完整 1B tokens，终点 **1336 cycles vs 全 SLA 1112.0**（差 224 cycles），远大于 100M 续跑时的差距 ⇒ "context 污染的成本随 horizon 复利增长"（§4.3）。注意这是 **n=1 的单次全量 run**。

**失败模式（论文用 trace 直接展示，不是推测）**：
- **重复工作**：CORAL libexpat trace（D.2）里两个 agent 从同一个 parent 出发，13 分钟内两次实现同一对 feature（先重复实现 duplicate-attribute 检查，再重复实现 reserved-prefix 检查），各自的第二次实现都没抬高 best score；即便 Agent B 专门发了 focus note "认领"方向，Agent A 因为"上次列 note 之后没再读"仍然撞车。**根因**：共享 attempts/notes 只能让 agent 看到"已完成"，看不到"即将要做"；且 CORAL 以 parent 为基准计分，于是重复也被标成 "improved"。
- **停滞 + 假最优**：§1/§2.2 的 98% no-tool-call 现象；restart 时 resume 同一 session ⇒ 反复重复"已决定停止"的推理。
- **SLA 无 assignment 时的对照（D.3）**：Advisor 在第 24 epoch 提出了 3 个不同任务，但 harness 把这些指令**扣下**不给 Worker；结果 3 个 Worker 从同一份代码出发**全部**去加 XML entity decoding（trial 269–271），无一提分；另一次两个 Worker 独立加同一个 duplicate-attribute 检查，代码除一个 label 名外完全相同。⇒ **有 Advisor 但不下发 assignment，等于没有分工**。

**assignment 如何避免 duplication（机制层面）**：
1. **信息不对称**：只有 Advisor 看得到跨 direction 证据 + 每个 lane 的状态/最佳/正在跑的机制，重复检测发生在唯一拥有全局视图的位置。
2. **结构化强制约束**（【E】kernel）："Across the complete worker roster, assign **at most one incremental lane**"（小修小补最多一个 lane）；其余 lane 必须是 mechanism-level change（能消掉工作量、改数据流/表示、改依赖调度）；每 Worker 恰好一个 regime + 一个具体方向；PROPOSALS 里直接写 `AVOID`（带理由）。
3. **REGISTRY + 成熟度规则**：避免"用成熟 regime 的调优 best 去杀一个刚出生的 regime"（这正是 CORAL 重复劳动的另一种形式：过早杀死年轻方向 → 所有人都回到同一条路）。
4. **允许主动集中**：可以给两个 Worker 同一个 REGIME tag 从同一个 frontier seed 并行冲一个瓶颈，也可以全部分散——集中/分散是每 epoch 显式决策（`SEARCH POSTURE`），不是静态配置。
5. **省略即暂停**：不写某个 workerN = 该 lane 整个 epoch 暂停，防止"没有任务的 Worker 自由发挥"造成重复。

**成本（§4.4）**：Advisor 占 **0.24%（kernel）/ 0.51%（libexpat）tokens**、**1.20%/2.29% 估算成本**；对照 SwarmResearch Shepherd 占 **8.39%/10.70% tokens**、**6.14%/7.35% 成本**。原因的一半是架构：Shepherd 长会话平均每次调用读约 **99K input tokens**，而 fresh session 起点约 **8K**；两法 cached input 都 >90%，所以"token 占比"其实低估了低缓存复用角色的真实成本，论文因此同时报了 cost share。另有一个消融细节保证公平：去掉 assignment 的变体里 **Advisor 仍然运行、仍然能把 Worker 重置到 global best、调用仍计费**——所以它隔离的是"assignment 通道"的价值，而不是"有没有 coordinator"。

---

## 6. 实现要点（Appendix B.1 全量）

**Statelessness 与隔离是被强制的，不是靠 prompt 请求的**（§3.3 原文："enforced rather than requested"）：
1. **Advisor**：每 epoch **新 session**。
2. **Worker**：以**非特权进程**运行；Linux **Landlock** 限制文件系统（含子进程）——挡住其他 Worker 目录、以及"不在本次 context 里"的过往实验产物；**限制网络**；trial 之间**清空 saved sessions 与临时文件**。
3. **Codex 的 built-in multi-agent 被关掉**，防止 agent 自己再开子 agent（绕过隔离/计费）。这对 DSH 复刻是直接警告：必须禁用/拦住嵌套 delegation。
4. **Evaluator 在 Worker 环境之外**：harness 在本地或远端 Modal container 里、在配置的时间/资源限额下评测；**evaluator 代码与打分逻辑对 Worker 不可改**。
5. **Adapter 白名单**：Worker 只能改 `editable files`，其他 task 文件只读（B.1）。
6. **候选以磁盘产物为准**：native runtime 里"leave the complete candidate on disk"；capability-limited runtime 里用 `submit_candidate`；两者都由 harness 在 Worker 返回后**独立评测**，且"a candidate can never be accepted on agent output alone"（【E】）。若 Worker 试图读 evaluator harness（`run_eval.py` 等），该 trial 直接判废、edit 被回滚（【E】）。
7. **两种 runtime 形态**（【E】，复刻时很有价值）：
   - *capability-limited*：只暴露 `read_file` / `analyze_candidate`（可信聚合）/ `evaluate_candidate`（sealed，有预算）/ `submit_candidate`；输出被截断时走 fresh forced-write recovery turn。
   - *native*：正常文件/shell/search 工具；一次只发一个 shell call 并等结果（"外层 worker 边界不可靠地支持单个 Codex turn 内并发进程"）；最后把完整候选留在磁盘 + 文本报告。
8. **Checkpoint/recovery**：保存 candidate snapshots + evaluation outputs + event logs ⇒ 中断可 resume；消融从相同 research state 续跑；**failed/discarded trial 恢复该 Worker 的 retained local candidate**。
9. **Token accounting**：按角色分别记 cached input / uncached input / output（支撑 budget 强制与成本分析）；外部 counter 全局累计、agent 不可见。
10. **超参**（B.1 + §4.1 + C.2）：`W=3`；每 Worker 每 epoch `3` local trials（一个 epoch ≈ 9 trials）；reasoning effort = high；保留各 agent 默认的 automatic compaction（但 compaction 只能发生在一个 invocation 内，因为不跨 session）；主实验 Advisor 与 Worker 同模型（Codex CLI v0.152.1 + GPT-5.5；Claude Code v2.1.258 + Opus 4.8），另有"强 Advisor + 便宜 Worker"实验（GPT-5.4 mini Worker 在 Git→Zig 上 $100 成本内 20.88 vs 19.68）。C.2：把 trials/epoch 改成 1 或 5，100M 续跑里 1 trial 跑 21–34 个 epoch、5 trials 只跑 6–8 个 epoch；3 trials 在 4 个设置里 3 个最优，5 trials 从未最优，结论"不敏感"。

---

## 7. 任务适配器与评估协议

**Adapter 形态**（B.1 只给了三句话："editable files, permitted resources, and evaluation procedure"）【未获取】没有代码级 API。可实现的字段集（按 Appendix E 的占位符反推，标注来源）：

```
TaskAdapter {
  task_name, domain,
  editable_files[],            # submission.py 或 candidate.bundle（唯一可写）
  read_only_files[],           # spec_files / test_files / 参考实现（可读不可改）
  materialize_rule,            # candidate.bundle → {candidate_workspace_path}
  evaluator { command, isolation: modal|local, timeout, resource_limits,
              protected: true,          # 对 Worker 隐藏且不可改
              correctness_cases: multiple fresh inputs,
              anti_cheat_checks[] },
  metric { name, direction, definition, aggregation }   # cycles↓ / frontier_reward↑ / SOL score↑ / SOL cost↓
  seed_candidate,              # kernel: 官方 147,734-cycle starter；FrontierSWE: 空 bundle
  baseline_value, public_dimensions, fixed_dimensions,
  reference_material, withheld_toolchain,   # 例：汇编靶子故意不给 C 编译器
  noise_characterization, reward_axes, partial_credit_policy,
  forbidden_shortcuts[]
}
```
依据：【E】的占位符 `{editable_file}` `{evaluator}` `{spec_files}` `{candidate_workspace_path}` `{build_command_or_artifact}` `{metric_definition}` `{baseline_metric_value}` `{noise_characterization}` `{task_specific_forbidden_shortcut}` 等；【B.1】；【§4.1】seed。

**评估协议要点**：
- **每次 evaluation 独立且隔离**：Worker 返回后由 harness 在 Worker 环境外跑（本地或 Modal），配置时限与资源上限；evaluator 代码 protected；用**多个 fresh 输入**检查正确性（"fresh unpredictable correctness cases"）。
- **Worker 不许自己跑 evaluator**：kernel 的 capability-limited 模式给 `evaluate_candidate` 但只能看 aggregate 结果；FrontierSWE/SOL worker 明确"You do not run the evaluator—SLA handles that"；偷看 harness = trial 作废 + 回滚。
- **分数回填**：score + status + diagnostics + report 写入 trial；更新 lane.local_best（胜出即保留）/ global_best（胜出即更新）/ 失败则回滚；更新 ledger（按 direction/mechanism 聚合，含 strong negative evidence）；token 计入 account。
- **计分方向必须由 adapter 显式声明**：kernel 是 minimize cycles；SOL 在 adapter 层可以报 SOL score（max）或 **SOL cost = (1−S̄)·1000（min）**——论文明确"sla reports it as SOL cost … and minimizes it; a candidate is kept only when it cuts SOL cost below the anchor"；FrontierSWE 是 maximize frontier_reward；FrontierCS 是 maximize score。**同一框架内"better()"的实现必须是 adapter 提供的偏序，而不是硬编码"分数越大越好"。**
- **baseline/上限信息**：SOL 把每个 shape 的 baseline 与 SOL floor 都给 Advisor（因为"S=0.5 at baseline, 1.0 at SOL"，策略必须知道 returns 是 capped 的）；kernel 给 capacity lower bounds。这类"任务侧物理上限/下界"是 advisory 证据的一部分，但**不得**变成 hardcode 答案。

---

## 8. 消融与证据强度；最小机制集三档

### 8.1 哪些结论强

1. **最终性能 + token 效率**（最强）：Anthropic kernel Codex（唯一 3 次重复的主实验）：SLA 1112.0±8.9 cycles，最强 baseline SwarmResearch 1275.7±133.9；**3/3 SLA runs 全胜 9/9 baseline runs**（最差 SLA 1122 vs 最好 baseline 1191）；达到 baseline 最终成绩只需 67.9M vs 986.3M tokens（−93.1%），Claude Code 下 −84.4%（138.5M vs 888.3M）。两个不同 agent 框架下复现同一方向，可信度较高。
2. **Advisor 协调成本极低**：0.24–0.51% tokens / 1.20–2.29% cost，且是直接按角色计费得到的（不是估算的间接指标）；对照 Shepherd 8.39–10.70% / 6.14–7.35%，**token 占比差 21–35 倍、成本占比差 3–5 倍**。这一条对"要不要做双层 agent 架构"的决策价值最高。
3. **三个消融方向一致性**：三个变体在 4 个 checkpoint 列上**全部**变差，方向一致（虽然幅度差异大）；libexpat 70M 列 −84.2% 最强。
4. **assignment 的定性机制**：D.3 的 trace 是可核对的（同父重复实现、代码仅差一个 label 名；SLA 里 Worker 2 从 Worker 1 的解继续改进 18.99→19.64，namespace tests 20→22）。这是机制存在的直接证据，但不是频率/贡献的量化证据（论文自认："do not measure how often these behaviors occur or how much they contribute"）。

### 8.2 哪些弱（必须在复刻时心里有数）

1. **n=1 主导**：FrontierSWE 4 题、SOL 3 题、FrontierCS 1 题、Claude Code 全部、以及"1B 去掉 Worker isolation"的全量 run，**都只有 1 次**。§4.1 自己承认"The other main-result configurations use one run per method"，单次 long run 成本数百到数千美元。
2. **25% vs 100% 反转本身就是弱证据的产物**：FrontierSWE 在 175M 时 SLA 全落后（libexpat 18.82 vs 19.67；Git 20.42 vs 24.32；Dart 15.43 vs 26.70；Lua 80.22 vs 82.97），700M 时全反超（31.33/28.84/45.27/96.15）。没有中间点，无法判断是"复利优势"还是"单次 run 的随机波动"——尤其 Dart 的 15.43→45.27 跨越极大。同理 W=7/15 在 25% 落后 337/174 cycles、100% 时全部落在 1107–1113 区间（Table 6）——这个"宽池追平"的结论也建立在 n=1 上。
3. **中央主张未被直接消融**：论文消融的是"每个 agent 看到什么"（reconstruction / isolation / assignment），**没有**消融"agent 是否跨 invocation 保留对话"。§5 Limitations 逐字承认："Our ablations change what each agent sees, not whether it keeps its conversation across invocations." ⇒ **"statelessness 本身带来收益"目前是论证而非实验证明**；可被证明的是"focused context + explicit assignment"。
4. **部分消融格在噪声内**：见 §5 表；kernel 200M 的 −17.4%、libexpat 240M 的 −14.8% 相对 std 接近噪声；"effects can compound" 主要靠 1B 那次 n=1 支撑。
5. **horizon 相关结论都是短窗口外推**：trials/epoch 敏感性、worker 宽度、无 isolation 的复利成本，全部基于 100M continuation（约 6–34 个 epoch），不是全量 run。
6. **任务族受限**：所有任务都有**可执行 evaluator**；模糊目标/慢评测/需要真实世界反馈的任务完全没测（§5 自认）。成本只匹配 tokens，**未计实验/评测本身的算力成本**。
7. **代码不可得** ⇒ 上述所有实现细节都无法用仓库核对，复刻时的偏差无法归因。

### 8.3 最小机制集：必做 / 可选 / 可省（给 DSH 复刻）

**必做（缺一项则不是 SLA，且大概率拿不到主要收益）**
1. Harness 持有 research state（candidate + measured outcome + parent + direction + lane）。
2. 每次 invocation 全新 session，**context 完全由 harness 逐块重建**（Advisor 一份、Worker 一份，角色不同）。
3. Advisor 看**跨 direction 聚合证据**（最近 attempts / 按方向分组 outcomes / lane 状态 / progress / diagnostics / ledger），且**区分 measured non-improvement 与 inconclusive failure**。
4. Advisor 输出**每 Worker 一条 explicit assignment**（REGIME + PROPOSAL，含机制面、期望节省量级、回归不变量/可证伪信号）；Worker 不做 experiment selection。
5. **每 Worker 独立 workspace + 只保留 lane-local best**；Worker 只收到 assignment + 保留候选 + 上一 trial 反馈，看不到其他 lane 与历史。
6. **evaluator 在 Worker 环境之外、protected、每次 fresh**；分数只由它产生；候选以磁盘产物为准。
7. cumulative token budget（外部计数、agent 不可见）+ **按角色 token accounting**（cached/uncached/output）。
8. checkpoint/resume：完整 state + candidate + eval 输出 + 事件日志；失败 trial 回滚到保留候选。

**可选（有则更接近论文，没有也能拿到一阶收益）**
- REGISTRY/maturity 规则（maturing / mature-WIN / pruned、mature-vs-mature 才允许判决、噪声底）。
- redirect 时 re-seed 到 global best 并清空 anchor（**建议保留**，它很便宜且是"新方向能活下来"的关键）。
- "至多一个 incremental lane、其余必须 mechanism-level" 的 portfolio 约束。
- hard isolation 级别：Landlock / 网络切断 / 清 saved session / 禁用 nested subagent（安全与公平性需要；对性能增益的贡献未单独测量）。
- 两种 runtime 形态（sealed-tools vs native）+ 输出截断 recovery turn。
- Worker 模型与 Advisor 解耦（强 Advisor + 便宜 Worker）、worker 宽度按任务调。
- 25%/100% 双预算点报告 + 共享 checkpoint 消融基建。

**可省（复刻时可先不做）**
- agent 自由文本 notes / claims / heartbeat 反思（那是 CORAL 的机制；SLA 用 harness 记录替代）。
- 多 island / migration 拓扑（CORAL 的东西）。
- "无 reconstruction" 消融里那个 32-call/320k-char 的只读记录接口（只是实验装置）。
- 同 REGIME 双 Worker 并行变体、`MANDATE` 指令、AVOID/TRY 指令（提升表达力，非最小机制）。
- 成本估算（$ 计价）与 cached/uncached 拆分（若只做 token 预算，可先只记累计 tokens；但要做 §4.4 类分析就需要拆分）。

---

## 9. 对 DSH 复刻的隐含要求清单（交给 Lead 的原子能力）

| # | Harness 原子能力 | 具体要求 | 为什么 SLA 需要 |
|---|---|---|---|
| C1 | **fresh invocation** | 每次调用可指定"全新 session / 无历史"，且能按角色注入完全自定义的 context（不是 system+history 的拼接，而是**块级组装**） | SLA 的定义性前提；Advisor/Worker 每 epoch/trial 都是新 session |
| C2 | **结构化结果回传** | invocation 结束返回机器可解析的结构：磁盘产物引用 + 自报 report（implemented/detail/rationale/deviation）+ 使用量 + 结束原因 | harness 要写 trial、回填 ledger、判定回滚 |
| C3 | **token 计数** | 每次 invocation 精确返回 cached input / uncached input / output；可按 role/epoch/run 累计 | budget 强制 + Advisor 成本占比是核心论据 |
| C4 | **预算中断** | 外部计数器达到上限时能**阻断下一次 invocation**（而不是等它跑完），且计数对 agent 不可见 | §4.1/B.2 的硬终止；agent 若能看到 budget 会改变行为 |
| C5 | **workspace 隔离** | 每 Worker 独立目录；只读文件挂载；可选 Landlock/无网络/清 session；禁止 nested delegation | B.1 的第 2–3 条；也用来看住 evaluator |
| C6 | **evaluator 外置** | 在 harness 进程/容器内跑评测，Worker 不可见 evaluator 代码与数据；超时/资源限额；可编程的 materialize 步骤（bundle → workspace） | 分数唯一可信来源；防止 metric gaming |
| C7 | **可编程 context 组装** | 能读取 state 并渲染成 prompt 块（摘要、表格、代码全文）；支持 per-role 模板与体积上限（至少能设"每块最大字符数"，因为 Advisor 要放 global best 代码全文） | §4 的全部内容 |
| C8 | **持久化 + checkpoint** | state 可序列化快照、可 resume、可从指定 checkpoint 续跑并保证行为一致 | 中断恢复 + 消融实验（论文在 10%/20% 切分） |
| C9 | **并发 + epoch barrier** | W 个 Worker 并行跑，等齐一个 epoch 再叫 Advisor；能"暂停某个 lane 一个 epoch" | 并行是 SLA 吞吐的一半；省略 workerN = 暂停的语义 |
| C10 | **产物即真相** | invocation 结束后读磁盘文件作为 candidate（不信任 agent 文本），失败可回滚到上一个 retained 产物 | "candidate can never be accepted on agent output alone" |
| C11 | **不可信数据帧定** | 候选代码/注释/Advisor proposal 在 prompt 里被明确标注为数据而非指令；可选地在 harness 层做完整性检查（禁止改 tests/evaluator/metric） | §4.1 A7 + §5 safety |
| C12 | 可选：工具中介 | 把 analyze/evaluate/submit 做成 sealed tool，带调用预算与聚合返回 | capability-limited runtime；也是防泄漏手段 |
| C13 | 可选：按角色路由模型 | Advisor 与 Worker 可用不同模型；shutdown/retry 语义 | C.1 的"强 Advisor + 便宜 Worker"实验；也是成本优化点 |

---

## 10. 关键 prompt 原文（Appendix E 已获取）

完整六段 prompt 逐字存于 [`research/paper-sla-raw.md`](research/paper-sla-raw.md)（Anthropic Kernel Advisor/Worker、FrontierSWE Advisor/Worker、SOL-ExecBench Advisor/Worker）。这里只摘最决定机制的四段。

**（1）Advisor 的输出契约（SOL-ExecBench，唯一给出逐字模板的一段）**：

```
## STATE
2–5 sentences: where the frontier is, which regimes are still descending,
which have flattened, what cross-regime verdicts are now valid
(mature-vs-mature only), and the highest-leverage next surfaces.
## REGISTRY
| regime | best_cost | n | status | workers |
|---|---:|---:|---|---|
| <tag> | <X.X> | <#> | <maturing|mature-WIN|pruned> | <workerN,...> |
## DIRECTIVES
- AVOID: <phrase> (rationale: <=15 words)
- TRY: <phrase> (rationale: <=15 words)
- MANDATE workerN: <strategic direction> | <rationale> (optional)
## PROPOSALS
### worker0
REGIME: <short-kebab-tag>
PROPOSAL: <one coherent implementation direction for this worker's next trials>
### worker1
REGIME: <short-kebab-tag>
PROPOSAL: <...>
```
> "Emit one ### workerN section for every active worker. A worker you omit is paused for the whole epoch—do that only on purpose." / "REGIME: must be a short kebab-case tag naming the approach family (the technique or optimization axis). Reuse a tag to continue a lane; use a new tag to pivot it, which re-seeds that lane from the global best kernel."

**（2）Advisor 的研究策略（kernel，逐字要点）**：
> "Start each epoch with a resource audit…" / "Across the complete worker roster, assign **at most one incremental lane**… Every other lane must attempt a coherent mechanism-level change that can remove work, alter dataflow/representation, or materially change the dependency schedule." / "Give every worker **exactly one coherent optimization regime and one concrete implementation direction**." / "A coherent hypothesis may require a substantial or complete rewrite… Do not equate 'one coherent change' with a small patch." / "An implementation/runtime/correctness error is inconclusive evidence… A sealed-valid non-improvement is negative performance evidence." / "Use the sanitized ledger to avoid repeating mechanisms with strong negative evidence. Reset means fresh reasoning from measured state, not amnesia." / "Do not edit files, call worker tools, run tests, or attempt evaluation."

**（3）Worker 的协议与收官（SOL-ExecBench，逐字）**：
> "You do not choose your own direction. Follow the assignment." / "SLA keeps your change if it beats your lane's own regime best, not the global best. You are never penalized for sitting behind the global frontier—only for failing to improve against your own prior best in this regime." / "keep/local → your submission.py stays as-is and your lane best updates." / "discard/error → your submission.py is reverted to your lane's best kernel." / "Your turn message names your regime, your lane best, and the global best." / "The same assignment is reused for several trials in a mini-epoch: each trial makes exactly one coherent edit, building on your lane's current best."

Worker 必须以此块收尾（进 results log 的 ≤80 字符 `Implemented`）：
```
## IMPLEMENTATION
Implemented: what you actually changed (≤80 chars, used in the results log).
Technical detail: the key mechanism.
Rationale: why this move within the assigned regime.
Deviation: none, or why the literal proposal wasn't possible.
```

**（4）反泄漏/反作弊边界（kernel worker，逐字）**：
> "The evaluator runs the extracted {optimized_artifact} in a no-network, resource-limited isolation boundary… A separate trusted process loads the frozen {evaluator}, checks several inputs, and computes the metric directly; **candidate output is never a score**." / "Never try to encode input-dependent information into timing, failures, instruction shape, or tool-call patterns; such behavior is cheating and candidates remain subject to fresh unpredictable correctness cases."

> 复刻注意：**不要把论文的 `{placeholder}` 当字面量**；kernel/FrontierSWE 的"epoch 任务模板"（谁提供 STATE/SEARCH POSTURE/REGISTRY/DIRECTIVES/PROPOSALS 的具体骨架）论文未给出全文【未获取】，SOL 那份是唯一可直接抄的输出骨架。

---

## 11. 来源与抓取备注

- 论文全文（HTML）：https://arxiv.org/html/2610.07625v1 （§1–§5 + Appendix A–E；本文引用的 §4.3 Table 4、§4.4 Table 5/6、C.2 Table 7、D.1–D.3、B.1、B.2、E 均在该页；PDF 不支持文本抓取，故以 HTML 为准）。
- 摘要页：https://arxiv.org/abs/2610.07625v1 （作者从略：Qizheng Zhang, Changxiu Ji, Isaac Sun, … , Kunle Olukotun；Stanford/CMU/UW/SambaNova/Berkeley；32 页；2026-10-06 提交）。
- 代码仓库：https://github.com/Alex-q-z/stateless-language-agents —— **抓取时无代码**（`git/trees/main` 仅 `assets/sla-preprint.pdf`；唯一 commit "Add SLA preprint"，2026-10-06T06:32:43Z；issue #1 为 HF 的发布邀请，含"代码将很快发布"的单方说法）。README/raw 均取不到。
- 镜像尝试：ar5iv、alphaxiv、huggingface papers、r.jina.ai 在本环境均无法直连（fetch failed / 跨域重定向），因此附录内容是通过对 arXiv HTML 全文做本地文本化获得的——这也解释了为什么没有"截断"：**§4.3、§4.4、§5、B.1、C.2、D、E 全部拿到**。
- 逐字摘录：`research/paper-sla-raw.md`（§3 正文、B.1、C.2、Appendix E 六段 prompt 全文，约 800 行）。
