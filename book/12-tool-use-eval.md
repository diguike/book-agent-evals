---
title: 第 12 章　工具调用评测
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/Ck8Bwa4JYiijcxkdY3YcDwGMnah"
last_synced: "2026-06-01T04:40:20Z"
---

## 本章你会拿到什么

> **跟 ch11 的衔接**：第 11 章评测 trajectory 整体的 outcome（这一条调用序列对不对、DB 最终状态对不对）。本章评测每次**单个工具调用**的参数格式 / 类型 / 延迟——粒度不同，两者互补。同一份评测集可以同时挂 ch11 的 trajectory_match + 本章的 schemaMatch，捕获不同维度的失败。

第 11 章拆出了 tool_call_match / trajectory_match / dbStateDelta 三件套。这一章往下挖一层，专门讲 **tool-use 评测的精细维度**：

1. 学会 **BFCL 的 4 层 tool-use 评测分类**——简单 / 多参数 / 多函数 / 并行
2. 拿到 **JSON Schema 参数校验** 的 EvalKit 实现，能抓到 agent 编造参数名 / 类型错误的细微问题
3. 看清楚**工具描述质量对 tool-use 准确率的影响**——同样的模型，工具描述改一遍 pass^1 能涨 5-10 个点
4. 学会评测**国产模型的 function calling 差异**——Claude / GPT 稳定 JSON，部分国产模型会返回 markdown 代码块

代码增量：`examples/evalkit/src/scorer/tool_use/`（新建子目录）。

## BFCL 的 4 层分类

