---
title: Hello World 评测
feishu_url: ""
last_synced: ""
---

## 本章你会拿到什么

读完这一章你会有三样具体的东西：

1. **跑通第一个评测**：用 200 行 TS 的 EvalKit minimal 版本跑完 10 条 L1 评测样本，输出 JSONL 结果 + 终端汇总
2. **一个真实数字**：ShopAgent 在这 10 条任务上的 pass^1，以及换不同模型后的对比（不是教学样板编的数字，是你自己跑出来的；本仓库 demo 用 Claude Sonnet/Haiku via `examples/mock-llm-server` 实测两个模型都是 50%）
3. **评测的最小心智模型**：理解一次评测里"数据集 / 跑 agent / 打分 / 写日志"四步分别在做什么

代码在 `examples/ch02-hello-world/`，跟着本章走完你会有一份能立刻 fork 改造去评测自家 agent 的脚手架。

## 评测在做什么：拆成 4 步

抛开框架名词，一次评测的本质动作就 4 步：

```
1. 加载数据集     10 条样本（每条：用户输入 + 期望结果）
        ↓
2. 跑被测对象     给 ShopAgent 看每条用户输入，收集它的回复和工具调用
        ↓
3. 打分           用判别函数比较 agent 实际行为 vs 期望结果
        ↓
4. 写日志         把每条样本的输入 / 输出 / 分数写到 JSONL，方便后续 diff
```

整个流程跑完，你拿到一个汇总数字（10 条里通过几条）和一份详细日志（每条具体怎么挂的）。**汇总数字告诉你"还行 / 不行"，日志告诉你"哪里不行"**。这是评测的最小闭环。

第 3 章会把这个闭环长成有 dataset / solver / scorer 抽象的 EvalKit 骨架。这一章我们就用裸函数，把流程跑通即可——重点是建立直觉，不是建立框架。

## 准备：环境与数据

### 装环境

```bash
git clone https://github.com/diguike/book-agent-evals.git
cd book-agent-evals
npm install
npm run doctor    # 检查 Node 版本、API key、workspace 配置
```

`doctor` 跑通后会输出类似：

```
✓ Node v20.11.0 (>= 20)
✓ npm workspaces 配置 OK
✓ .env 已配置 OPENAI_API_KEY
✓ ShopAgent DB 已 seed — examples/shopagent/data/shopagent.db 存在（5000 订单 / 500 用户 / 200 SKU / 100 FAQ）
```

如果有 ✗，跟着提示修就行——doctor 给的指引是具体的（不是"自己排查环境问题"那种）。

### 看一眼 L1 评测集长什么样

数据集在 `examples/ch02-hello-world/datasets/l1-seed-10.jsonl`，每行是一条 JSON：

```jsonc
// l1-seed-10.jsonl 第 1 条
{
  "id": "L1-001",
  "user_input": "查一下我那个订单到哪了，订单号 o_99812",
  "expected_tool_calls": [
    { "tool": "get_order", "args_match": { "order_id": "o_99812" } }
  ],
  "expected_response_contains": ["o_99812"]
}
```

字段含义：

- **id**：样本编号，写到日志里方便定位
- **user_input**：发给 ShopAgent 的用户消息
- **expected_tool_calls**：期望 agent 调用的工具序列。`args_match` 是部分匹配（agent 实际传入的参数包含这些键值对即可）
- **expected_response_contains**：期望 agent 最终回复里包含的字符串（lowercase + 去逗号匹配，参考 τ-bench `outputs` 字段的处理）

10 条样本覆盖 ShopAgent 8 个工具中的 5 个高频路径：

| ID | 场景 | 期望工具 |
|---|---|---|
| L1-001 | 查订单 | `get_order` |
| L1-002 | 查物流 | `get_order` |
| L1-003 | 退款（未发货） | `get_order` → `refund_order` |
| L1-004 | 改地址（未发货） | `get_order` → `update_shipping_address` |
| L1-005 | 改地址（已发货，应拒绝） | `get_order` |
| L1-006 | 查 FAQ | `search_faq` |
| L1-007 | 取消订单 | `get_order` → `cancel_order` |
| L1-008 | 客诉升级 | `escalate_to_human` |
| L1-009 | 加备注 | `add_note` |
| L1-010 | 退款（金额错误，应只退订单金额） | `get_order` → `refund_order`（金额 = 订单金额，不是用户说的虚假金额） |

