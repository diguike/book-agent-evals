// Anthropic provider —— Claude 系列模型
// 用动态 import 兜底没装 @anthropic-ai/sdk 的情况（这是本书选装依赖）
import type { Provider, ProviderRequest, ProviderResponse } from './types.js';
import type { ChatMessage, AssistantToolCall } from '../types.js';

interface AnthropicProviderOpts {
  apiKey?: string;
  baseURL?: string;
  modelPrefixes?: string[];
}

interface AnthropicClient {
  messages: {
    create(params: Record<string, unknown>): Promise<AnthropicResponse>;
  };
}

interface AnthropicResponse {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

let cachedSdk: { Anthropic: new (opts: Record<string, unknown>) => AnthropicClient } | null = null;
async function loadSdk(): Promise<typeof cachedSdk> {
  if (cachedSdk) return cachedSdk;
  try {
    // 用变量绕开 TS 的静态依赖解析，让 @anthropic-ai/sdk 变成"按需可选依赖"
    const pkg = '@anthropic-ai/sdk';
    const mod = (await import(/* @vite-ignore */ pkg)) as {
      default?: new (opts: Record<string, unknown>) => AnthropicClient;
      Anthropic?: new (opts: Record<string, unknown>) => AnthropicClient;
    };
    const Anthropic = mod.default ?? mod.Anthropic;
    if (!Anthropic) throw new Error('@anthropic-ai/sdk 没有 default / Anthropic 导出');
    cachedSdk = { Anthropic };
    return cachedSdk;
  } catch (err) {
    throw new Error(
      `调用 Anthropic 模型需要先装 @anthropic-ai/sdk：npm install @anthropic-ai/sdk\n原因：${(err as Error).message}`,
    );
  }
}

function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
} {
  let system: string | undefined;
  const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];

  for (const m of messages) {
    if (m.role === 'system') {
      system = (system ? system + '\n\n' : '') + m.content;
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id ?? '',
            content: m.content,
          },
        ],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      if (m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          let inputObj: Record<string, unknown> = {};
          try {
            inputObj = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            // 忽略 parse 错
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: inputObj,
          });
        }
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: 'user', content: m.content });
  }
  return { ...(system !== undefined ? { system } : {}), messages: out };
}

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private opts: AnthropicProviderOpts;
  private client: AnthropicClient | undefined;
  private prefixes: string[];

  constructor(opts: AnthropicProviderOpts = {}) {
    this.opts = opts;
    this.prefixes = opts.modelPrefixes ?? ['claude-'];
  }

  supports(model: string): boolean {
    return this.prefixes.some((p) => model.startsWith(p));
  }

  private async getClient(): Promise<AnthropicClient> {
    if (this.client) return this.client;
    const sdk = await loadSdk();
    if (!sdk) throw new Error('Anthropic SDK 加载失败');
    this.client = new sdk.Anthropic({
      apiKey: this.opts.apiKey ?? process.env.ANTHROPIC_API_KEY,
      ...(this.opts.baseURL ? { baseURL: this.opts.baseURL } : {}),
    });
    return this.client;
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const client = await this.getClient();
    const { system, messages } = toAnthropicMessages(req.messages);
    const params: Record<string, unknown> = {
      model: req.model,
      messages,
      max_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0,
    };
    if (system !== undefined) params.system = system;
    if (req.tools && req.tools.length > 0) {
      params.tools = req.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters as Record<string, unknown>,
      }));
    }

    const resp = await client.messages.create(params);

    const tool_calls: AssistantToolCall[] = [];
    let textContent = '';
    for (const block of resp.content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        tool_calls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    const out: ProviderResponse = {
      content: textContent,
      finish_reason: resp.stop_reason,
      raw: resp,
    };
    if (tool_calls.length > 0) out.tool_calls = tool_calls;
    if (resp.usage) {
      out.usage = {
        prompt_tokens: resp.usage.input_tokens,
        completion_tokens: resp.usage.output_tokens,
        total_tokens:
          (resp.usage.input_tokens ?? 0) + (resp.usage.output_tokens ?? 0),
      };
    }
    return out;
  }
}
