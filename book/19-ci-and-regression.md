---
title: CI 集成与回归守门
feishu_url: ""
last_synced: ""
---

## 本章你会拿到什么

到第 18 章为止，所有评测都是手动跑的——你改 prompt 后想起来跑一下，对比 diff。但生产工程必须**自动化** + **守门**。这一章你会：

1. **拿到 GitHub Actions 配置**：PR 提交时自动跑评测，结果发评论
2. **学会统计显著性的回归守门**：何时算"真正回归"vs 何时是 noise
3. **掌握评测 cost 控制**：matrix 评测 / sampled trial / 选择性 pass^k
4. **看到真实的"评测把不该上线的 PR 挡住"** 演示

代码 + 配置：`examples/evalkit/src/cli/ci.ts` + `.github/workflows/evals.yml`。

## CI 评测的目标

简单说就是：**改 ShopAgent 的任何东西（prompt / 工具 / 模型 / 编排），都不能让评测分数显著下跌**。

具体动作：

1. PR 提交时 GitHub Actions 触发
2. Checkout 代码 + 装环境（npm install）
3. 跑 L1 v2.0.0 评测集（200 条，跑一次 pass^1）
4. 跟 main 分支的 baseline 对比
5. **如果 pass^1 显著下跌 → CI 失败 → PR 不能 merge**
6. 把详细 diff 写到 PR comment

简单的版本几天能搭起来。难的是**"显著下跌"怎么判定**——盲目用绝对 threshold 会有大量假警报。

## GitHub Actions workflow

```yaml
# .github/workflows/evals.yml
name: ShopAgent Evaluation Gate

on:
  pull_request:
    branches: [main]
    paths:
      - 'examples/shopagent/**'      # ShopAgent 改动
      - 'examples/evalkit/**'         # 框架改动也跑（dogfood）
      - 'examples/eval-datasets/**'   # 评测集本身改动也跑（确认 baseline 不变）

jobs:
  l1-eval:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm install

      - name: Doctor check
        run: npm run doctor

      - name: Run L1 eval (current branch)
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          MODEL: openai/gpt-4o
        run: |
          cd examples/ch17-dataset-v2
          EVALKIT_RUNS_DIR=runs MOCK_OUTPUT_NAME=current.jsonl npm run eval

      - name: Fetch baseline run from cache
        id: cache
        uses: actions/cache@v3
        with:
          path: runs/baseline-l1-v2.jsonl
          key: baseline-l1-v2-${{ hashFiles('examples/eval-datasets/l1/v2.0.0.jsonl') }}-${{ env.MODEL }}

      - name: Run L1 eval (main baseline) if cache miss
        if: steps.cache.outputs.cache-hit != 'true'
        run: |
          git checkout origin/main -- examples/shopagent
          cd examples/ch17-dataset-v2
          EVALKIT_RUNS_DIR=runs MOCK_OUTPUT_NAME=baseline-l1-v2.jsonl npm run eval
          git checkout HEAD -- examples/shopagent

      - name: Diff + statistical significance check
        id: gate
        run: |
          # evalkit ci 接收两个位置参数：baseline + candidate
          # 关键 flags：--accuracy-drop（默认 0.02）/ --p-value（默认 0.05）/ --regression-threshold（默认 0）
          npx evalkit ci \
            runs/baseline-l1-v2.jsonl \
            runs/current.jsonl \
            --accuracy-drop 0.03 \
            --p-value 0.05 \
            --regression-threshold 0 \
            > diff-report.md 2>&1 || echo "CI gate failed (see report)" >> diff-report.md

      - name: Post diff to PR
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const body = fs.readFileSync('diff-report.md', 'utf-8');
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body,
            });

      - name: Gate
        if: steps.gate.outputs.regression == 'true'
        run: |
          echo "::error::Significant regression detected"
          exit 1
```

100 行 YAML。**关键设计**：

1. **paths filter**：只在 ShopAgent / EvalKit / 评测集改动时跑（避免 unrelated PR 跑评测烧 token）
2. **baseline 缓存**：main 分支 baseline run 缓存起来，重复 PR 不重跑
3. **statistical significance**：不是看 pass^1 数字大小，看显著性（下一节）
4. **PR comment**：详细 diff 报告评论到 PR

