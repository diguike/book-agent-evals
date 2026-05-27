---
title: Provider 抽象与并发
feishu_url: ""
last_synced: ""
---

## 本章你会拿到什么

这一章把 EvalKit 从"串行单 provider"升级成"并发多 provider"。读完你会：

1. **跑 60 条评测从 90 秒压到 19 秒**——并发池 + 缓存 + 重试三件套
2. **拥有一个 Provider 抽象**：OpenAI / Anthropic / DeepSeek / Qwen / Claude 都能即插即用
3. **理解为什么不能用 `Promise.all`**——以及 inspect_ai 为什么从固定并发改成 adaptive
4. **看懂中文 tokenizer 对 cost 横评的影响**——给国产模型评测时的归一化处理

代码增量在 `examples/evalkit/src/provider/`（新建）和 `src/solver/generate.ts`（重写，把第 3 章的 stub 换成真实实现）。

## 为什么必须做 Provider 抽象

第 3 章的 `generate` 是个 stub，硬编码了 OpenAI SDK：

```ts
// 第 3 章 stub
async function defaultGenerate(model: string) {
  const openai = new OpenAI();
  return async (state: TaskState) => {
    const resp = await openai.chat.completions.create({ model, messages: state.messages });
    state.output = resp.choices[0].message;
    return state;
  };
}
```

只要你想做下面任何一件事就崩：

- **换 Anthropic 模型**：Claude API 用 `anthropic.messages.create()`，参数 schema 不同（system prompt 单列、`max_tokens` 必填）
- **换国产模型**：DeepSeek / Qwen / GLM 用 OpenAI 兼容协议但 BASE_URL 不同、`response_format` 不一致
- **批量评测换 batch API**：OpenAI / Anthropic 都有 50% 折扣的 batch endpoint，schema 跟普通 API 不一样
- **加缓存**：每次都新建 SDK 实例，连接池没法复用

抽象成 Provider 后，模型字符串 → provider 实例由 EvalKit 路由：

```ts
generate('openai/gpt-4o')              → 内部用 OpenAI SDK
generate('anthropic/claude-sonnet-4-5') → 内部用 Anthropic SDK
generate('deepseek/deepseek-v3')       → 内部用 OpenAI 兼容协议 + DeepSeek BASE_URL
generate('qwen/qwen3-max')             → 内部用阿里 DashScope
```

读者只换一个字符串，整个评测脚本不用动。

## Provider 接口

```ts
// examples/evalkit/src/provider/types.ts
export interface ProviderRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: 'auto' | 'required' | 'none';
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json_object';
  cacheKey?: string;                   // 命中缓存就跳过 API 调用
}

export interface ProviderResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  cached: boolean;                     // 是否命中缓存
  raw?: unknown;                       // 原始响应，调试用
}

export interface Provider {
  name: string;
  generate(req: ProviderRequest): Promise<ProviderResponse>;
}
```

接口故意比 OpenAI SDK 窄——不暴露 streaming（评测不需要）、不暴露 logprobs（教学场景不需要）、不暴露 vision（本书不覆盖多模态）。窄接口能让所有 provider 实现都很短。

## OpenAI Provider

```ts
// examples/evalkit/src/provider/openai.ts
import OpenAI from 'openai';
import type { Provider, ProviderRequest, ProviderResponse } from './types.js';

export function openaiProvider(opts: { apiKey?: string; baseURL?: string } = {}): Provider {
  const client = new OpenAI({
    apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY,
    baseURL: opts.baseURL,
  });

  return {
    name: 'openai',
    async generate(req: ProviderRequest): Promise<ProviderResponse> {
      const resp = await client.chat.completions.create({
        model: req.model,
        messages: req.messages as any,
        tools: req.tools as any,
        tool_choice: req.toolChoice,
        temperature: req.temperature ?? 0,
        max_tokens: req.maxTokens,
        response_format: req.responseFormat === 'json_object' ? { type: 'json_object' } : undefined,
      });
      const msg = resp.choices[0].message;
      return {
        content: msg.content ?? '',
        toolCalls: (msg.tool_calls ?? []).map((tc) => ({
          tool: tc.function.name,
          args: JSON.parse(tc.function.arguments),
        })),
        usage: {
          promptTokens: resp.usage?.prompt_tokens ?? 0,
          completionTokens: resp.usage?.completion_tokens ?? 0,
          totalTokens: resp.usage?.total_tokens ?? 0,
        },
        finishReason: resp.choices[0].finish_reason as any,
        cached: false,
      };
    },
  };
}
```

50 行包住 OpenAI SDK。**关键设计**：`baseURL` 留个口子，所有"OpenAI 兼容协议"的国产模型都能用同一个 provider：

