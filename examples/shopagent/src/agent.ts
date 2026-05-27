// ShopAgent 主入口：runShopAgent —— OpenAI tool-calling 循环
// 评测时由 EvalKit Solver 包装调用
import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { shopAgentTools } from './tools/index.js';
import { executeTool } from './tools/impl.js';
import { SYSTEM_PROMPT } from './prompt.js';
import type {
  ShopAgentRunInput,
  ShopAgentRunOutput,
  ChatMessage,
  ToolCallRecord,
} from './types.js';

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

function toOpenAITools(): ChatCompletionTool[] {
  return shopAgentTools.map((t) => ({
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
        (base as { tool_calls?: ChatCompletionMessageToolCall[] }).tool_calls = m.tool_calls.map(
          (tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          }),
        );
      }
      return base;
    }
    if (m.role === 'system') {
      return { role: 'system', content: m.content } as ChatCompletionMessageParam;
    }
    return { role: 'user', content: m.content } as ChatCompletionMessageParam;
  });
}

function safeParseJson(input: string): Record<string, unknown> {
  try {
    return JSON.parse(input) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function runShopAgent(input: ShopAgentRunInput): Promise<ShopAgentRunOutput> {
  const model = input.model ?? process.env.MODEL ?? 'gpt-4o';
  const temperature = input.temperature ?? 0;
  const maxSteps = input.maxSteps ?? 8;

  const messages: ChatMessage[] = [];

  // 1. 拼消息：system + history + 新一轮 user input
  if (!input.history || input.history.length === 0) {
    messages.push({ role: 'system', content: SYSTEM_PROMPT });
  } else {
    messages.push(...input.history);
  }
  messages.push({ role: 'user', content: input.user_input });

  const toolCallRecords: ToolCallRecord[] = [];
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
    if (!choice) {
      throw new Error('OpenAI 返回空 choices');
    }
    const msg = choice.message;

    // 把 assistant 消息塞回 messages（带 tool_calls 如果有）
    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: msg.content ?? '',
    };
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      assistantMsg.tool_calls = msg.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }
    messages.push(assistantMsg);

    // 没有工具调用 = 结束
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      finalText = msg.content ?? '';
      break;
    }

    // 执行每个工具调用，把结果塞回 messages
    for (const tc of msg.tool_calls) {
      const args = safeParseJson(tc.function.arguments);
      let result: unknown;
      try {
        result = executeTool(tc.function.name, args);
      } catch (err) {
        result = { error: 'tool_execution_failed', message: (err as Error).message };
      }
      toolCallRecords.push({
        tool: tc.function.name,
        args,
        result,
      });
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.function.name,
        content: JSON.stringify(result),
      });
    }
  }

  if (!finalText && steps >= maxSteps) {
    finalText = '[超出工具调用步数上限，请稍后再试或转人工]';
  }

  return {
    response: finalText,
    tool_calls: toolCallRecords,
    messages,
    steps,
  };
}