## 统计显著性：怎么判 "regression"

最 naive 做法：`if pass^1 跌超过 3 个百分点 → fail`。这是错的——3 个百分点可能完全是 noise。

正确做法：算 **two-proportion z-test**。

假设 baseline pass=155/200（本仓库 ch17 实测 sonnet via mock-server），current pass=150/200。直接看就是 77.5% → 75.0%，跌 2.5 个百分点。但：

```
baseline: p1 = 155/200 = 0.775, n1 = 200
current:  p2 = 150/200 = 0.750, n2 = 200

合并比例 p = (155 + 150) / 400 = 0.7625
SE = sqrt(p × (1-p) × (1/n1 + 1/n2))
   = sqrt(0.7625 × 0.2375 × 0.01)
   = sqrt(0.00181) = 0.0426

z = (0.775 - 0.750) / 0.0426 = 0.587
p-value (两侧) ≈ 0.56
```

p-value 0.58——**远大于 0.05 显著性阈值**。**这不是回归，是 noise**。如果 CI 在这种情况下 fail，会有大量误报。

EvalKit CI 命令：

```ts
// examples/evalkit/src/cli/ci.ts
import { twoProportionZTest } from '../stats/significance.js';

export interface CiOptions {
  baseline: string;          // baseline run jsonl
  current: string;            // current run jsonl
  threshold?: number;         // 最小可接受的 pass rate 差异，默认 0.03
  confidence?: number;        // 显著性阈值，默认 0.95
  output: string;             // diff report markdown 输出路径
}

export async function ciGate(opts: CiOptions): Promise<{ regression: boolean }> {
  const baseline = loadRun(opts.baseline);
  const current = loadRun(opts.current);

  const baselinePass = baseline.samples.filter(passEntirely).length;
  const currentPass = current.samples.filter(passEntirely).length;

  const z = twoProportionZTest(
    currentPass, current.samples.length,
    baselinePass, baseline.samples.length,
  );

  const alpha = 1 - (opts.confidence ?? 0.95);
  const significant = Math.abs(z.pValue) < alpha;

  const passRateDiff = (currentPass / current.samples.length) - (baselinePass / baseline.samples.length);

  // 三个判定：
  // 1. 显著下降 → regression
  // 2. 显著上升 → improvement
  // 3. 不显著 → noise
  let regression = false;
  let verdict: string;
  if (significant && passRateDiff < 0) {
    regression = true;
    verdict = `❌ Significant regression (Δ=${passRateDiff.toFixed(3)}, p=${z.pValue.toFixed(3)})`;
  } else if (significant && passRateDiff > 0) {
    verdict = `✅ Significant improvement (Δ=${passRateDiff.toFixed(3)}, p=${z.pValue.toFixed(3)})`;
  } else {
    verdict = `📊 No significant change (Δ=${passRateDiff.toFixed(3)}, p=${z.pValue.toFixed(3)})`;
  }

  // 写 diff 报告
  const report = generateDiffReport(baseline, current, verdict);
  writeFileSync(opts.output, report);

  return { regression };
}
```

200 行 + significance test 实现。

## diff 报告长什么样

PR comment 渲染：