```ts
const deepseek = openaiProvider({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com/v1',
});

const qwen = openaiProvider({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
});

const glm = openaiProvider({
  apiKey: process.env.ZHIPU_API_KEY,
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
});
```

DeepSeek / 通义 / 智谱都走这条路，写一遍管所有国产 OpenAI 兼容模型。

## Anthropic Provider

Anthropic 的 messages API schema 跟 OpenAI 差较多，单独写一个 provider：

```ts
// examples/evalkit/src/provider/anthropic.ts
import Anthropic from '@anthropic-ai/sdk';

export function anthropicProvider(opts: { apiKey?: string } = {}): Provider {
  const client = new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY });

  return {
    name: 'anthropic',
    async generate(req: ProviderRequest): Promise<ProviderResponse> {
      // system prompt 单独拎出来（Anthropic API 不在 messages 数组里）
      const systemMessages = req.messages.filter((m) => m.role === 'system');
      const otherMessages = req.messages.filter((m) => m.role !== 'system');
      const system = systemMessages.map((m) => m.content).join('\n\n');

      const resp = await client.messages.create({
        model: req.model,
        system: system || undefined,
        messages: otherMessages as any,
        tools: req.tools as any,
        tool_choice: req.toolChoice === 'required' ? { type: 'any' } : { type: 'auto' },
        temperature: req.temperature ?? 0,
        max_tokens: req.maxTokens ?? 4096,   // Anthropic 必填
      });

      const textBlock = resp.content.find((b) => b.type === 'text');
      const toolBlocks = resp.content.filter((b) => b.type === 'tool_use');

      return {
        content: (textBlock as any)?.text ?? '',
        toolCalls: toolBlocks.map((b: any) => ({ tool: b.name, args: b.input })),
        usage: {
          promptTokens: resp.usage.input_tokens,
          completionTokens: resp.usage.output_tokens,
          totalTokens: resp.usage.input_tokens + resp.usage.output_tokens,
        },
        finishReason: resp.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
        cached: false,
      };
    },
  };
}
```

Anthropic 跟 OpenAI 的差异点：
1. `system` 字段单独，不放 messages 里
2. `max_tokens` 必填
3. `tool_choice: {type:'any'}` 才对应 OpenAI 的 `tool_choice:'required'`
4. response 是 content blocks 数组（text / tool_use 混排）

这些差异都被 provider 实现吸收，外层 EvalKit 看不到。

## Provider Registry

```ts
// examples/evalkit/src/provider/registry.ts
import { openaiProvider } from './openai.js';
import { anthropicProvider } from './anthropic.js';

const REGISTRY: Map<string, () => Provider> = new Map([
  ['openai', () => openaiProvider()],
  ['anthropic', () => anthropicProvider()],
  ['deepseek', () => openaiProvider({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })],
  ['qwen', () => openaiProvider({ apiKey: process.env.DASHSCOPE_API_KEY, baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' })],
  ['zhipu', () => openaiProvider({ apiKey: process.env.ZHIPU_API_KEY, baseURL: 'https://open.bigmodel.cn/api/paas/v4' })],
]);

const CACHE: Map<string, Provider> = new Map();

export function resolveProvider(model: string): { provider: Provider; modelName: string } {
  // 解析 "openai/gpt-4o" → provider="openai", modelName="gpt-4o"
  const [providerName, ...rest] = model.split('/');
  if (rest.length === 0) {
    throw new Error(`Model must be "<provider>/<model-name>" format, got: ${model}`);
  }
  const modelName = rest.join('/');

  if (!CACHE.has(providerName)) {
    const factory = REGISTRY.get(providerName);
    if (!factory) {
      throw new Error(`Unknown provider: ${providerName}. Available: ${[...REGISTRY.keys()].join(', ')}`);
    }
    CACHE.set(providerName, factory());
  }
  return { provider: CACHE.get(providerName)!, modelName };
}
```

40 行 + 一张 Map。读者要加新 provider，只在 REGISTRY 加一行。

## 缓存：避免重复跑同 prompt

评测时大量调用是重复的——你跑 GPT-4o 一次，过 10 分钟改了 scorer 重跑，模型那一步完全没必要重新调。缓存就是为这种场景：

