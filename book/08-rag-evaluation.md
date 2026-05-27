---
title: RAG 子模块评测
feishu_url: ""
last_synced: ""
---

## 本章你会拿到什么

ShopAgent 的 `search_faq` 工具内部是一个 RAG 子系统——文档向量化、相似度检索、top-k 召回、生成回答。它是 agent 的一个工具，但本身又是个完整 ML pipeline。这一章你会：

1. 学会**把 RAG 拆成两层评测**：retrieval 层（找对没找对）vs generation 层（用对没用对）
2. 拿到 **Ragas 三件套指标的 TS 实现**：faithfulness（不编造）、answer relevancy（答到点）、context precision/recall（找全没）
3. 用 EvalKit 评 `search_faq` 这一个子工具，**独立于完整 ShopAgent 测一遍**
4. 看清楚为什么 Hamel 的"agent 凭常识答没查 FAQ"是个有名的 RAG 评测陷阱

## RAG 评测的两层模型

```
┌──────────────────────────────────────────────┐
│ generation 层    用检索到的 context 生成回答      │
│   → faithfulness     回答是否忠于 context        │
│   → answer relevancy 回答是否答到用户问题         │
├──────────────────────────────────────────────┤
│ retrieval 层    把 query 转成向量，找 top-k 文档   │
│   → context precision  top-k 文档是否都相关       │
│   → context recall     该召回的文档是否都召回了     │
└──────────────────────────────────────────────┘
```

很多团队 RAG 不工作，是因为只看 generation 层（看回答好不好），忽略 retrieval 层（看是否找对了文档）。但 **garbage in garbage out**——retrieval 不准 generation 再聪明也救不回来。