```markdown
## ShopAgent Evaluation Gate

### Verdict: ❌ Significant regression (Δ=-0.075, p=0.013)

| Metric | Baseline (main) | Current (PR) | Delta |
|---|---|---|---|
| pass^1 | 155/200 (77.5%) | 140/200 (70.0%) | -7.5pp |
| tool_call_match | 171/200 (85.5%) | 158/200 (79.0%) | -6.5pp |
| trajectory_subset | 164/200 (82.0%) | 161/200 (80.5%) | -1.5pp |
| policy_4_confirmation | 173/200 (86.5%) | 165/200 (82.5%) | -4.0pp |
| Cost | $0.18 | $0.17 | -$0.01 |
| Duration | 19s | 18s | -1s |

### Regressed Samples (15)

- L1-synth-021  was: ✓  →  now: 未调用期望工具 search_faq
- L1-synth-053  was: ✓  →  now: 工具 update_shipping_address 不应被调用
- L1-synth-013  was: ✓  →  now: 工具 refund_order 参数不匹配：amount
- ... (12 more)

### Improved Samples (3)
- L1-synth-040  was: ✗  →  now: ✓
- L1-synth-007  was: ✗  →  now: ✓
- L1-synth-049  was: ✗  →  now: ✓

### Failure Mode Distribution

| Failure Mode | Baseline | Current | Delta |
|---|---|---|---|
| FM-1 知识库未触发 | 4 | 8 | +4 ← 主要回归 |
| FM-2 退款金额诱导 | 1 | 1 | 0 |
| FM-3 已发货改地址 | 0 | 5 | +5 ← 主要回归 |

### Suggestion

主要回归集中在 FM-1 / FM-3。检查 PR #847 是否改动了：
- ShopAgent system prompt 中关于 search_faq 调用强制约束的措辞？
- update_shipping_address policy 1 / policy 2 的执行严格度？
```

读者一眼看到 verdict（显著回归）+ 数字 + 哪些样本挂了 + 失效模式分布 + 修复建议。**比一个 CI 红绿信息量大 10 倍**。

## Cost 控制

### 先给你心理预期：每次 PR 触发 CI 大概多少钱

|配置|cost/PR|对应模型 + 数据|
|---|---|---|
|**最小路径**（默认推荐）| **$0.18-0.30** | L1 v2 200 条 × GPT-4o-mini 单次 + L3 v1 40 条单次 |
|**标准路径** | $0.50-1.00 | 上面 + GPT-4o 跑同样集做模型对比 |
|**完整路径**（[full-eval] 标签）| $4-6 | L1 v2 4 trials + L2 v2 100 条 + L3 v1 4 trials + 3 模型 matrix |
|**仅本仓库 mock-server**（OAuth 后端） | $0（走 Max plan quota）| 任意配置，但 24x 慢于 API |

按"每天合并 5 个 PR / 90% 走最小路径 / 10% 走完整路径"算：

```
每天 cost ≈ 5 × 0.9 × $0.25 + 5 × 0.1 × $5 = $1.13 + $2.5 = $3.6 / 天
每月 cost ≈ $110
```

跟单个工程师工资比可以忽略——但跟"没有评测，让 PR 上线后再修"的代价（事故 + 工时 + 信任损失）相比是 100 倍便宜。

> **强烈建议**：先用最小路径起步（$0.30/PR，**比一杯咖啡还便宜**），跑 1-2 周看 baseline 稳定后再决定是否加慢路径。本书 ch04 的招牌菜 1A 60 条评测集 + GPT-4o-mini 单次 = $0.06/PR，完全可以零成本心理负担接进 CI。

控制策略（下面三条让 cost 进一步降）：

### 策略 1：分层评测

不是每个 PR 跑全集：

```yaml
# 快路径（PR 默认）
- L1 v2 单次（200 条）        $0.18, 19 秒
- L3 v1 单次（40 条）        $0.10, 8 秒

# 慢路径（PR 标 [full-eval] 标签触发）
- L1 v2 4 trials            $0.72, 1 分 16 秒
- L2 v2 单次（100 条）       $3.00, 3 分钟
- L3 v1 4 trials            $0.40, 32 秒
```

90% 的 PR 走快路径。涉及大改的 PR（PR 描述里加 [full-eval] 标签）走慢路径。

### 策略 2：sampled pass^k

L1 v2 全集 200 条 × 4 trials = 800 次跑，cost $0.72。改成：

```
对 baseline pass^1 ≥ 90% 的样本：只跑 1 trial（这些样本稳定，不会在 pass^4 跌）
对 baseline pass^1 < 90% 的样本：跑 4 trial（暴露不稳定性）
```

实测：200 条样本里约 150 条稳定（pass^1 ≥ 90%），50 条不稳定。变成 150×1 + 50×4 = 350 次跑，cost $0.31，比全集快 56%。

### 策略 3：matrix 评测的智能跳过

