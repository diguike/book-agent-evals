// OpenAI 官方 + OpenAI 兼容协议 provider
// 兼容协议覆盖 DeepSeek / Qwen (通义) / 智谱 / Moonshot / ...，只是换 BASE_URL
import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { Provider, ProviderRequest, ProviderResponse } from './types.js';
import type { ChatMessage } from '../types.js';

interface OpenAIProviderOpts {
  apiKey?: string;
  baseURL?: string;
  /** name 字段，便于路由日志区分 */
  name?: string;
  /** model 前缀匹配：默认 ['gpt-', 'o1', 'o3', 'o4'] */
  modelPrefixes?: string[];
  /** model 全字面匹配（兼容协议接其他厂商时填具体模型名） */
  modelExact?: string[];
}

function toOpenAIMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        tool_call_id: m.tool_call_id ?? '',
      } as ChatCompletionMessageParam;
    }
    if (m.role === 'assistant') {
      const base: ChatCompletionMessageParam = {
        role: 'assistant',
        content: m.content || null,
      } as ChatCompletionMessageParam;
      if (m.tool_calls && m.tool_calls.length > 0) {
        (base as { tool_calls?: unknown }).tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }));
      }
      return base;
    }
    if (m.role === 'system') {
      return { role: 'system', content: m.content } as ChatCompletionMessageParam;
    }
    return { role: 'user', content: m.content } as ChatCompletionMessageParam;
  });
}

export class OpenAIProvider implements Provider {
  readonly name: string;
  private clientOpts: { apiKey?: string; baseURL?: string };
  private clientCached: OpenAI | undefined;
  private prefixes: string[];
  private exact: string[];

  constructor(opts: OpenAIProviderOpts = {}) {
    this.name = opts.name ?? 'openai';
    this.prefixes = opts.modelPrefixes ?? ['gpt-', 'o1', 'o3', 'o4'];
    this.exact = opts.modelExact ?? [];
    this.clientOpts = {
      ...(opts.apiKey || process.env.OPENAI_API_KEY
        ? { apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY }
        : {}),
      ...(opts.baseURL || process.env.OPENAI_BASE_URL
        ? { baseURL: opts.baseURL ?? process.env.OPENAI_BASE_URL ?? undefined }
        : {}),
    };
  }

  private get client(): OpenAI {
    if (!this.clientCached) {
      if (!this.clientOpts.apiKey) {
        throw new Error(
          `${this.name} provider 缺少 API key（请在仓库根 .env 配置 OPENAI_API_KEY 或对应 provider 的 key）`,
        );
      }
      this.clientCached = new OpenAI(this.clientOpts);
    }
    return this.clientCached;
  }

  supports(model: string): boolean {
    if (this.exact.includes(model)) return true;
    return this.prefixes.some((p) => model.startsWith(p));
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const tools: ChatCompletionTool[] | undefined = req.tools?.map((t) => ({
      type: 'function',
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters as Record<string, unknown>,
      },
    }));

    const params: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(req.messages),
      temperature: req.temperature ?? 0,
    };
    if (tools && tools.length > 0) {
      params.tools = tools;
      params.tool_choice = 'auto';
    }
    if (req.maxTokens) params.max_tokens = req.maxTokens;
    if (req.seed !== undefined) params.seed = req.seed;

    const completion = (await this.client.chat.completions.create(
      params as unknown as Parameters<OpenAI['chat']['completions']['create']>[0],
    )) as ChatCompletion;

    const choice = completion.choices[0];
    if (!choice) throw new Error(`${this.name} 返回空 choices`);
    const msg = choice.message;

    const resp: ProviderResponse = {
      content: msg.content ?? '',
      finish_reason: choice.finish_reason,
      raw: completion,
    };
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      resp.tool_calls = msg.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
    }
    if (completion.usage) {
      resp.usage = {
        prompt_tokens: completion.usage.prompt_tokens,
        completion_tokens: completion.usage.completion_tokens,
        total_tokens: completion.usage.total_tokens,
      };
    }
    return resp;
  }
}

/** DeepSeek：OpenAI 兼容协议，BASE_URL=https://api.deepseek.com/v1，model=deepseek-chat/deepseek-reasoner */
export function deepseekProvider(apiKey?: string): OpenAIProvider {
  return new OpenAIProvider({
    name: 'deepseek',
    apiKey: apiKey ?? process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY,
    baseURL: 'https://api.deepseek.com/v1',
    modelPrefixes: ['deepseek-'],
  });
}

/** 阿里通义千问：OpenAI 兼容协议 */
export function qwenProvider(apiKey?: string): OpenAIProvider {
  return new OpenAIProvider({
    name: 'qwen',
    apiKey: apiKey ?? process.env.DASHSCOPE_API_KEY ?? process.env.OPENAI_API_KEY,
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelPrefixes: ['qwen-', 'qwen2-', 'qwen3-'],
  });
}

/** 智谱 GLM：OpenAI 兼容协议 */
export function zhipuProvider(apiKey?: string): OpenAIProvider {
  return new OpenAIProvider({
    name: 'zhipu',
    apiKey: apiKey ?? process.env.ZHIPU_API_KEY ?? process.env.OPENAI_API_KEY,
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    modelPrefixes: ['glm-'],
  });
}