正确做法是分层评测、独立打分。这是 [Ragas](https://github.com/explodinggradients/ragas) 框架最核心的设计。本章我们做 Ragas 的 TS 移植版（核心指标约 200 行 TS）。

## ShopAgent 的 `search_faq` 内部

简单了解一下被测对象（铁律 1：只看接口不看实现，所以这里只看签名）：

```ts
// examples/shopagent/src/tools/search_faq.ts —— 接口签名
export interface SearchFAQRequest {
  query: string;
  topK?: number;                 // 默认 3
}

export interface SearchFAQResult {
  hits: Array<{
    docId: string;
    title: string;
    content: string;             // 完整 FAQ 答案
    score: number;               // 0-1 相似度
  }>;
  generatedAnswer?: string;      // 如果 agent 要求生成答案，这里有
}
```

知识库（`examples/shopagent/seed/faq.jsonl`）100 条 FAQ，涵盖退换货政策、活动规则、商品保养、配送、发票等。

内部实现一句话：`text-embedding-3-small` 嵌入 query + 文档，余弦相似度找 top-k。简单、直接、有问题——这正是评测要暴露的。

## 评测 RAG 需要的"金标"

RAG 评测集和 Agent 评测集格式不一样。需要：

```jsonc
// examples/eval-datasets/rag/v1.0.0.jsonl
{
  "id": "RAG-001",
  "input": "羊毛衫能机洗吗？",
  "target": {
    "expectedContexts": ["手洗", "羊毛"],          // 该召回的 FAQ 关键词（用于 context_precision/recall）
    "expectedResponseContains": ["手洗", "羊毛"]  // 最终回复里必须出现的关键词（用于 includes scorer）
  },
  "metadata": {
    "category": "保养",
    "difficulty": "medium"
  }
}
```

字段说明：

- `input`：用户问题（也是 search_faq 的输入，跟其他 L1/L2/L3 集统一 schema）
- `target.expectedContexts`：人工标注的"应该召回的关键词"。retrieval 评分用——context_precision / context_recall scorer 会跟实际检索回来的 context 做包含匹配
- `target.expectedResponseContains`：最终回复里至少出现的关键概念。generation 评分用（注意：不是 exact match，是 keyword presence）

50 条 RAG 评测集的来源 = ShopAgent 知识库里的 100 条 FAQ 反推。**最便宜的造法**：每条 FAQ 让 LLM 生成 2-3 个不同 phrasing 的 query，再人工挑出 50 条覆盖度好的。这一步 30 分钟搞定。

## Ragas 4 个核心指标实现

### Context Precision

"召回的 top-k 文档里，相关的占多少"。准确率公式：

```
precision = |relevant ∩ retrieved| / |retrieved|
```

举例：retrieve 回 top-3 = [FAQ-1, FAQ-2, FAQ-3]，ground truth 关键词在 FAQ-1 和 FAQ-3 出现 → precision = 2/3 = 0.67。FAQ-2 是无关文档（噪声）。precision 高 = retriever 没塞太多噪声。

```ts
// examples/evalkit/src/scorer/rag/context_precision.ts
// 实际是工厂函数返回 Scorer（跟其他 scorer 统一接口）
export function contextPrecision(opts: { field?: string; groundTruthField?: string } = {}): Scorer {
  return async (state, target) => {
    // 从 state.metadata.retrievedContexts 拿 retrieval 结果（solver 注入）
    // 从 target.expectedContexts 拿 ground truth 关键词
    // 算 precision = 相关数 / top-k
    // 返回 Score { value: 0-1, scorer: 'context_precision' }
    // 完整 80 行代码见仓库文件
  };
}
```

简单到不需要 LLM——只要 expectedContexts 标对了，这是个 O(n) 字符串包含计算。完整实现在 `examples/evalkit/src/scorer/rag/context_precision.ts`（约 80 行）。

### Context Recall

"该召回的文档里，召回了多少"。召回率（recall）= 召回 / 应召回。

```ts
// examples/evalkit/src/scorer/rag/context_recall.ts
export function contextRecall(opts: { field?: string; groundTruthField?: string } = {}): Scorer {
  return async (state, target) => {
    // 从 target.expectedContexts 取 ground truth 关键词数组
    // 看其中多少个在 state.metadata.retrievedContexts 里出现
    // 返回 recalled / total_expected
  };
}
```

也不需要 LLM。Precision + Recall 是经典的 IR 指标，但对 RAG 来说**仅看这两项远远不够**——因为最终用户看的是回答，不是文档列表。下面两个 LLM-based 指标才是 generation 层质量。

### Faithfulness

"回答里的每个断言，是否能在 context 里找到依据"。这是 RAG 反幻觉的核心指标。

实现：用 LLM 把回答拆成原子断言，每个断言对照 context 判定"是否被支持"。

```ts
// examples/evalkit/src/scorer/rag/faithfulness.ts
const EXTRACT_CLAIMS_PROMPT = `把下面这段回答拆成独立的原子事实陈述，每行一条。
回答：{answer}
只输出陈述，不要其他文字。`;

const VERIFY_CLAIM_PROMPT = `判断下面的陈述是否被给定的 context 支持。
Context: {context}
Statement: {claim}

如果 context 明确支持该陈述，输出 1；如果 context 不包含该信息或与之矛盾，输出 0。
只输出一个数字。`;

export async function faithfulness(
  sample: { query: string },
  retrieved: Array<{ content: string }>,
  generated_answer: string,
  judge: Provider
): Promise<number> {
  const context = retrieved.map((d) => d.content).join('\n---\n');

  // 1. 提取断言
  const claimResp = await judge.generate({
    model: 'openai/gpt-4o-mini',  // judge 用便宜模型
    messages: [{ role: 'user', content: EXTRACT_CLAIMS_PROMPT.replace('{answer}', generated_answer) }],
    temperature: 0,
  });
  const claims = claimResp.content.trim().split('\n').filter((l) => l.trim().length > 0);

  if (claims.length === 0) return 0;

  // 2. 逐条判定
  let supported = 0;
  for (const claim of claims) {
    const verifyResp = await judge.generate({
      model: 'openai/gpt-4o-mini',
      messages: [{
        role: 'user',
        content: VERIFY_CLAIM_PROMPT
          .replace('{context}', context)
          .replace('{claim}', claim),
      }],
      temperature: 0,
      maxTokens: 5,
    });
    if (verifyResp.content.trim() === '1') supported++;
  }

  return supported / claims.length;
}
```

为什么 judge 用便宜模型（gpt-4o-mini）？因为 faithfulness 任务很窄（"这句话在 context 里有没有"），不需要旗舰模型。**Hamel 的指南反复强调**：judge 模型选择上**优先用便宜的，除非 alignment 测试证明它不够准**。第 13-14 章会讲 judge alignment 的完整方法论。

**性能说明**：faithfulness 单条评测要 1 次提取 + N 次验证（N = 断言数，通常 3-8 条）。50 条 RAG 评测集累计 50 × 5 ≈ 250 次 API 调用。上面代码示例为了可读性写成串行，**生产代码必须把验证循环改成 `Promise.all`** 并发执行：

```ts
const verifyResults = await Promise.all(
  claims.map((claim) => judge.generate({ ... })),
);
const supported = verifyResults.filter((r) => r.content.trim() === '1').length;
```

50 条 RAG 评测 cost ≈ $0.02（mini judge），耗时从串行 250 秒压到并发 20 秒。第 6 章并发池可以直接复用。

### Answer Relevancy

"回答是否真的答到了用户的 query，还是答非所问"。

实现思路：让 LLM 根据 generated_answer 反推可能的 query，跟原 query 做 embedding 相似度。如果反推的 query 跟原 query 高度相似，说明回答确实在答这个问题。

```ts
const REVERSE_QUERY_PROMPT = `下面的回答可能是回答什么问题？给出 3 个可能的问题，每行一个。
回答：{answer}`;

export async function answerRelevancy(
  sample: { query: string },
  generated_answer: string,
  judge: Provider,
  embedder: (texts: string[]) => Promise<number[][]>
): Promise<number> {
  const resp = await judge.generate({
    model: 'openai/gpt-4o-mini',
    messages: [{ role: 'user', content: REVERSE_QUERY_PROMPT.replace('{answer}', generated_answer) }],
    temperature: 0,
  });
  const reverseQueries = resp.content.trim().split('\n').filter((l) => l.trim().length > 0);

  const allTexts = [sample.query, ...reverseQueries];
  const embs = await embedder(allTexts);
  const queryEmb = embs[0];
  const sims = embs.slice(1).map((e) => cosineSim(queryEmb, e));

  return sims.reduce((a, b) => a + b, 0) / sims.length;  // 平均相似度
}
```

注意：answer relevancy 高 ≠ 回答正确。它只反映"回答和 query 主题相关性"。一个回答可能很相关但答错——所以 answer relevancy 要和 faithfulness 一起用。

## 完整 RAG 评测 Task

把上面四个 scorer 组合到一个 EvalKit task：

```ts
// examples/ch08-rag/src/eval.ts
import { defineTask, jsonlDataset, getDefaultRouter } from '@inferloop/evalkit';
import { contextPrecision, contextRecall, faithfulness, answerRelevancy } from '@inferloop/evalkit/rag';
// 也可以从根路径 import { contextPrecision, ... } from '@inferloop/evalkit'

// ragSolver：自定义 solver，调 searchFaq 把结果塞到 state.metadata.retrievedContexts，再调 LLM 生成回复
import { ragSolver } from './rag_solver.js';

const router = getDefaultRouter();
const ragEval = defineTask({
  name: 'shopagent-faq-rag',
  dataset: jsonlDataset('../eval-datasets/rag/v1.0.0.jsonl', { limit: 50 }),
  solver: ragSolver({ topK: 3 }),
  scorer: [
    contextPrecision(),                                   // 工厂函数，返回 Scorer
    contextRecall(),
    faithfulness({ judgeRouter: router, judgeModel: 'gpt-4o' }),  // 需要 LLM judge
    answerRelevancy({ judgeRouter: router, judgeModel: 'gpt-4o' }),
  ],
  config: { temperature: 0 },
});
```

四个 scorer 并行打分。每个 sample 跑完会有 4 个 Score。

跑出来（Claude Sonnet 4.5 via mock-llm-server, 20 samples，仓库 demo 默认配置）：

```
[evalkit] shopagent-faq-rag completed
  Context Precision  μ = 0.10   (top-3 里 10% 相关)
  Context Recall     μ = 0.10   (ground truth 10% 被召回)
```

10% 是灾难性数据——但是 demo 现状真实结果，原因在 `examples/shopagent/src/db/sqlite.ts` 里 `searchFaq` 用整句 SQL `LIKE %query%`。当用户问"羽绒服在家怎么洗"时，FAQ 里虽有"羽绒服洗涤注意事项"，但 LIKE 全词匹配整句失败。

RAG 评测的作用就是把这类静默失败变成可测量的数字——你看到 0.10，至少知道下一步要修 retrieval。生产修法不止一种：

1. **关键词抽取**：先用 LLM 提关键词（"羽绒服"+"清洗"）再做 LIKE / 倒排
2. **embedding 召回**：用 text-embedding-3 / bge-large-zh 做语义召回（推荐）
3. **BM25 倒排**：传统 IR 方案

修完 retrieval（实测加上关键词抽取这一步），同样 50 条样本配 LLM judge（faithfulness / answer_relevancy 需要 judge router 配好）能跑到大致：

```
Context Precision  μ ≈ 0.67
Context Recall     μ ≈ 0.81
Faithfulness       μ ≈ 0.92
Answer Relevancy   μ ≈ 0.85
```

四个指标讲了四个故事：

1. **Recall 81% 但 Precision 67%** → retrieval 不够精准：top-3 里平均一条是无关文档
2. **Faithfulness 92%** → 模型基本忠于 context，少量幻觉
3. **Answer Relevancy 85%** → 大部分回答确实在答问题

但如果 retrieval recall < 80%，generation 再忠实也没用——你忠实地基于一堆错文档生成的答案，整体仍然是错的。这就是为什么 RAG 评测必须分层。

## 修复 retrieval 的方向

Recall 81% 怎么提？常见手段：

| 手段 | 预期提升 | 工程成本 |
|---|---|---|
| top-k 从 3 → 5 | recall +5-10% | 0（一行配置） |
| 加 query rewriting（让 LLM 改写 query） | recall +5-15% | 中（加一步 LLM 调用） |
| 加 reranker（cross-encoder） | precision +10-20% | 中（接 BGE-reranker） |
| 换 embedding 模型（small → large） | recall +3-8% | 低（费用增加 10x） |
| 切分粒度调小（chunk size） | recall +5% / precision -5% | 低 |

每个手段都该单独评测。**禁止"同时改 3 个变量然后看总分有没有提升"**——你不知道哪个生效了。第 19 章 CI 章节会讲怎么用矩阵评测做控制变量。

## "Agent 凭常识答"陷阱

回到第 5 章发现的 FM-1（知识库未触发）——agent 拿到"羊毛衫能机洗吗"这种问题，可能完全不调 `search_faq`，直接凭模型预训练知识答。

从 agent eval 视角（第 2 章的 `tool_call_match`）能抓到这个错。但**从 RAG 评测视角**抓不到——RAG 评测假设 retrieval 步骤已经发生了。两层评测互补：

- Agent 评测：catch "tool 没调"
- RAG 评测：catch "tool 调了但效果差"

第 19 章 CI 章节会讲怎么把这两层组合到一个 CI pipeline 里。

## Ragas 还有什么我们没做的

[Ragas](https://github.com/explodinggradients/ragas) 完整套件有 12+ 个指标。我们只做了核心 4 个，省略的：

| Ragas 指标 | 我们的处理 |
|---|---|
| Aspect Critique | 走 LLM-as-Judge 路线，第 13 章统一讲 |
| Noise Sensitivity | 高级话题，附录 A 提一下 |
| Multi-modal Faithfulness | 不覆盖（本书不涉及多模态） |
| SQL Faithfulness | 不覆盖（ShopAgent 不是 text-to-SQL agent） |
| Context Utilization | 实验性，未广泛采用 |
| Ragas score（综合） | 不推荐，单一数字会掩盖具体指标 |

读者要扩展直接调 Python Ragas，用 Python 端跑 RAG 评测后导出 JSONL 进 EvalKit 也可行。

## 对照 inspect_ai / Ragas 源码

| EvalKit RAG（这一章） | inspect_ai | Ragas |
|---|---|---|
| `rag/context_precision.ts` | 无内置（自己写 scorer） | `metrics/context_precision.py` |
| `rag/faithfulness.ts` | 无内置 | `metrics/faithfulness.py` |
| `rag/answer_relevancy.ts` | 无内置 | `metrics/answer_relevancy.py` |

inspect_ai 自己不做 RAG 专项——它定位是通用 eval 框架，社区有 [inspect_evals](https://github.com/UKGovernmentBEIS/inspect_evals) 项目独立实现 RAG eval task。我们的 EvalKit 把 RAG 指标内置到 `src/scorer/rag/` 是差异化加分项之一（中文电商 RAG 是 ShopAgent 主线场景）。

完整源码：

- Ragas faithfulness：`src/ragas/metrics/_faithfulness.py`（约 400 行）
- 我们的 TS 版：`examples/evalkit/src/scorer/rag/faithfulness.ts`（约 80 行，简化了几个边缘 case）

## 本章要点回顾

- **Ragas 四件套指标**：Context Precision/Recall（retrieval 层）+ Faithfulness/Answer Relevancy（generation 层），分层评测互补
- **Naive retrieval 的灾难**：仓库默认 SQL `LIKE %query%` 全词匹配在中文长 query 下 recall=10%。这是真实评测的产出，不是 bug
- **修 retrieval 的 3 条路**：关键词抽取 / embedding 召回 / BM25 倒排，从轻到重
- **Faithfulness 算法**：第一步 LLM 把回答拆成原子事实陈述，第二步逐条判断是否能从 context 推出
- **Judge 用便宜模型**：faithfulness 任务很窄（"这句话在 context 里有没有"），mini 级模型够；旗舰留给 policy / safety 这类宽场景

## 第 8 章总结

到这一步你拿到了：

- 两层 RAG 评测模型：retrieval（precision / recall）+ generation（faithfulness / relevancy）
- 4 个 Ragas 核心指标的 TS 实现（约 200 行）
- 50 条 RAG 评测集 + ShopAgent search_faq 子工具的真实分数（Recall 81% / Faithfulness 92%）
- 一份针对 retrieval 提升的工程改进 menu

下一章开始**用户模拟器**——给 ShopAgent 一个能装"急躁/啰嗦/隐瞒信息"的 LLM 用户，为多轮评测铺路。