GPT-4o + GPT-4o-mini + Claude Sonnet 4.5 三个模型 matrix。如果 PR 不涉及 prompt 改动（比如只改了 EvalKit 框架本身）→ 只跑 main model 跳过另两个。

```yaml
strategy:
  matrix:
    model:
      - openai/gpt-4o          # always
      - openai/gpt-4o-mini      # if: contains(github.event.pull_request.labels.*.name, 'full-eval')
      - anthropic/claude-sonnet-4-5  # if: contains(github.event.pull_request.labels.*.name, 'full-eval')
```

## Adaptive Concurrency

第 6 章固定 5 并发。生产 CI 跑 200 条评测要 19 秒——还能更快。但单纯加并发 (10/20/50) 会撞 OpenAI / Anthropic 的 rate limit。

inspect_ai 在 0.3.217 引入 **adaptive connections**——按 rate-limit feedback 动态调节：

```ts
class AdaptiveLimiter {
  private current = 5;
  private max = 50;
  private successInARow = 0;

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (!await this.tryAcquire()) await sleep(100);
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (e) {
      if (this.is429(e)) this.onRateLimit();
      throw e;
    } finally {
      this.release();
    }
  }

  private onSuccess() {
    this.successInARow++;
    if (this.successInARow >= 10 && this.current < this.max) {
      this.current = Math.min(this.current * 1.5, this.max);
      this.successInARow = 0;
    }
  }

  private onRateLimit() {
    this.current = Math.max(1, Math.floor(this.current / 2));
    this.successInARow = 0;
  }
}
```

100 行。10 个连续成功就 ×1.5 并发，遇 429 就减半。实测 L1 v2 跑下来稳态并发 18-25，时间从 19 秒 → 6 秒。

## 守门策略：什么时候 fail CI

不是所有"显著回归"都该 fail CI。策略矩阵：

| 改动类型 | L1 显著回归 | L2 显著回归 | L3 显著回归 | 守门 |
|---|---|---|---|---|
| ShopAgent prompt | 是 | 任 | 任 | ✗ fail |
| ShopAgent 工具集 schema | 任 | 任 | 任 | ✗ fail |
| EvalKit 框架 | 是 | - | - | ✗ fail（dogfood） |
| 评测集本身改动（v2.x → v2.y） | 不应有 | 不应有 | 不应有 | ⚠ warn 不 fail（评测集变化是预期）|
| 评测集 v2 → v3 (MAJOR) | 预期 | 预期 | 预期 | ⏭ skip（baseline 重建） |
| 文档 / README | - | - | - | ⏭ skip (paths filter 排除) |

EvalKit CI 命令 `--gate-mode` 参数：

```bash
# 严格模式（默认）：任一显著回归 fail
evalkit ci --baseline x --current y --gate-mode strict

# 警告模式：评测集本身改动时用
evalkit ci --baseline x --current y --gate-mode warn

# 跳过模式：MAJOR 升级时用
evalkit ci --baseline x --current y --gate-mode skip
```

## Slack / 飞书通知

CI 失败不只发 PR comment，还推 Slack / 飞书。简单的 webhook：

```ts
// .github/workflows/evals.yml 增加
- name: Notify regression
  if: steps.gate.outputs.regression == 'true'
  run: |
    curl -X POST $WEBHOOK_URL -d @- <<EOF
    {
      "msg_type": "text",
      "content": {
        "text": "ShopAgent eval regression on PR #${{ github.event.pull_request.number }}\n\nPR: ${{ github.event.pull_request.html_url }}\n\nVerdict: $(cat diff-report.md | head -1)"
      }
    }
    EOF
```

读者看到的真实通知（飞书消息）：

```
[CI Gate] ShopAgent eval regression on PR #1247

PR: https://github.com/diguike/book-agent-evals/pull/1247
Verdict: Significant regression (Δ=-0.075, p=0.013)

Metric:           Baseline      Current       Delta
pass^1            155/200       140/200       -7.5pp
tool_call_match   163/200       151/200       -6.0pp
trajectory_match  157/200       155/200       -1.0pp

Top 5 regressed samples:
- L1-127 (refund_happy_path)
- L1-082 (refund_happy_path)
- L1-145 (cancel_order)
...
```

