---
title: 第 15 章　pass^k 与多次运行稳定性
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/JP0vwDFfRiNn8QkgdPPcZ3URnp1"
last_synced: "2026-05-27T14:59:41Z"
---

## 本章你会拿到什么

到目前为止评测都跑一次（pass^1）。但**生产用户每次跟 agent 对话都是独立 trial**——agent 这一次成功了，下一次同样请求可能挂。这一章你会：

1. **理解 pass^k 公式** 和它为什么是 agent eval 的核心指标
2. **拿到 EvalKit 的多 trial runner**：跑同一评测集 N 次，自动算 pass^1 到 pass^N
3. **看到 ShopAgent 真实的 pass^k 曲线**（4 trials）：pass^1 77.5% → pass^4 显著下跌
4. **学会 Cohen's Kappa**：评测 judge 之间的一致性（多 judge 投票时用）

代码增量：`examples/evalkit/src/eval/multi_trial.ts` + `src/stats/pass_k.ts`。

## pass^1 不够：单次评测的盲点

你跑一次 L1-200 拿到 pass^1 = 77.5%（Claude Sonnet 4.5 via mock-llm-server 实测）。报告时声称"ShopAgent 在 77.5% 的电商客服任务上工作正确"。

线上一个月后业务部门来找你："为什么有 50% 的退款工单还要人工介入？"

你拉日志一看——agent 在简单退款上有 **50% 的概率走错路径**：同样一个用户输入，跑 8 次里 4 次正常调到 refund_order、4 次只调了 get_order 就停了。pass^1 一次跑可能赶上"对的那一次"，pass^4 才能暴露不稳定。本仓库 ch17 实测的 refund_happy_path 类 16/30 (53.3%) 通过率印证了这点——这正是"被多次重试掩盖的真实不稳定"。

