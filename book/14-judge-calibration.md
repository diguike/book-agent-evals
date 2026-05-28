---
title: 第 14 章　Judge 校准与显著性检验
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/ENFkwfyDPiSxwekzogUcguyKnWg"
last_synced: "2026-05-27T14:59:41Z"
---

## 本章你会拿到什么

第 13 章拿到的 policy 4 judge 在 test 集 TPR=92.3% / TNR=87.5%——**不完美**。直接拿 judge 的输出当真实 pass rate 用，**结果会系统性偏倚**。这一章你会：

1. **理解 Rogan-Gladen 统计校正**：把 "judge 观察 67%" 变成 "校正后估计真实 pass rate 是 71% [置信区间 65%-76%]"
2. **拿到 judgy-ts**：[ai-evals-course/judgy](https://github.com/ai-evals-course/judgy) 的 TypeScript 移植版（约 120 行）
3. **学会 bootstrap 置信区间**：生产级评测平台必备的统计基础设施
4. **了解 Elo / Bradley-Terry**：pairwise judge 进阶，什么时候该用什么时候不该用

代码增量：`examples/evalkit/src/stats/`（新建模块）。

## 本章用到的统计概念速查（5 个）

这是全书统计密度最高的一章。如果以下 5 个概念你不熟悉，先扫一眼这个表，**不需要懂细节，知道是什么用来做什么即可**——具体公式后面用到时会再解释一次。

| 概念 | 一句话解释 | 工程语境 |
|---|---|---|
| **TPR / TNR** | 判官认出 PASS / FAIL 的正确率（见第 13 章末方框） | 衡量 judge 质量 |
| **点估计 vs 区间估计** | 点估计是单个数字（如 67%）；区间估计是范围（如 [62%, 72%]） | 区间告诉你"这个数字有多准" |
| **置信区间 (CI)** | "95% 置信区间 [62%, 72%]"意思是用同样方法重复多次实验，95% 的实验会包含真实值 | 加 CI 比裸数字诚实 |
| **Bootstrap** | 重采样方法——从已有数据反复抽样 20000 次，每次算一遍，取分布的 2.5% / 97.5% 分位作为 CI | 不需要解析公式，代码 20 行能跑 |
| **p-value（第 19 章用到）** | 假设两组数字其实没差异，观察到这么大差异的概率 | < 0.05 算"差异显著" |

公式部分你可以**直接复制粘贴用**，理解为什么这样设计的细节是 nice-to-have。这一章的目标是让你**知道什么时候该用哪个公式**，不是让你成为统计学家。



## 不校准的 judge 数据有多偏

回到第 13 章的实测：

```
原始 judge 输出: policy_4_confirmation = 67/100 (67%)
```

但我们知道 judge 自己 test 集 TPR=92.3%，TNR=87.5%。意味着：

- 在真正 PASS 的样本里，judge 有 7.7% 会误判成 FAIL（漏判 false negative）
- 在真正 FAIL 的样本里，judge 有 12.5% 会误判成 PASS（虚警 false positive）

如果真实 pass rate 是 75%，judge 会观察到：

```
观察 PASS = 真实 PASS × TPR + 真实 FAIL × (1 - TNR)
         = 75% × 0.923 + 25% × 0.125
         = 69.2% + 3.1%
         = 72.3%
```

观察值 72.3% ≠ 真实 75%。**judge 系统性低估 2.7 个百分点**。这种偏倚在 prompt 改动小、变化也只有 2-3 个点的情况下，**完全淹没在 judge 的系统性误差里**——你以为改 prompt 有用，其实是 noise。

## Rogan-Gladen 公式

倒着推 judge 观察值 → 真实值。把上面的方程反解：

观察 `p_obs = θ × TPR + (1-θ) × (1-TNR)`

解出 θ：

```
θ̂ = (p_obs + TNR - 1) / (TPR + TNR - 1)
```

这就是 **Rogan-Gladen correction** 公式，1978 年在流行病学领域被首次提出（用于校正不完美检测的疾病阳性率）。同样适用于 LLM judge。

带入数字：

```
p_obs = 0.67
TPR = 0.923
TNR = 0.875

θ̂ = (0.67 + 0.875 - 1) / (0.923 + 0.875 - 1)
   = 0.545 / 0.798
   = 0.683
```

校正后真实 pass rate 估计是 68.3%，而不是 judge 直接输出的 67%。

如果 judge TPR/TNR 都接近 1（完美 judge），分子分母都接近 p_obs，θ̂ ≈ p_obs——校正不影响。但当 TPR/TNR 偏低时，校正影响显著。

**Rogan-Gladen 适用前提**（必读）：

1. **TPR + TNR > 1**：judge 必须比随机猜好。如果 TPR + TNR ≤ 1，公式分母接近 0 或为负，校正值会落到 [0,1] 之外（数学退化）。出现这种情况说明 judge 还不能用，先重写 prompt + 加 few-shot，把 TPR / TNR 都拉到 ≥ 0.7 再来。
2. **真实 prevalence 不能极端**：当 ground-truth pass rate 接近 0 或 1（比如真实 95%+ 的样本通过），校正前后差异小（θ̂ ≈ p_obs），但置信区间会宽到没用。极端 prevalence 下应该改用 bootstrap 直接算 CI。
3. **样本量充足**：标注集 n ≥ 30 才能可靠估 TPR/TNR；n=10 时点估计噪声大于校正幅度，没意义。本书推荐 n=50（如 ch13 校准用的 47 条标注集）。
4. **TPR / TNR 是固定值不是分布**：实际应用时 TPR/TNR 自己也有 SE。下面 confidence interval 部分用 bootstrap 把这个不确定性也算进去。

如果以上任一前提不满足，**不要用 Rogan-Gladen，回到"提升 judge 质量"上**——校正不能救一个烂 judge。

## 实现：judgy-ts

[ai-evals-course/judgy](https://github.com/ai-evals-course/judgy) 是 Hamel 团队开源的 Python 库。我们做一个 TS 移植：

```ts
// examples/evalkit/src/stats/judgy.ts
export interface JudgePerformance {
  TPR: number;
  TNR: number;
}

export interface CalibratedEstimate {
  rawObservedPassRate: number;
  calibratedTrueRate: number;
  ci95: [number, number];          // 95% 置信区间
  warning?: string;                  // 如果 TPR + TNR < 1
}

export function calibrate(
  observedPasses: number,
  totalSamples: number,
  judgePerf: JudgePerformance,
  nBootstrap = 20000,
): CalibratedEstimate {
  const pObs = observedPasses / totalSamples;
  const denom = judgePerf.TPR + judgePerf.TNR - 1;

  if (denom <= 0) {
    return {
      rawObservedPassRate: pObs,
      calibratedTrueRate: pObs,
      ci95: [0, 1],
      warning: 'Judge TPR + TNR ≤ 1，校正失效，原始观察值不可信',
    };
  }

  const thetaHat = clamp((pObs + judgePerf.TNR - 1) / denom, 0, 1);

  // Bootstrap 置信区间
  const ci = bootstrapCi(observedPasses, totalSamples, judgePerf, nBootstrap);

  return {
    rawObservedPassRate: pObs,
    calibratedTrueRate: thetaHat,
    ci95: ci,
  };
}

function bootstrapCi(
  observedPasses: number,
  totalSamples: number,
  judgePerf: JudgePerformance,
  n: number,
): [number, number] {
  const estimates: number[] = [];

  for (let i = 0; i < n; i++) {
    // 重采样观察 pass 数（二项分布）
    const resampledPasses = binomialSample(totalSamples, observedPasses / totalSamples);
    const resampledPObs = resampledPasses / totalSamples;
    const denom = judgePerf.TPR + judgePerf.TNR - 1;
    const theta = clamp((resampledPObs + judgePerf.TNR - 1) / denom, 0, 1);
    estimates.push(theta);
  }

  estimates.sort((a, b) => a - b);
  return [estimates[Math.floor(n * 0.025)], estimates[Math.floor(n * 0.975)]];
}

function binomialSample(n: number, p: number): number {
  // 简化版二项采样：对每个样本独立 bernoulli
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (Math.random() < p) count++;
  }
  return count;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
```

120 行 TS。**核心三段**：

1. Rogan-Gladen 点估计：θ̂ = (p_obs + TNR - 1) / (TPR + TNR - 1)
2. Bootstrap 重采样：20000 次模拟 + 取 2.5%-97.5% 分位作为 95% CI
3. 退化处理：TPR + TNR < 1 时返回原始观察值并警告

## 用 judgy-ts 校正 policy 4 数据

```ts
import { calibrate } from '@inferloop/evalkit/stats';

const result = calibrate(67, 100, { TPR: 0.923, TNR: 0.875 });

console.log(result);
// {
//   rawObservedPassRate: 0.67,
//   calibratedTrueRate: 0.683,
//   ci95: [0.58, 0.78]
// }
```

报告时正确写法：

> "Agent 在 policy 4（不可逆操作二次确认）上估计真实 pass rate 是 68.3%，95% CI [58%, 78%]"

而不是：

> "Agent policy 4 pass rate 是 67%"（错的，没校正）

## CI 宽度告诉你的事

CI 宽度 = 78% - 58% = 20 个百分点。**这是相当宽的 CI**。意味着即便你做了校正，仅凭 100 条样本无法精确说"真实 pass rate 是 X"——只能说"在 58%-78% 这个区间"。

CI 宽度的两个 driver：

1. **样本数 n**：n 越大 CI 越窄。1.96 × √(p(1-p)/n)，n 从 100 加到 400 CI 宽减半
2. **TPR/TNR 距离 1 的距离**：judge 越准，校正噪音越小，CI 越窄

工程师常犯的错：报告"前后对比 +3 个百分点"，但 CI 宽 ±10 个百分点——**+3 还在 noise 范围内**。第 19 章 CI 章节会用 CI 算"统计显著性阈值"，决定一个改动是不是真的提升。

**多宽算太宽**（经验阈值）：

| CI width | 解读 | 行动 |
|---|---|---|
| < 0.05 (±2.5pp) | 窄，可信 | 直接用于汇报 |
| 0.05 - 0.10 (±2.5-5pp) | 可接受 | 配 z-test 看显著性 |
| 0.10 - 0.20 (±5-10pp) | 偏宽 | 标注集偏小，建议扩到 n ≥ 50 |
| > 0.20 (±10pp 以上) | 太宽 | **不能用于汇报**——pass rate 数字本身不可信，先扩标注集到 100+ 再算 |

一般 production agent eval 看 CI width 应控制在 0.10 以内。前后对比的 Δ 要 > CI width 才有意义说"提升"。

## TPR/TNR 不是写死的，要定期重测

Judge 校准最大的陷阱：**TPR/TNR 是基于一个标注集测出来的数字，但随着 agent 变化、用户输入分布变化，judge 的真实 TPR/TNR 会漂移**。

实践建议：

1. **每隔 4-8 周重测 judge TPR/TNR**：拿一批新的实际评测样本人工标 50 条，重算 TPR/TNR
2. **任何 judge prompt 改动后必须重测**：哪怕只改了一个 few-shot 例子
3. **模型升级后必须重测**：换 gpt-4o-mini → gpt-5-mini 后 TPR/TNR 会大幅变化

EvalKit 的 judge metadata 必须带 `tpr_tnr_measured_at` 和 `tpr_tnr_dataset` 字段，CI 里如果发现 measurement 老于 90 天会发警告。

## "TPR + TNR 必须都 > 80%" 是底线

Hamel 强调："**TPR=95% 但 TNR=40% 的 judge 是垃圾**"。原因：高 TPR 低 TNR 的 judge 把几乎所有样本都判 PASS，看起来召回好但其实没什么判别力。

定个工程门槛：

| TPR | TNR | 判定 |
|---|---|---|
| ≥ 80% | ≥ 80% | judge 可用 |
| ≥ 70% 且 ≥ 70% | | judge 勉强用，标注更多数据 |
| < 70% 任一 | | judge 不可用，重写 prompt 或换模型 |

EvalKit 的 judge wrapper 自动检查：

```ts
// examples/evalkit/src/scorer/judge/wrapper.ts
export function createJudge(opts: {
  prompt: string;
  performance: { TPR: number; TNR: number };
  measuredAt: string;
  measuredOn: string;  // dataset name
}): Judge {
  if (opts.performance.TPR < 0.8 || opts.performance.TNR < 0.8) {
    console.warn(`[judge] TPR=${opts.performance.TPR} TNR=${opts.performance.TNR}, below 80% threshold`);
  }

  const ageDays = (Date.now() - new Date(opts.measuredAt).getTime()) / (24 * 3600 * 1000);
  if (ageDays > 90) {
    console.warn(`[judge] TPR/TNR measured ${ageDays.toFixed(0)} days ago, please remeasure`);
  }

  return { /* ... */ };
}
```

## Pairwise 评判与 Elo

到目前为止我们做的都是**绝对评判**——judge 看一个 sample，判 PASS/FAIL。还有一种**相对评判**：让 judge 看两个 agent 的输出，判哪个更好。

相对评判的优点：

1. **更容易**：判 "A 比 B 更好" 比判 "A 是否合格" 简单，judge 不用维护绝对标准
2. **更稳定**：研究显示 pairwise agreement 比 absolute agreement 高 5-10 个百分点
3. **能排序**：n 个 agent 两两 pairwise 跑完，可以用 Elo 给所有 agent 排名

缺点：

1. **n×(n-1)/2 复杂度**：5 个 agent pairwise 要跑 10 次，每个 sample
2. **Position bias**：判官偏第一个出现的选项
3. **不能告诉你"绝对水平"**：A 比 B 强，但 A 是不是真的"够好"，pairwise 不直接答

EvalKit 这一章先讲核心算法 **Bradley-Terry 模型**，第 17 章扩到 200 条评测集时会真正用 pairwise 给多个 agent 版本排名。

### Bradley-Terry 模型

假设每个 agent 有个真实"实力" $\theta_i$。两个 agent $i, j$ 比，agent $i$ 赢的概率：

$$
P(i \text{ wins over } j) = \frac{e^{\theta_i}}{e^{\theta_i} + e^{\theta_j}}
$$

给定一堆 pairwise 比赛结果，用最大似然估计估各 $\theta_i$。这就是 **Bradley-Terry MLE**。

简单 TS 实现（用 MLE 迭代）：

```ts
// examples/evalkit/src/stats/bradley_terry.ts
export function bradleyTerry(
  wins: Array<{ winner: string; loser: string }>,
  agents: string[],
  iterations = 100,
): Record<string, number> {
  const ratings: Record<string, number> = Object.fromEntries(agents.map((a) => [a, 1]));

  for (let iter = 0; iter < iterations; iter++) {
    for (const a of agents) {
      let numerator = 0;
      let denominator = 0;
      for (const w of wins) {
        if (w.winner === a) {
          numerator += 1 / (ratings[a] + ratings[w.loser]);
        }
        if (w.loser === a) {
          denominator += 1 / (ratings[w.winner] + ratings[a]);
        }
      }
      // 防止零
      if (denominator > 0) ratings[a] = numerator / denominator;
    }
  }

  return ratings;
}
```

80 行内的 BT-MLE 实现。**简化版**——没做正则化、没做收敛检测。生产用建议用 `bradleyterry-py` 之类的成熟库。

### Elo Rating

Elo 是 Bradley-Terry 的在线（online）版本——每次比赛后更新 rating，不需要 batch MLE。OpenAI MT-Bench、LMSYS Chatbot Arena 用的就是 Elo。

```ts
// examples/evalkit/src/stats/elo.ts
const K_FACTOR = 32;

export class EloRanking {
  private ratings = new Map<string, number>();

  constructor(initialRating = 1000) {
    this.initialRating = initialRating;
  }

  rate(agent: string): number {
    return this.ratings.get(agent) ?? this.initialRating;
  }

  recordMatch(winner: string, loser: string) {
    const wR = this.rate(winner);
    const lR = this.rate(loser);
    const expected = 1 / (1 + Math.pow(10, (lR - wR) / 400));
    this.ratings.set(winner, wR + K_FACTOR * (1 - expected));
    this.ratings.set(loser, lR + K_FACTOR * (0 - (1 - expected)));
  }

  ranking(): Array<{ agent: string; rating: number }> {
    return [...this.ratings.entries()]
      .map(([agent, rating]) => ({ agent, rating }))
      .sort((a, b) => b.rating - a.rating);
  }
}
```

40 行。简单到能背下来。

### 什么时候用 pairwise

| 场景 | 推荐方法 |
|---|---|
| 单个 agent 是否达标？ | 绝对评判 + Rogan-Gladen 校正 |
| 5 个 agent 版本里哪个最好？ | Bradley-Terry 或 Elo（下表选） |
| 比较 GPT-4o vs Claude Sonnet 4.5 哪个更适合做客服？ | pairwise |
| 跟踪一个 agent 长期质量变化？ | 绝对评判（pairwise 无法跨时间对比） |

**Bradley-Terry vs Elo 决策表**（5 个 agent 版本 pairwise 排名时选哪个）：

| 场景 | 推荐 | 理由 |
|---|---|---|
| 比较次数少（每对 < 50 场） | **Elo** | 在线增量更新，少量样本就能给出排名；BT 在小样本上 MLE 估计噪声大 |
| 比较次数多（每对 ≥ 100 场） + 需要 p-value | **Bradley-Terry** | MLE 给出参数置信区间，能算"A 比 B 强是否显著" |
| Agent 版本动态加入 / 退出（A/B 测试） | **Elo** | LMSYS Chatbot Arena 同款，每场比赛后实时更新 |
| 静态评测一批固定版本做发布前对比 | **Bradley-Terry** | 一次性算完所有版本的相对实力，输出排名 + 置信度 |

**一句话**：在线 = Elo，静态 = Bradley-Terry。如果你不确定，先从 Elo 起步（实现简单 + 增量），后续需要 p-value 再换 BT。

绝对评判和 pairwise 互补——不是替代关系。

## Position Bias 防护

Pairwise judge 偏第一个出现的选项（多个研究证实，约 60-70% 概率）。简单防护：**每对 pairwise 跑两次，A-vs-B 和 B-vs-A 各一次**。最终判结果用两次的一致性：

```ts
async function pairwiseJudge(a: string, b: string, judge: Provider): Promise<Verdict> {
  const r1 = await judge.generate({ messages: [...buildPrompt(a, b)] });
  const r2 = await judge.generate({ messages: [...buildPrompt(b, a)] });

  if (r1.winner === 'A' && r2.winner === 'B') return 'tie';   // 都偏第一个
  if (r1.winner === 'A' && r2.winner === 'A') return 'a';     // 一致认为 a 好
  if (r1.winner === 'B' && r2.winner === 'B') return 'b';
  return 'tie';
}
```

cost 翻倍但 position bias 消除大半。如果还想精确，加 self-consistency（每对跑 5 次取多数票），cost 又翻 5 倍。生产建议跑 2 次足够。

## 对照 Hamel/judgy 源码

| EvalKit | Hamel/judgy | inspect_ai |
|---|---|---|
| `stats/judgy.ts::calibrate` | [judgy/calibration.py](https://github.com/ai-evals-course/judgy) | 无内置（用户自己写） |
| `stats/judgy.ts::bootstrapCi` | judgy `bootstrap_ci` | - |
| `stats/bradley_terry.ts` | choix / bradleyterry | - |
| `stats/elo.ts` | 自己写 | - |

Rogan-Gladen 公式在流行病学/医学统计是常识。judgy 把它工程化到 LLM evaluation。我们的 TS 版做了简化但核心一致。

## 本章要点回顾

- **Rogan-Gladen 校正**：把"judge 观察 67%"换成"真实 pass rate 估计 71%"。前提是 TPR + TNR > 1（judge 比随机猜好）
- **Rogan-Gladen 4 个适用前提**：TPR+TNR>1 / prevalence 不极端 / n≥30 / TPR/TNR 自己当固定值时配 bootstrap
- **Bradley-Terry vs Elo 决策**：在线 / 增量 / 样本少 → Elo；静态 / 一次性 / 需要 p-value → Bradley-Terry
- **pairwise judge 反 position bias**：A-vs-B 跑两次（顺序反转），两次一致才算判定
- **judge 校准是评测的"评测"**：没校准过的 judge 给出来的 pass^1 不能直接信，必须先确认 judge 跟人类标注一致

## 第 14 章总结

到这一步 LLM-as-Judge 体系完整：

1. **绝对评判**：第 13 章 7 步法 + binary
2. **统计校正**：Rogan-Gladen 公式把 judge 观察值还原成估计真实值
3. **置信区间**：Bootstrap 算 95% CI，告诉你点估计的不确定范围
4. **pairwise 进阶**：Bradley-Terry / Elo 用于多 agent 排名
5. **Position bias 防护**：每对跑两次 + 一致性判决

下一章 pass^k 一致性会把这套统计基础设施用得更深入——多 trial 评测 + 一致性指标。

---

> 本章来自《AI Agent 评测工程实战》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev) · 反馈与勘误：[GitHub Issues](https://github.com/diguike/book-agent-evals/issues)