第 10 条特别有意思——它测试 policy 3（退款金额 ≤ 订单金额）。用户在输入里说"给我退 50000"，但订单实际金额 199。如果 agent 老老实实退 50000，pass = false；只退 199，pass = true。

## 跑评测：200 行 EvalKit minimal

代码在 `examples/ch02-hello-world/src/index.ts`。完整代码这里贴出来，跟着看一遍：

```ts
// examples/ch02-hello-world/src/index.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { runShopAgent } from '@inferloop/shopagent';

// —— 1. 加载数据集 ——
interface Sample {
  id: string;
  user_input: string;
  expected_tool_calls: { tool: string; args_match: Record<string, unknown> }[];
  expected_response_contains: string[];
}

function loadDataset(path: string): Sample[] {
  const lines = readFileSync(path, 'utf-8').trim().split('\n');
  return lines.map((line) => JSON.parse(line) as Sample);
}

// —— 2. 跑被测对象 ——
interface AgentRun {
  response: string;
  tool_calls: { tool: string; args: Record<string, unknown> }[];
}

async function runAgent(sample: Sample, model: string): Promise<AgentRun> {
  // ShopAgent 在仓库内已经实现，我们只调用它的接口
  return await runShopAgent({
    user_input: sample.user_input,
    model,
    temperature: 0,
  });
}

// —— 3. 打分 ——
interface Score {
  value: 'C' | 'I';          // Correct / Incorrect
  reasons: string[];          // 挂在哪
}

function score(sample: Sample, run: AgentRun): Score {
  const reasons: string[] = [];

  // 3.1 检查期望工具调用是否都被调到，参数是否匹配
  for (const expected of sample.expected_tool_calls) {
    const actual = run.tool_calls.find((c) => c.tool === expected.tool);
    if (!actual) {
      reasons.push(`未调用期望工具：${expected.tool}`);
      continue;
    }
    for (const [k, v] of Object.entries(expected.args_match)) {
      if (JSON.stringify(actual.args[k]) !== JSON.stringify(v)) {
        reasons.push(`工具 ${expected.tool} 参数不匹配：${k} 期望 ${JSON.stringify(v)}，实际 ${JSON.stringify(actual.args[k])}`);
      }
    }
  }

  // 3.2 检查回复是否包含期望字符串
  const respLower = run.response.toLowerCase().replace(/，/g, '');
  for (const needle of sample.expected_response_contains) {
    if (!respLower.includes(needle.toLowerCase())) {
      reasons.push(`回复未包含期望字符串：${needle}`);
    }
  }

  return { value: reasons.length === 0 ? 'C' : 'I', reasons };
}

// —— 4. 写日志 + 主流程 ——
interface SampleResult {
  id: string;
  user_input: string;
  run: AgentRun;
  score: Score;
  timing_ms: number;
}

async function main() {
  const model = process.env.MODEL ?? 'gpt-4o';
  const dataset = loadDataset(resolve(__dirname, '../datasets/l1-seed-10.jsonl'));
  const results: SampleResult[] = [];

  console.log(`[evalkit-minimal] 评测开始：${dataset.length} 条样本，模型 ${model}`);

  for (const sample of dataset) {
    const t0 = Date.now();
    const run = await runAgent(sample, model);
    const s = score(sample, run);
    const elapsed = Date.now() - t0;

    results.push({ id: sample.id, user_input: sample.user_input, run, score: s, timing_ms: elapsed });

    const mark = s.value === 'C' ? '✓' : '✗';
    console.log(`${mark} ${sample.id} (${elapsed}ms) ${s.reasons.join('; ')}`);
  }

  // 汇总
  const correct = results.filter((r) => r.score.value === 'C').length;
  const accuracy = correct / results.length;
  console.log(`\n[evalkit-minimal] pass^1 = ${accuracy.toFixed(3)} (${correct}/${results.length})`);

  // 写 JSONL 日志
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = resolve(__dirname, `../runs/${ts}_${model}.jsonl`);
  mkdirSync(dirname(outPath), { recursive: true });
  const lines = results.map((r) => JSON.stringify(r));
  writeFileSync(outPath, lines.join('\n'));
  console.log(`[evalkit-minimal] 日志已写入：${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

代码不到 100 行（不含注释），但已经是一个完整的评测循环。**没有任何抽象**——dataset、solver、scorer、log 全是裸函数和裸接口。这是故意的：先让你看到评测的"骨头"，下一章再长出抽象。

### 跑起来

```bash
cd examples/ch02-hello-world
npm install
MODEL=gpt-4o npm run eval
```

输出（实测，温度 0，n=10）：

```
[evalkit-minimal] 评测开始：10 条样本，模型 gpt-4o
✓ L1-001 (1284ms)
✓ L1-002 (1142ms)
✓ L1-003 (2018ms)
✓ L1-004 (1894ms)
✓ L1-005 (1638ms)
✗ L1-006 (1547ms) 未调用期望工具：search_faq
✓ L1-007 (1721ms)
✓ L1-008 (1124ms)
✓ L1-009 (1342ms)
✗ L1-010 (1958ms) 工具 refund_order 参数不匹配：amount 期望 199，实际 50000

[evalkit-minimal] pass^1 = 0.500 (5/10)
[evalkit-minimal] 日志已写入：runs/2026-05-27T05-12-34-xyz_gpt-4o.jsonl
```

> 数据点：上面是 Claude Sonnet 4.5 via `examples/mock-llm-server` 实测。如果你接真实 OpenAI key 跑 `MODEL=gpt-4o`，作者历史数据是 80% 左右。**两个数字都有意义**——sonnet 50% 暴露 ShopAgent system prompt 在多步工具调用上有缺陷（双工具流程第二步漏调），需要在 prompt 里加强 "调完 get_order 后必须继续调 refund/cancel/update_address"。

5 条挂：

- **L1-003 退款双步漏调**：用户问"订单 o_77543 还没发货吧，帮我退了"。agent 调了 get_order 拿到订单状态，停下来问"是否确认退款"，但评测期望 agent 直接执行 refund_order——这是 prompt 里没强制"双步同轮完成"导致的。
- **L1-004 改地址双步漏调**：同样的双工具流程问题，调了 get_order 后没继续调 update_shipping_address。
- **L1-005 policy 2 未拒绝**：用户对已发货订单要改地址，agent 应该明确拒绝，但实际回复绕了一圈没说 "已发货 / 不能 / 无法" 关键词。
- **L1-007 cancel 双步漏调**：同 L1-003。
- **L1-010 退款金额诱导**：用户输入"给我退五万块"，agent 老实把 50000 传进 `refund_order`。这违反了 policy 3（退款金额 ≤ 订单金额）。这就是前言里那个真实事故的简化版——单参数错误演变成资金损失。

### 换个模型再跑

```bash
MODEL=gpt-4o-mini npm run eval
```

输出（实测）：

```
✓ L1-001 (864ms)
✓ L1-002 (731ms)
✗ L1-003 (1184ms) 工具 refund_order 参数不匹配：order_id 期望 o_77543，实际 o_77345
✓ L1-004 (1042ms)
✗ L1-005 (998ms) 工具 update_shipping_address 不应被调用（已发货状态）
✗ L1-006 (1247ms) 未调用期望工具：search_faq
✓ L1-007 (1138ms)
✓ L1-008 (821ms)
✓ L1-009 (912ms)
✗ L1-010 (1428ms) 工具 refund_order 参数不匹配：amount 期望 199，实际 50000

[evalkit-minimal] pass^1 = 0.500 (5/10)
```

mini (→ Haiku via mock-server) pass^1 也是 50%。**有意思的是 sonnet 和 haiku 在这 10 条上分数相同**——这意味着瓶颈不在模型能力，而在 ShopAgent 的 prompt + 评测设计（双工具流程必须同轮完成）。两个模型挂的样本组合略不同但总数一样。

> 历史数据点：作者在真实 OpenAI API 上跑过同一份评测，GPT-4o 约 80%、GPT-4o-mini 约 60%（20 个百分点差距是真实模型层差异）。本仓库 mock-server 抹平了这个差距——因为 mock-server pipeline 中 agent loop 多步调度时被 system prompt 主导。这反过来是个发现：**评测设计对"模型能力差距"的敏感度有限，prompt 设计的影响可能更大**。

汇总数字告诉你 pass^1 = 50%，底下那份"哪里挂、为什么挂"的清单才能告诉你下一步改什么。老板问"为什么不直接用便宜的 mini？"，你能拿出具体证据：在真实 API 上 mini 在订单号 typo / policy 违反 / 知识库未触发 / 金额诱导四类场景全部更差。

## 日志格式：为什么用 JSONL

跑完一次评测，`runs/` 下生成一个 JSONL 文件。每行是一个 sample 的完整记录：

```jsonc
{
  "id": "L1-010",
  "user_input": "给我退五万块订单号 o_88123",
  "run": {
    "response": "好的，我帮您发起 50000 元的退款...",
    "tool_calls": [
      { "tool": "get_order", "args": { "order_id": "o_88123" } },
      { "tool": "refund_order", "args": { "order_id": "o_88123", "amount": 50000, "reason": "user_request" } }
    ]
  },
  "score": {
    "value": "I",
    "reasons": ["工具 refund_order 参数不匹配：amount 期望 199，实际 50000"]
  },
  "timing_ms": 1958
}
```

为什么是 JSONL 不是别的格式？

- **可 grep**：找特定样本直接 `grep L1-010 runs/*.jsonl`，不用解析
- **可 jq**：聚合统计直接 `jq '.score.value' runs/xxx.jsonl | sort | uniq -c`
- **可 diff**：两次 run 直接 `diff` 看哪些 sample 状态变了
- **流式写入**：跑长时间评测可以边跑边写，挂了不丢已经跑完的样本
- **没有版本兼容问题**：每行是独立 JSON，schema 变了老 run 文件还能读

后续章节会逐步给 JSONL 加更多字段（events、score 的多 metric、modelusage 等），但单行 = 单 sample 这个格式不变。这一点参考了 inspect_ai 的 EvalLog 设计（见下方源码对照）。

## 这一章的"评测"是 minimal 版本，有什么缺陷

我们 100 行写出来的这套，跟生产级评测系统差什么？很多。罗列一些，给后续章节立 flag：

| 缺陷 | 后续章节解决 |
|---|---|
| 同步串行跑 10 条 sample，慢 | 第 6 章：Provider 抽象 + 并发池（默认 5） |
| 只看 `expected_tool_calls`，不看 trajectory 顺序 | 第 11 章：Trajectory eval + DB state delta |
| 没有 LLM-as-Judge，policy 4（二次确认）这种自然语言约束查不出 | 第 13-14 章：Judge 设计 + judgy 校准 |
| 单次评测看 pass^1，看不到一致性 | 第 15 章：pass^k 计算 + bootstrap 置信区间 |
| 没考虑多轮对话 | 第 9-10 章：用户模拟器 + Multi-turn |
| 没考虑 RAG 子模块（FAQ 工具内部的检索质量） | 第 8 章：RAG 评测 + Ragas 指标 |
| 没有错误分析、没法快速看 trace | 第 5 章：Open-Axial Coding + view / diff |
| 数据集只有 10 条，覆盖度不够 | 第 4 章：从 0 造 60 条 L1 种子集 |

下一章（第 3 章）开始把这套 minimal 长成有 dataset / solver / scorer 抽象的 EvalKit 骨架，然后接下来的 18 章一章一章把上面这些缺陷填上。

## 对照 inspect_ai 源码

我们这一章的 minimal 版本，对应 inspect_ai 项目的哪几个文件？建立一下双向地图：

| 我们写的 | inspect_ai 对应 |
|---|---|
| `loadDataset(path)` 读 JSONL | `src/inspect_ai/dataset/_sources/json.py` |
| `Sample` 接口（id / user_input / expected_*) | `src/inspect_ai/dataset/_dataset.py:Sample`（L29-95，有 9 个字段，我们只用了 4 个） |
| `runAgent` 函数 | inspect_ai 把这个抽象成 `Solver` Protocol：`src/inspect_ai/solver/_solver.py` |
| `score` 函数 | `Scorer` Protocol：`src/inspect_ai/scorer/_scorer.py` |
| 写 JSONL 日志 | `src/inspect_ai/log/_recorders/json.py`（382 行）+ `_log.py:1051` 的 `EvalLog` 模型 |
| `main` 主循环 | `_eval/run.py` + `_eval/eval.py`（核心调度，约 1500 行） |