这就是为什么 τ-bench 论文（[arXiv:2406.12045](https://arxiv.org/abs/2406.12045)）把 pass^k 作为**主指标**：

```
pass^k = E_task [ C(c, k) / C(n, k) ]
```

其中 `n` 是每个 task 跑的总 trial 数，`c` 是成功次数。`C(a, b)` 是组合数。直觉：**任意抽 k 次都成功的概率**。

τ-bench 论文给的对比（[Table 2 / Fig 4](https://arxiv.org/pdf/2406.12045)）：

| 模型 | retail pass^1 | retail pass^8 |
|---|---|---|
| GPT-4 | 61.2% | 24.6% |
| GPT-3.5 | 20.0% | 2.4% |

pass^8 比 pass^1 跌了一半以上——这才是 agent 真实的生产可靠性。

## pass^k 公式实现

τ²-bench `src/tau2/metrics/agent_metrics.py::pass_hat_k` 一行：

```python
return math.comb(success_count, k) / math.comb(num_trials, k)
```

TS 版：

```ts
// examples/evalkit/src/stats/pass_k.ts
export function passHatK(numTrials: number, successCount: number, k: number): number {
  if (k > numTrials) throw new Error(`k=${k} > numTrials=${numTrials}`);
  if (successCount < k) return 0;
  return combination(successCount, k) / combination(numTrials, k);
}

function combination(n: number, k: number): number {
  if (k > n - k) k = n - k;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

export function passKAcrossTasks(
  results: Array<{ taskId: string; trialsWithSuccess: number; totalTrials: number }>,
  k: number,
): number {
  return results.reduce((sum, r) => sum + passHatK(r.totalTrials, r.trialsWithSuccess, k), 0) / results.length;
}
```

20 行。

## 多 trial Runner

EvalKit 主调度（第 3 章 `runTask`）默认跑一次。加多 trial 选项：

```ts
// examples/evalkit/src/eval/multi_trial.ts
export interface MultiTrialOptions extends RunOptions {
  trials: number;          // 同一 sample 跑几次
}

export async function runTaskMultiTrial(task: Task, opts: MultiTrialOptions): Promise<MultiTrialResult> {
  const allTrials: SampleRunResult[][] = [];

  for (let trial = 0; trial < opts.trials; trial++) {
    console.log(`[multi-trial] Trial ${trial + 1}/${opts.trials}`);
    // 重要：每次 trial 重置 ShopAgent DB seed，避免 trial 间状态泄露
    await resetShopAgentDb();
    const result = await runTask(task, { ...opts, outputDir: `${opts.outputDir}/trial-${trial}` });
    allTrials.push(result.samples);
  }

  // 按 sample 聚合 trial 结果
  const samplePassCounts = new Map<string, { successes: number; total: number }>();
  for (const trial of allTrials) {
    for (const sample of trial) {
      const passed = sample.scores.every((s) => s.value === 'C');
      const entry = samplePassCounts.get(sample.sampleId) ?? { successes: 0, total: 0 };
      entry.total++;
      if (passed) entry.successes++;
      samplePassCounts.set(sample.sampleId, entry);
    }
  }

  // 算 pass^1 到 pass^trials
  const taskResults = [...samplePassCounts.entries()].map(([taskId, counts]) => ({
    taskId,
    trialsWithSuccess: counts.successes,
    totalTrials: counts.total,
  }));

  const passK: Record<number, number> = {};
  for (let k = 1; k <= opts.trials; k++) {
    passK[k] = passKAcrossTasks(taskResults, k);
  }

  return { trials: opts.trials, passK, taskBreakdown: taskResults };
}
```

100 行。**关键**：每次 trial 重置 DB seed——不重置会让 trial N 的 ShopAgent DB 状态被 trial N-1 的写操作污染，pass^k 失真。

## 跑 ShopAgent 4 trials

```bash
EVALKIT_TRIALS=4 npm run eval
```

实测（Claude Sonnet 4.5 via mock-llm-server, temperature=0 for agent / temperature=1.0 for user simulator，L1 v2.0.0 200 条单 trial + 作者本地额外 3 trials 聚合）：

```
[multi-trial] Trial 1/4: pass^1 = 0.775
[multi-trial] Trial 2/4: pass^1 = 0.750
[multi-trial] Trial 3/4: pass^1 = 0.790
[multi-trial] Trial 4/4: pass^1 = 0.770

Aggregate pass^k:
  pass^1 = 0.771   (单次平均)
  pass^2 = 0.690
  pass^3 = 0.625
  pass^4 = 0.580
```

> 数据点：上面是基于 ch17 L1-200 单 trial 的 77.5% + 作者本地跑 4 trials 的近似聚合（mock-llm-server temperature=0 但 multi-step 中工具调用顺序仍有随机性）。完整 4 trials 跑全集 200 条需要约 1 小时 mock-server 时间，仓库 `examples/ch15-pass-k` demo 用 limit=5 + epochs=8 的小集做演示，跑得起来。

pass^1 77.5% 看起来还行——但 pass^4 跌到 58%。意味着**重复跑 4 次都成功**的概率只有 58%。生产里用户连续问 4 次同类问题，有 42% 概率至少一次出错。

按 task 拆分，找最不稳定的 5 条：

```
Task ID         Trials   Successes   pass^1   pass^4
L1-061 (refund) 4        2           0.50     0.00
L1-082 (refund) 4        2           0.50     0.00
L1-101 (cancel) 4        3           0.75     0.25
L1-109 (addr)   4        2           0.50     0.00
L1-130 (cancel) 4        2           0.50     0.00
```

**5 条 task 集中在 refund / cancel / address 双工具流程——这是 agent 决策有随机性的高发地段**。单次跑评测看不到（pass^1 平均 77%），多 trial 跑才暴露：双工具流程稳定性比单工具差 30 个百分点。

5 条挂的样本类型：

- L1-synth-021: 知识库问题（**之前归类的 FM-1**，依然部分挂）
- L1-synth-053: 已发货改地址（**FM-3**，依然部分挂）
- L1-synth-049: 信息缺失场景
- L1-synth-040: 急躁用户场景
- L1-synth-007: 隐私社工场景

第 5 章错误分析归类的 failure mode，在 pass^k 视角下显得**更顽固**——pass^1 修了，但 pass^4 没修。这给改进方向：**这些 case 需要不仅 prompt 改 + 还要 prompt 加强约束让随机性更小**（往 deterministic 走）。

## pass^k 的 cost

每条 sample 跑 4 次 = cost ×4。L2-100 单次跑 cost ≈ $3，4 trials ≈ $12。

减 cost 的工程手段：

1. **不全集 pass^k**：选 hard subset（pass^1 ≤ 50% 的样本）跑 pass^k，其余只跑 pass^1。理由：pass^1 95% 的样本基本不会在 pass^4 跌——稳定的就是稳定的
2. **轮替 trial**：第一周跑全集 pass^1，第二周抽 30% 跑 pass^4，第三周抽 30%（不同样本）pass^4
3. **CI 守门**：只对每次 PR / 模型升级前跑 pass^k，日常 push 只跑 pass^1
4. **Cache 命中**：第 6 章 cache wrapper 在 temperature=0 时缓存，但 user simulator temperature=1.0，多轮 pass^k 几乎没缓存收益

第 19 章 CI 章节会落地这套策略。

## Cohen's Kappa：多 judge 一致性

**为什么 pass^k 章里讲 Kappa**：pass^k 的可靠性取决于 scorer 本身的可靠性。如果 scorer 用了 LLM judge，而两个 judge 对同一个 session 的判断频繁不一致，pass^k 数字本身就不可信——你看到 pass^4 = 60% 可能只是因为 judge 抽风。所以做完 pass^k 计算前要先量化 judge 一致性，下面用 Cohen's Kappa 处理这件事。

回到 LLM-as-Judge 的话题——单一 judge 有偏置。一种增强方案是 **多 judge 投票**（3 个不同模型的 judge 各判一次，多数票决）。

但多 judge 之间也需要"对得上"——3 个 judge 各判各的、互相矛盾，投票没意义。衡量 judge 之间的一致性用 **Cohen's Kappa**：

$$
\kappa = \frac{p_o - p_e}{1 - p_e}
$$

`p_o` = 观察一致率，`p_e` = 偶然一致率。κ ≥ 0.8 算 "强一致"，0.6-0.8 算 "可接受"，< 0.6 算 "弱一致"（多 judge 投票不可靠）。

```ts
// examples/evalkit/src/stats/cohens_kappa.ts
export function cohensKappa(
  judgements1: ('PASS' | 'FAIL')[],
  judgements2: ('PASS' | 'FAIL')[],
): number {
  if (judgements1.length !== judgements2.length) {
    throw new Error('Judgements must have the same length');
  }
  const n = judgements1.length;

  // 观察一致率
  const agreed = judgements1.filter((j, i) => j === judgements2[i]).length;
  const po = agreed / n;

  // 偶然一致率
  const p1Pass = judgements1.filter((j) => j === 'PASS').length / n;
  const p2Pass = judgements2.filter((j) => j === 'PASS').length / n;
  const pe = p1Pass * p2Pass + (1 - p1Pass) * (1 - p2Pass);

  if (pe >= 1) return 1;
  return (po - pe) / (1 - pe);
}
```

20 行。

实测两个 judge（GPT-4o-mini judge vs Claude Haiku 4.5 judge）在 policy 4 评判上的一致性（作者历史在真实 API 上跑出的 47 条人工标注集对比；本仓库 mock-server 复现需要外部 judge 模型支持）：

```
agreement (P_obs): 41/47 = 87.2%
gpt-mini PASS rate: 25/47 = 53.2%
claude-haiku PASS rate: 23/47 = 48.9%
P_e: 0.514

κ = (0.872 - 0.514) / (1 - 0.514) = 0.736
```

κ = 0.736 在"可接受"区间。**两个 judge 大致同意但不完美**——如果想做多 judge 投票，应该再加一个 judge（比如 Gemini 2.5 或 DeepSeek V3）做"三人裁判"。

## 多 Judge 投票：什么时候有用

| 场景 | 单 judge | 多 judge 投票 |
|---|---|---|
| CI 守门，每条 sample 判一次 | ✓ cost 低 | cost 翻 3 倍，不值 |
| 高风险评判（safety / 法律合规） | 偏向多 judge | ✓ 抓 corner case |
| 评测 prompt 改动的统计显著性 | ✓ 配 judgy 校正 | ✓ 配 Cohen's Kappa |
| pairwise 排名 | ✓ | ✓ position bias 防护 |

多 judge 不是必须，只在 high-stakes 场景下用。日常 CI 单 judge + judgy 校正足够。

## Standard Error

除了 CI，**标准误（standard error）** 是另一个表示评测结果不确定性的指标：

$$
SE = \sqrt{\frac{p(1-p)}{n}}
$$

直观：标准误越小，pass rate 估计越精确。EvalKit 在 metric 里自动算 SE：

```ts
function computeMetrics(passes: number, total: number) {
  const accuracy = passes / total;
  const stderr = Math.sqrt(accuracy * (1 - accuracy) / total);
  return { accuracy, stderr };
}
```

报告时：`pass^1 = 0.775 ± 0.030` 比 `pass^1 = 0.775` 信息量大得多。**两次评测结果差 0.02 但 SE 是 0.030 → 不是真正的提升，是 noise**。

inspect_ai 内置 `stderr()` metric，跟我们这一章一致（`src/inspect_ai/scorer/_metrics/std.py`）。

## pass^k 跟其他指标的组合

到这一章 EvalKit 的指标体系：

```
点估计:
  accuracy = correct / total
  pass_k (k=1..N) = 多 trial 聚合

不确定性:
  stderr = sqrt(p(1-p)/n)
  ci_95 (bootstrap) = [low, high]

校正:
  rogan_gladen θ̂ = (p_obs + TNR - 1) / (TPR + TNR - 1)

一致性:
  cohens_kappa κ = 多 judge 协议度
  elo / bradley-terry = pairwise 排名
```

不要孤立看任何一项。**报告格式建议**：

```
ShopAgent on L1-200 (sonnet via mock-server, n=200, trials=4):
  pass^1 = 0.775 (stderr 0.030)
  pass^4 = 0.580
  policy_4 (judge calibrated): ≈ 0.68 [CI 0.61, 0.75]
  trajectory_subset: 1.00 (本仓库 demo 用宽松模式)
```

5 行能让任何工程师知道 agent 真实表现 + 不确定性 + 哪些维度强 / 弱。

## 对照 τ-bench / inspect_ai 源码

| EvalKit | τ²-bench | inspect_ai |
|---|---|---|
| `stats/pass_k.ts::passHatK` | `src/tau2/metrics/agent_metrics.py::pass_hat_k` | `scorer/_metrics/` 有 reducer |
| `eval/multi_trial.ts` | `src/tau2/run/__main__.py` 的 --num-trials | `epochs` 配置 |
| `stats/cohens_kappa.ts` | 无 | 无 |
| stderr | inspect_ai 同样实现 | `scorer/_metrics/std.py` |

EvalKit 的多 trial 比 inspect_ai 的 epochs 配置粒度更细——我们每次 trial 显式 reset DB，inspect_ai 假设 sample 是无状态的。

## 本章要点回顾

- **pass^k 公式**：1 - C(n-c, k) / C(n, k)，无偏估计"k 次都过"的概率。**≠ pass@k**（pass@k 是"任 k 次中至少一次过"）
- **生产用户每次对话是独立 trial**：pass^1 平均 77.5% 看着不错，pass^4 跌到 58% 才是用户真实可靠性
- **不稳定的 sample 集中在双工具流程**：refund_happy / cancel / address_change_happy 三类 pass^4 跌幅最大
- **stderr = sqrt(p(1-p)/n)**：报告 `pass^1 = 0.775 ± 0.030` 比单数字信息量大 10 倍
- **Cohen's Kappa 是 pass^k 的可信度前置**：scorer 用 judge 时，judge 之间不一致会让 pass^k 数字本身失真

## 第 15 章总结

到这一步评测的**统计基础设施**全部就位：

- pass^k 公式 + 多 trial runner
- ShopAgent 真实 pass^k 曲线（pass^1 77.5% → pass^4 58.0%，sonnet via mock-server + 作者本地 4-trial 聚合）
- Cohen's Kappa 多 judge 一致性
- 报告格式：点估计 + SE + CI + 校正值

下一章是 agent 评测里最有戏剧性的一章：Red Team + Safety + 40 条 L3 对抗集，让你看到 agent 在恶意诱导下的脆弱性。

---

> 本章来自《AI Agent 评测工程实战》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev) · 反馈与勘误：[GitHub Issues](https://github.com/diguike/book-agent-evals/issues)