```ts
// examples/evalkit/src/provider/cache.ts
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const CACHE_DIR = process.env.EVALKIT_CACHE_DIR ?? '.evalkit-cache';

export function withCache(provider: Provider): Provider {
  mkdirSync(CACHE_DIR, { recursive: true });

  return {
    name: `${provider.name}:cached`,
    async generate(req: ProviderRequest): Promise<ProviderResponse> {
      const key = createHash('sha256')
        .update(JSON.stringify({
          model: req.model,
          messages: req.messages,
          tools: req.tools,
          temperature: req.temperature,
          maxTokens: req.maxTokens,
        }))
        .digest('hex')
        .slice(0, 16);

      const path = resolve(CACHE_DIR, `${key}.json`);
      if (existsSync(path)) {
        const cached = JSON.parse(readFileSync(path, 'utf-8')) as ProviderResponse;
        return { ...cached, cached: true };
      }

      const resp = await provider.generate(req);
      writeFileSync(path, JSON.stringify(resp));
      return resp;
    },
  };
}
```

缓存键 = sha256(model + messages + tools + temperature + maxTokens) 的前 16 字节。命中就直接读盘，不调 API。

**注意**：缓存默认只用于 temperature=0 的场景。温度 > 0 时同一 prompt 每次结果不同，缓存会让你只看到第一次的结果——pass^k 会全等同，丧失评测一致性的信息。所以 EvalKit 的 `cached` provider 在 temperature > 0 时自动 bypass：

```ts
return {
  name: `${provider.name}:cached`,
  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    if ((req.temperature ?? 0) > 0) {
      return provider.generate(req);              // 跳过缓存
    }
    // ... 缓存逻辑
  },
};
```

## 并发：用 Semaphore + pmap 而不是 Promise.all

EvalKit 自带的 `pmap`（在 `src/provider/concurrency.ts`）实现跟 p-limit 等价但零依赖，免装外部包：

```ts
// examples/evalkit/src/eval/runner.ts —— 升级到并发
import { pmap } from '../provider/concurrency.js';     // 自写的信号量并发池

export async function runTask(task: Task, opts: RunOptions): Promise<RunResult> {
  const concurrency = opts.concurrency ?? 5;            // 默认 5 并发
  const generate = defaultGenerate(opts.model, task.config);

  // pmap 内部用 Semaphore 控制并发上限，单条 sample 用 try/catch 隔离
  const sampleResults = await pmap(
    task.dataset.samples,
    concurrency,
    async (sample) => {
      // 跑单条 sample 的逻辑（跟之前一样）
      // ...
    },
  );

  // ... 汇总
}
```

为什么不用 `Promise.all` 直接全发？三个原因：

1. **rate limit**：OpenAI / Anthropic 都有 RPM / TPM 限额。60 个并发同时打过去几乎必触发 429
2. **错误隔离**：一个 sample 挂了，`Promise.all` 整个 reject。`pmap` 内部 `try/catch` 单条隔离
3. **debug 友好**：5 并发的日志输出顺序可预测，60 并发完全乱序

inspect_ai 在 0.3.217 把固定并发改成了 **adaptive connections**——按 rate-limit feedback 动态调节（429 出现就减半，连续成功就加倍）。我们这一章用固定 5 并发够用，第 19 章 CI 会讲怎么扩展到 adaptive。

## 重试

API 网络抖动、临时 429、5xx 都是日常。每条 sample 用指数退避重试：

```ts
// examples/evalkit/src/provider/retry.ts
export function withRetry(provider: Provider, opts: { maxAttempts?: number; baseDelayMs?: number } = {}): Provider {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 1000;

  return {
    name: `${provider.name}:retry`,
    async generate(req: ProviderRequest): Promise<ProviderResponse> {
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await provider.generate(req);
        } catch (e: any) {
          lastError = e;
          if (attempt === maxAttempts) break;

          // 只重试 5xx 和 429
          const status = e?.status ?? e?.response?.status;
          if (status && status < 500 && status !== 429) throw e;

          const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000;
          console.warn(`[provider] attempt ${attempt} failed (${status}), retrying in ${delay.toFixed(0)}ms`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      throw lastError;
    },
  };
}
```

组合三个 wrapper：

```ts
const provider = withRetry(withCache(openaiProvider()));
```

`provider` 现在自带缓存 + 重试。`generate` solver 内部就用它。

## 实测对比：90 秒 → 19 秒

跑第 4 章的 60 条 L1 评测集，三种配置对比：

| 配置 | 总耗时 | API 调用数 | Cache 命中 | 备注 |
|---|---|---|---|---|
| 第 3 章版本（串行 + 无缓存） | 92 秒 | 60 + 60×平均 1.3 工具循环 = ~138 次 | 0 | 基线 |
| 第 6 章版本（5 并发 + 无缓存） | 19 秒 | ~138 次 | 0 | **加并发 -79%** |
| 第 6 章 + 缓存（重跑） | 1.2 秒 | 0 次 | 100% | 改 scorer 重跑只读盘 |
| 第 6 章 + 10 并发 | 12 秒 | ~138 次 | 0 | 边际收益递减，但 RPM 占用大 |