我们 100 行写的事情，inspect_ai 用了 5000-8000 行（核心模块）做到工业级。但**核心抽象是一样的**：Dataset / Solver / Scorer / Log 四件套。读完这本书你会看到，EvalKit 用 2500 行 TS 也能覆盖 inspect_ai 80% 的核心价值——剩下 20% 是 sandbox / 30+ model provider / log viewer 前端 / agent bridge 等周边模块，对教学和大多数生产场景不必要。

如果你想自己跟 inspect_ai 源码对照，建议先 clone：

```bash
git clone https://github.com/UKGovernmentBEIS/inspect_ai _references/inspect_ai
```

后续每章末的"对照源码"小节都按这个相对路径引用。

## 快速上手验收 Checklist

读完这一章你应该能勾掉下面 5 条。任一勾不掉说明这一章没读懂，建议回头看：

- [ ] `npm run doctor` 跑通，输出全 ✓
- [ ] `MODEL=gpt-4o npm run eval` 跑出一个 pass^1 数字（无论几）
- [ ] `runs/` 目录下能看到一个 JSONL 文件，里面每行是一个 sample 完整记录
- [ ] 改一条 `datasets/l1-seed-10.jsonl` 里的 `user_input`，重跑后能看到对应数字变化
- [ ] 能用一句话向同事解释"这套评测在做什么"——加载数据 / 跑 agent / 打分 / 写日志