[Berkeley Function-Calling Leaderboard](https://gorilla.cs.berkeley.edu/leaderboard.html) 把 tool-use 评测分成 4 个难度递增的层级。我们对照 ShopAgent 场景重新理解：

| BFCL 层级 | 描述 | ShopAgent 例子 |
|---|---|---|
| L1 simple | 一个函数 + 简单参数 | `get_order(order_id="o_99812")` |
| L2 multiple | 一个函数 + 多参数（含可选） | `refund_order(order_id="o_99812", amount=199, reason="user_request")` |
| L3 parallel | 一次调用多个函数 | 同时 `get_order` + `get_user` 拼接信息 |
| L4 multi-turn | 跨轮工具调用，前面的结果影响后面 | 第 11 章 trajectory eval 已覆盖 |

我们前面的章节已经 cover 了 L1 / L2 / L4。这一章重点补 **L3 并行调用** + **参数 schema 精细校验**。

## 参数 schema 校验：超越"参数名是否匹配"

EvalKit 第 2 章的 score 函数对工具参数只做了"key-value 部分匹配"。但 tool-use 的细微问题：

1. **参数类型错**：`amount` 应该是 number，agent 传了 "199"（string）
2. **参数名拼写错**：应该是 `order_id`，agent 传了 `orderId`
3. **参数值范围错**：`topK` 应该 ≥ 1，agent 传了 0
4. **必填参数漏**：`refund_order` 必填 `reason`，agent 没传
5. **未声明参数多**：agent 传了工具定义里没的 `priority` 字段

这些问题用"key-value 匹配"抓不到。需要 JSON Schema 校验。

每个工具的定义包含 JSON Schema：

```ts
// examples/shopagent/src/tools/refund_order.ts
export const refundOrderTool: ToolDef = {
  name: 'refund_order',
  description: '发起退款。退款金额必须 ≤ 订单金额，且订单状态必须允许退款（pending/shipped/delivered）',
  parameters: {
    type: 'object',
    properties: {
      order_id: { type: 'string', pattern: '^o_[0-9]+$' },
      amount: { type: 'number', minimum: 0, exclusiveMaximum: 1000000 },
      reason: { type: 'string', enum: ['user_request', 'quality_issue', 'wrong_item', 'other'] },
    },
    required: ['order_id', 'amount', 'reason'],
    additionalProperties: false,
  },
};
```

EvalKit 的 `toolSchemaScorer`：

```ts
// examples/evalkit/src/scorer/tool_use/schema_match.ts
import Ajv from 'ajv';  // [Ajv](https://github.com/ajv-validator/ajv)：Node 生态事实标准的 JSON Schema 校验库

const ajv = new Ajv({ allErrors: true, strict: false });

export function toolSchemaMatch(toolDefs: ToolDef[]): Scorer {
  const validators = new Map(toolDefs.map((t) => [t.name, ajv.compile(t.parameters)]));

  return async (state) => {
    const violations: string[] = [];

    for (const call of state.toolCalls) {
      const validator = validators.get(call.tool);
      if (!validator) {
        violations.push(`未知工具：${call.tool}`);
        continue;
      }
      if (!validator(call.args)) {
        const errors = validator.errors?.map((e) => `${e.instancePath} ${e.message}`).join(', ');
        violations.push(`${call.tool} 参数不符合 schema：${errors}`);
      }
    }

    return {
      scorerName: 'tool_schema_match',
      value: violations.length === 0 ? 'C' : 'I',
      explanation: violations.join('; '),
    };
  };
}
```

80 行。用 Ajv 做 JSON Schema 校验，能抓到所有上面列的 5 类问题。

## 实测：tool_call_match vs tool_schema_match

跑 L1 stride 抽样 20 条看两者差距（Claude Sonnet 4.5 via mock-llm-server）：

```
tool_call_match:      13/20 (65.0%)
tool_schema_match:    20/20 (100.0%)
overlap:              13/20
```

mock-server 后端的 Claude 在 schema 合法性上几乎完美——所有调用都是合法 JSON。**这里看到的差异（tool_call_match 65% vs schema_match 100%）反映：失败模式不是 schema 违反，而是"该调的工具没调"**。

historical 数据点：作者在生产中跑 OpenAI / DeepSeek 时见过 schema 违反样本（参数 enum 不符、字段名 typo、额外字段），那种场景下 tool_schema_match 才能多抓到几条 tool_call_match 看不到的问题。常见情况：

- `refund_order.reason` 传自由文本"user wants refund"，不在 enum 里
- `add_note.order_id` 传 "99812"（少 `o_` 前缀），违反 pattern
- `refund_order` 传多余字段 `priority="urgent"`，违反 additionalProperties

这些 agent 调对了工具、传对了 key-value，但参数值不符合工具定义的 schema——**生产中会导致后端 reject，但用 tool_call_match 抓不到**。两个 scorer 互补使用，配合不同模型 / 后端时能定位的失败模式不同。

## 工具描述质量：被低估的优化点

ShopAgent 的 8 个工具，写完之后大家不太回头看工具描述。但**工具描述质量直接影响 tool-use 准确率**。

举个对比。原 `refund_order` 描述：

```
description: '发起退款'
```

改进版：

```
description: '发起订单退款。要求：
1. 调用前必须先用 get_order 确认订单存在并获取实际订单金额
2. amount 参数必须等于 get_order 返回的订单金额，不允许使用用户对话中提到的金额
3. 订单状态必须是 pending / shipped / delivered 之一
4. 退款是不可逆操作，调用前必须用自然语言向用户二次确认（"确认要退款 X 元吗？"）'
```

跑 L1-60 对比两个描述（Claude Sonnet 4.5 via mock-llm-server，stride 抽样混合 20 条覆盖各类工具调用）：

```
原描述:        tool_call_match pass^1 = 65.0%   (13/20)
改进描述:      tool_call_match pass^1 = 80.0%   (16/20)   (+15 个百分点)
```

> 注：本仓库 demo 默认跑了"原描述"基线（见 `examples/ch12-tool-use/runs/`）。改进描述跑出来的 80% 是作者本地实测，复现要把 `examples/shopagent/src/tools/index.ts` 里 refund_order 的 description 换成上面"改进版"。

工具描述里"教会模型如何使用工具"比"修改 system prompt"更直接、更聚焦。这是 Hamel 在 Maven 课里反复强调的：**Specification gap 的一大块在工具描述上**，不是 system prompt 上。

EvalKit 没有自动"评测工具描述质量"的 scorer——这是个开放问题。但你可以用 A/B 评测对比两种描述：

```bash
# baseline
DESC_VERSION=v1 npm run eval

# 改进版
DESC_VERSION=v2 npm run eval

# diff
evalkit diff runs/baseline runs/v2
```

## 国产模型的 function calling 差异

Claude / GPT 的 function calling 实现成熟，返回严格 JSON。**部分国产模型在 tool-use 上有兼容问题**：

| 模型 | function calling 模式 | 实测问题 |
|---|---|---|
| GPT-4o | 原生 tool_calls | 几乎无问题 |
| Claude Sonnet 4.5 | 原生 tool_use blocks | 几乎无问题 |
| DeepSeek V3 | OpenAI 兼容 tool_calls | 偶尔返回 markdown 代码块包裹 JSON |
| Qwen3-Max | 原生 + OpenAI 兼容 | 早期版本 JSON 字段名偶尔英中混杂 |
| GLM-4.5 | OpenAI 兼容 | 大致 OK |
| 文心 4.5 | 自有 protocol（不完全 OpenAI 兼容）| 需要特殊适配 |

为了让 EvalKit 兼容这些差异，`generate` solver 加了 fallback parser：

```ts
// examples/evalkit/src/solver/generate.ts —— tool_calls 解析增强
function extractToolCalls(content: string, rawToolCalls?: any[]): ToolCall[] {
  // 优先用原生 tool_calls
  if (rawToolCalls?.length) {
    return rawToolCalls.map((tc) => ({
      tool: tc.function?.name ?? tc.name,
      args: typeof tc.function?.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : (tc.function?.arguments ?? tc.input),
    }));
  }

  // Fallback: 从文本里提取 ```json ... ``` 代码块
  const jsonBlock = content.match(/```json\n([\s\S]*?)\n```/);
  if (jsonBlock) {
    try {
      const parsed = JSON.parse(jsonBlock[1]);
      if (Array.isArray(parsed)) return parsed;
      if (parsed.tool && parsed.args) return [parsed];
      if (parsed.function_call) return [{ tool: parsed.function_call.name, args: parsed.function_call.arguments }];
    } catch (e) {
      // 解析失败，继续 fallback
    }
  }

  return [];
}
```

50 行 fallback 让国产模型也能跑通 EvalKit。**这是中文 / 国产模型场景下评测的真实工程问题，英文书里基本不讲**。

> 数据点：作者在生产中跑 DeepSeek V3 时，关掉 fallback parser 时 tool-use 准确率约 38%（很多挂的样本是 markdown 代码块包裹 JSON 被原生 parser 丢弃），开 fallback 后涨到 71%——大头不是模型能力，是输出格式标准化。本仓库 `examples/mock-llm-server` 后端是 Claude 不复现这个问题，要看真实数字建议自行接 DeepSeek API。

## L3 并行调用：能力 vs 收益

并行 tool calls 是 2024-2025 模型能力升级：一次回复里返回多个 tool_calls。OpenAI 称 "parallel tool calling"。

ShopAgent 里典型场景：

```
用户: 给我看一下订单 o_99812 和 o_77543 的状态
Agent: [tool_calls: get_order(o_99812), get_order(o_77543)]  // 一次调两个
```

评测并行调用：

```jsonc
{
  "id": "L1-parallel-001",
  "user_input": "给我看一下订单 o_99812 和 o_77543 的状态",
  "expected_tool_calls": [
    { "tool": "get_order", "args_match": { "order_id": "o_99812" }, "parallel": true },
    { "tool": "get_order", "args_match": { "order_id": "o_77543" }, "parallel": true }
  ],
  "max_parallel_round": 1   // 期望一轮内完成
}
```

`parallel: true` 表示这些调用允许在同一轮内。如果 agent 拆成两轮（先调一个再调另一个），算 partial 而不是 fail。

并行不是必须——单轮顺序调多次也能完成任务，但**会多消耗 API token + 慢一些**。所以 turn_efficiency scorer 会扣分。

跑 ShopAgent on L1-60 含若干并行 case，作者在多 provider 上做过横评（部分基于历史 OpenAI / DeepSeek key 跑出来的数据，本仓库默认 mock-server 复现的是 Claude 单 provider）：

| 模型 | 并行 case pass^1（近似）| 平均轮数 |
|---|---|---|
| Claude Sonnet 4.5 | 100% | 1.0 |
| GPT-4o | 80% | 1.2 |
| DeepSeek V3 | 60% | 1.4 |
| GPT-4o-mini | 40% | 1.8 |
| Claude Haiku 4.5 | 80%（via mock-server） | 1.1 |

并行 tool calls 是模型层差异，prompt 改善有限——选模型阶段就要考虑。Claude Sonnet/Opus 这一代在并行调用上明显比"mini 级"模型强。

## 工具调用的 latency 评测

到目前为止评测都看正确性。但生产场景下 **latency 也是评测维度**——agent 调一次工具 5 秒和 0.5 秒，用户体验差距很大。

EvalKit 在 EvalLog 里默认记录 `timingMs`，但只是总时间。要细化到每个 tool call 的 latency，新增 `latencyScorer`：

```ts
// examples/evalkit/src/scorer/tool_use/latency.ts
export function toolLatency(opts: { thresholdMs: number }): Scorer {
  return async (state) => {
    const slowCalls = state.toolCallTimings?.filter((t) => t.durationMs > opts.thresholdMs) ?? [];
    if (slowCalls.length === 0) {
      return { scorerName: 'tool_latency', value: 'C' };
    }
    return {
      scorerName: 'tool_latency',
      value: 'P',
      explanation: `${slowCalls.length} 个调用超过 ${opts.thresholdMs}ms：${slowCalls.map((c) => `${c.tool}(${c.durationMs}ms)`).join(', ')}`,
    };
  };
}
```

ShopAgent 工具的 latency 基线（mock SQLite，没网络 IO）：

- `get_order` / `get_user`：~5ms（SQLite read）
- `search_faq`：~150ms（embedding lookup + top-k）
- `refund_order` / `cancel_order` / `update_shipping_address`：~10ms（SQLite write）
- `add_note`：~5ms
- `escalate_to_human`：~3ms

生产场景这些数字会大 10-100 倍。第 20 章上生产章节会讨论怎么把 latency 评测纳入 CI 守门。

## EvalKit 的 tool-use scorer 总览

到这一章 EvalKit 的 scorer 已经有：

| Scorer | 测什么 | 引入章节 |
|---|---|---|
| match / includes | 回复内容 | ch3 |
| tool_call_match | 工具调用 + 参数 key-value 部分匹配 | ch3 |
| tool_schema_match | 参数严格 JSON Schema 校验 | 本章 |
| trajectory_match | 工具调用序列 + before/forbidden | ch11 |
| dbStateDelta | DB 最终状态 | ch11 |
| context_precision / recall | RAG 检索质量 | ch8 |
| faithfulness / answer_relevancy | RAG 生成质量 | ch8 |
| session_completion | 多轮任务完成 | ch10 |
| role_adherence | agent 不跑偏 | ch10 |
| turn_efficiency | 轮数效率 | ch10 |
| tool_latency | 工具调用 latency | 本章 |

11 个 scorer。每个 scorer 单独看一个维度，组合起来形成完整评测画像。

## 对照 inspect_ai / BFCL 源码

| EvalKit | inspect_ai | BFCL |
|---|---|---|
| `scorer/tool_use/schema_match.ts` | `scorer/_metrics/` 自定义 | `eval_runner.py` AST 评测 |
| Fallback parser (国产模型) | 无（专注 frontier 模型） | 无 |
| `scorer/tool_use/latency.ts` | `stats.modelUsage.timings` | 无 |

BFCL 的 evaluation runner 用 AST 比对——把 agent 返回的工具调用 string parse 成 Python AST，跟 ground truth AST 对比。这种方式更严格但对模型输出格式要求高。我们用 JSON Schema 更宽容，对国产模型友好。

## 本章要点回顾

- **BFCL 4 层分类**：simple / multiple params / multiple functions / parallel，难度递增
- **schemaMatch ≠ tool_call_match**：前者抓"agent 调对了但参数 schema 违反"（enum / pattern / additionalProperties），后者抓"该调的没调"
- **工具描述是被低估的优化点**：同样模型 + 同样数据，工具描述改一遍 pass^1 能涨 5-15 个百分点
- **国产模型 function calling 差异**：DeepSeek / Qwen 早期版本可能返回 markdown 代码块包裹 JSON，需要 fallback parser
- **并行 tool calls 是模型层差异**：Sonnet 4.5 / GPT-4o 强，mini 级弱（80% vs 40%），prompt 改善有限

## 第 12 章总结

到这一步 tool-use 评测的 6 个维度全部覆盖：

1. 工具是否被调
2. 工具名是否正确
3. 参数 key-value 是否部分匹配（tool_call_match）
4. 参数是否符合 JSON Schema（tool_schema_match）
5. 调用序列是否符合约束（trajectory_match）
6. 并行 / latency 表现

下一章进入 LLM-as-Judge 入门——评测里最有争议但又最不可缺的一种 scorer。

---

> 本章来自《AI Agent 评测工程实战》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev) · 反馈与勘误：[GitHub Issues](https://github.com/diguike/book-agent-evals/issues)
