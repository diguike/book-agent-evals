// ShopAgent 接口类型 —— 这是评测时看到的"外部契约"
// 内部实现细节不在书中展开（参考 CLAUDE.md 叙事铁律 1）

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
}

export interface ShopAgentRunInput {
  user_input: string;
  /** 对话历史（多轮时由调用方维护） */
  history?: ChatMessage[];
  /** 模型名，默认 process.env.MODEL ?? 'gpt-4o' */
  model?: string;
  temperature?: number;
  /** 工具调用循环最大步数 */
  maxSteps?: number;
}

export interface ShopAgentRunOutput {
  /** Agent 最终回复给用户的文本 */
  response: string;
  /** 本次 run 累积的工具调用序列（按调用先后） */
  tool_calls: ToolCallRecord[];
  /** 跑完后完整的消息序列，调用方下一轮可以塞回 history */
  messages: ChatMessage[];
  /** 模型用了几步 */
  steps: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant 消息上的工具调用 */
  tool_calls?: AssistantToolCall[];
  /** tool 消息回填的 tool_call_id */
  tool_call_id?: string;
  /** tool 消息上的工具名（OpenAI 协议） */
  name?: string;
}

export interface AssistantToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** OpenAI 兼容的 function-calling 工具定义 */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