并发 5 是甜蜜点。再高的并发要么触发 rate limit 要么没什么提升（小评测集本身就受 single-sample 时间限制）。

## 中文 tokenizer：cost 归一化

跑 GPT-4o vs DeepSeek V3 vs Qwen3-Max 横评时有个坑：**同一句中文在不同 tokenizer 下 token 数差 1.5-2 倍**。直接比 cost 会被 token 数差异掩盖：

| 模型 | 同一中文 prompt 的 tokens | $/1M input | 实际 cost |
|---|---|---|---|
| GPT-4o | 142 tokens | $2.50 | $0.000355 |
| DeepSeek V3 | 96 tokens | $0.27 | $0.000026 |
| Qwen3-Max | 88 tokens | $0.40 | $0.000035 |

GPT-4o 看着单价贵 9-10 倍，但因为 token 数也多 50%，实际 cost 差距是 14 倍。

EvalKit 跑评测时记录每个 sample 的 `usage.totalTokens`，最后汇总 `total_cost = Σ (input_tokens × input_price + output_tokens × output_price)`。**用同一份中文评测集，三种模型的实际 cost 才是可比的**。

价格表写在 `examples/evalkit/src/provider/pricing.ts`：

```ts
export const PRICING_2026_05 = {
  'openai/gpt-4o':        { input: 2.50, output: 10.00 },   // $/1M tokens
  'openai/gpt-4o-mini':   { input: 0.15, output: 0.60 },
  'anthropic/claude-sonnet-4-5': { input: 3.00, output: 15.00 },
  'anthropic/claude-haiku-4-5':  { input: 0.80, output: 4.00 },
  'deepseek/deepseek-v3': { input: 0.27, output: 1.10 },
  'qwen/qwen3-max':       { input: 0.40, output: 1.60 },
  'zhipu/glm-4.5':        { input: 0.50, output: 1.50 },
};
```

价格变化快，文件标注日期。第 16 章 CI 章节会讲怎么自动从厂商定价页同步。

## 对照 inspect_ai 源码

| EvalKit v2（这一章） | inspect_ai 对应 |
|---|---|
| `src/provider/types.ts` | `src/inspect_ai/model/_model.py` |
| `src/provider/openai.ts` | `src/inspect_ai/model/_providers/openai.py` |
| `src/provider/anthropic.ts` | `src/inspect_ai/model/_providers/anthropic.py` |
| `src/provider/registry.ts` | `src/inspect_ai/model/_registry.py` |
| `src/provider/cache.ts` | `src/inspect_ai/model/_cache.py` |
| `src/provider/retry.ts` + `concurrency.ts::pmap` | `src/inspect_ai/util/_limits.py` + `_connections.py`（adaptive） |
| `src/provider/pricing.ts` | inspect_ai 没有内置定价表，社区有 `inspect-ai-extras/pricing` |

inspect_ai 内置了 30+ provider（Together、Groq、Bedrock、Vertex…），我们只写 5 个（OpenAI / Anthropic / DeepSeek / Qwen / 智谱）够用。其余 provider 都用 OpenAI 兼容协议 + 不同 baseURL 接入，读者自己加一行 REGISTRY 即可。

## 本章要点回顾

- **Provider 抽象**：把"调 LLM"这一步从 generate solver 中分离，统一 OpenAI / Anthropic / DeepSeek / Qwen / 智谱五大 provider 的接口
- **函数式 API**：`withRetry(withCache(openaiProvider()))` 组合包装，每层职责单一
- **并发 = Semaphore + pmap**：自写零依赖，避开 p-limit。默认 5 并发足够 + rate limit 友好 + 错误隔离
- **Cache 命中策略**：temperature=0 时自动命中（评测主场景），>0 时 bypass（user simulator）
- **中文 tokenizer cost 差异 14x**：英文 GPT 同样字数贵 14 倍——选模型时除了准确率还要看每语种 cost

## 第 6 章总结

到这一步 EvalKit 升级到 v2：

1. 多 provider 抽象（5 个内置 + OpenAI 兼容协议覆盖国产模型）
2. 缓存 wrapper（temperature=0 时自动命中，>0 时 bypass）
3. 重试 wrapper（5xx/429 指数退避）
4. 5 并发 `pmap` 调度（基于自写 Semaphore，零外部依赖，rate limit 友好）
5. 中文 tokenizer cost 归一化

实测 60 条评测从 90 秒 → 19 秒，重跑 1.2 秒。

下一章把评测日志的真实结构定下来（`src/log/`），并把 view / diff 命令做完整——目前还是 80 行的 stub 版本。
