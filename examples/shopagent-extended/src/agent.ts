// 扩展版 agent：合并主线 8 工具 + 扩展 4 工具，并用扩展 system prompt
// 复用主线 OpenAI 客户端逻辑
import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import {
  shopAgentTools,
  type ShopAgentRunInput,
  type ShopAgentRunOutput,
  type ChatMessage,
  type ToolCallRecord,
} from '@inferloop/shopagent';
// 这里也直接重导出主线 tools impl
import { extraTools } from './tools/extra.js';
import { executeExtraTool } from './tools/extra_impl.js';
import { EXTENDED_SYSTEM_PROMPT } from './prompt.js';
// 主线 8 工具的 executor 通过 dist 引入，避免循环 import
// （examples/shopagent 已经先 build 出 dist）
import { runShopAgent as _runMainline } from '@inferloop/shopagent';

let cachedClient: OpenAI | null = null;
function getClient(): OpenAI {
  if (!cachedClient) {
    cachedClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    });
  }
  return cachedClient;
}

const mainlineToolNames = new Set(shopAgentTools.map((t) => t.function.name));

const allTools = [...shopAgentTools, ...extraTools];

function toOpenAITools(): ChatCompletionTool[] {
  return allTools.map((t) => ({
    type: 'function',
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters as Record<string, unknown>,
    },
  }));
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

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// 主线 8 工具的同步 executor —— 直接调主线包暴露的 executeTool
import { executeTool as executeMainlineTool } from '@inferloop/shopagent';

void _runMainline; // 保留导入便于诊断（避免 unused warning）

export async function runExtendedShopAgent(input: ShopAgentRunInput): Promise<ShopAgentRunOutput> {
  const model = input.model ?? process.env.MODEL ?? 'gpt-4o';
  const temperature = input.temperature ?? 0;
  const maxSteps = input.maxSteps ?? 10;

  const messages: ChatMessage[] = [];
  if (!input.history || input.history.length === 0) {
    messages.push({ role: 'system', content: EXTENDED_SYSTEM_PROMPT });
  } else {
    messages.push(...input.history);
  }
  messages.push({ role: 'user', content: input.user_input });

  const toolCalls: ToolCallRecord[] = [];
  const client = getClient();
  const tools = toOpenAITools();

  let steps = 0;
  let finalText = '';

  while (steps < maxSteps) {
    steps += 1;
    const completion: ChatCompletion = await client.chat.completions.create({
      model,
      temperature,
      messages: toOpenAIMessages(messages),
      tools,
      tool_choice: 'auto',
    });
    const choice = completion.choices[0];
    if (!choice) throw new Error('OpenAI 返回空 choices');
    const msg = choice.message;

    const assistantMsg: ChatMessage = { role: 'assistant', content: msg.content ?? '' };
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      assistantMsg.tool_calls = msg.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
    }
    messages.push(assistantMsg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      finalText = msg.content ?? '';
      break;
    }

    for (const tc of msg.tool_calls) {
      const args = safeParse(tc.function.arguments);
      let result: unknown;
      try {
        if (mainlineToolNames.has(tc.function.name)) {
          result = executeMainlineTool(tc.function.name, args);
        } else {
          result = executeExtraTool(tc.function.name, args);
        }
      } catch (err) {
        result = { error: 'tool_execution_failed', message: (err as Error).message };
      }
      toolCalls.push({ tool: tc.function.name, args, result });
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.function.name,
        content: JSON.stringify(result),
      });
    }
  }

  if (!finalText && steps >= maxSteps) {
    finalText = '[超出工具调用步数上限]';
  }

  return { response: finalText, tool_calls: toolCalls, messages, steps };
}
