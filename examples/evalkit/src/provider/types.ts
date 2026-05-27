// Provider 抽象 —— 把"调 LLM"这一步从 generate solver 中分离
// 对照 inspect_ai: src/inspect_ai/model/_providers/*
import type { ChatMessage, AssistantToolCall } from '../types.js';
import type { ToolDef } from '../solver/use_tools.js';

export interface ProviderRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
  /** 用于缓存命中判断的额外字段 */
  seed?: number;
}

export interface ProviderResponse {
  content: string;
  tool_calls?: AssistantToolCall[];
  /** stop / length / tool_calls / content_filter / ... */
  finish_reason?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  /** 真实 provider 返回的原始字段（debug 用） */
  raw?: unknown;
}

export interface Provider {
  /** provider 标识（openai / anthropic / openai_compatible） */
  readonly name: string;
  /** 这个 provider 能处理哪些 model 名字（用前缀匹配） */
  supports(model: string): boolean;
  /** 真实 LLM 调用 */
  complete(req: ProviderRequest): Promise<ProviderResponse>;
}