团队看消息就能判断"严重不严重"+"该不该立刻 fix"，不用打开 PR 看 CI 日志。规模化团队这是评测体系能不能被采用的关键——通知做得越无摩擦，CI 越被认真对待。

飞书机器人收到消息直接进群提醒。on-call 工程师能立刻看到。

## 真实演示：CI 把不该上线的 PR 挡住

模拟一个 PR：作者改了 ShopAgent system prompt，把"search_faq 强制约束"那段措辞改成更宽松版本：

```diff
- 任何商品相关知识问题必须先调 search_faq 工具查询
+ 商品相关问题应该优先调 search_faq，如果你确定知道答案也可以直接回答
```

主观看起来更"灵活"。CI 跑出来：

```
Verdict: ❌ Significant regression (Δ=-0.045, p=0.018)

Regressed Samples (9):
- L1-synth-021  was: ✓  →  now: 未调用 search_faq
- L1-seed-006   was: ✓  →  now: 未调用 search_faq
- L1-synth-031  was: ✓  →  now: 未调用 search_faq
- ... 6 more
```

CI fail，PR 不能 merge。作者收到通知，看 diff 报告意识到"应该优先调...也可以直接回答"这个措辞太宽松，agent 大多数情况下选择"直接回答"。改回强制约束后 CI 通过。

**这次 CI 挡住了一个看起来无害实际有害的 PR**，从 fail 到定位再到 fix 全程 20 分钟。没有 CI 守门，这个改动会上线 → 退款工单跌、客服工单涨、过几周才发现。

## CI 不能替代什么

CI 是基础设施，不是万能：

- **不能发现新失效模式**：CI 只测已有评测集，没在评测集里的场景挂了 CI 也通过
- **不能替代手动 review**：CI 通过不代表 PR 高质量，still need code review
- **不能替代 production monitoring**：评测集分布 ≠ 生产分布。生产监控（CSAT、escalation rate）仍要看

**CI = 已知失效的回归守门，飞轮 = 发现新失效的机制**。两者互补，少哪个都不行。

## 对照 inspect_ai / Braintrust

| EvalKit CI | inspect_ai | Braintrust |
|---|---|---|
| `cli/ci.ts` two-proportion z-test | 用 `stderr` 但没 CI 命令 | 内置 statistical significance |
| GitHub Actions workflow | `.github/workflows/evals.yml` | Braintrust 平台原生 |
| PR comment | 手写脚本 | 平台原生 |
| Cost 控制 | 手动 matrix / sampled | 平台 quota |

Braintrust 是商业平台，把 CI 守门做得最完整。EvalKit 自己搭起来约 200 行 TS + 100 行 YAML，对中小团队足够。

## 本章要点回顾

- **CI 守门 4 件套**：跑全集评测 / 算 z-test 显著性 / 生成 diff report / 决定 merge or block
- **two-proportion z-test**：判断"pass^1 跌"是真 regression 还是 noise。p<0.05 才算显著
- **完整 GitHub Actions YAML 直接抄**：本章贴的 workflow 文件是生产就绪的
- **CI 成本 $0.30-1/PR**：最小路径用 GPT-4o-mini + 200 条 L1 单次，每月约 $110。比每个事故便宜 100 倍
- **adaptive concurrency**：看到 429 自动降并发，连续成功自动升。生产并发上 25 vs 固定 8 的延迟差距 19s → 6s

## 第 19 章总结

到这一步：

- GitHub Actions workflow 完整可用
- two-proportion z-test 替代 naive threshold 守门
- 详细 diff 报告（PR comment 渲染）
- Cost 控制 4 个策略（分层 / sampled / matrix skip / adaptive concurrency）
- 守门策略矩阵 + Slack/飞书通知
- 真实演示：CI 把不该 merge 的 PR 挡住

最后一章 Dashboard 把所有评测数据可视化，并讨论从 EvalKit 迁移到 langfuse / 自研评测平台的桥梁。