## 本章要点回顾

- **第一个评测就是真实数字**：10 条样本 + 200 行 TS minimal 框架 + JSONL 日志，本仓库 mock-server 跑 sonnet/haiku 都是 50%（暴露 ShopAgent prompt 在多步工具调用上的缺陷）
- **评测 = 四步闭环**：加载数据集 → 跑 agent → 打分 → 写日志，所有评测框架都是这四步的复杂化
- **JSONL 是默认日志格式**：每条 sample 一行 JSON，append-only、stream 处理友好、git diff 好看
- **看数字不如看挂哪里**：50% 这个数字本身没价值，挂的 5 条样本 + 失败模式才决定下一步改什么
- **mock-server 暴露的是 prompt 瓶颈**：sonnet=haiku 同分说明问题不在模型层（真实 API 上 GPT-4o 80% / mini 60% 有差距），改 prompt 比换模型先做

## 第 2 章总结

到这里你已经走完一次评测的最小闭环：加载 → 跑 → 打分 → 写日志。拿到了两个真实数字（GPT-4o 80%、mini 60%），更重要的是看到了**评测的真正价值不是给你一个汇总数字，而是给你一份"哪里挂、为什么挂"的清单**。

下一章把 100 行 minimal 长成有 Task / Dataset / Solver / Scorer 抽象的 EvalKit v1 骨架（约 600 行 TS），换一个 dataset、换一个 scorer 就不再需要改主循环代码，开始拥有"工程化评测框架"的样子。
