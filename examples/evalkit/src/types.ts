// EvalKit 核心类型定义 —— 全书共享的接口契约
// 接口稳定性承诺（见 book/03-evalkit-skeleton.md）：v1 定下的接口在后续 17 章只加字段、不改签名
// 对照 inspect_ai: src/inspect_ai/_eval/task/task.py + dataset/_dataset.py + solver/_task_state.py

// ─── 消息 ────────────────────────────────────────────────────────

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: Role;
  content: string;
  /** 仅 assistant 消息可能有 */
  tool_calls?: AssistantToolCall[];
  /** 仅 tool 消息必有 */
  tool_call_id?: string;
  /** 工具名（OpenAI 协议在 tool 消息上带） */
  name?: string;
}

export interface AssistantToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// ─── 工具调用 ────────────────────────────────────────────────────

/** 跑完一次评测后，从 agent run 里抽出来的工具调用记录 */
export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
}

/** 评测集里写的"期望调到的工具调用" */
export interface ExpectedToolCall {
  tool: string;
  args_match?: Record<string, unknown>;
  /** 同一个工具允许多次匹配中的第几次（默认匹配第一次） */
  occurrence?: number;
  /** 严格度：'exact' 要求所有键匹配，'subset'（默认）只要求 args_match 列出的键匹配 */
  match_mode?: 'exact' | 'subset';
}

// ─── 模型输出 ────────────────────────────────────────────────────

export interface ModelOutput {
  /** 模型最终回复给用户的文本 */
  completion: string;
  /** 可选：模型用量统计，第 6 章会用 */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  /** 可选：模型生成步数（多 step 工具调用时） */
  steps?: number;
}

// ─── Sample / Dataset ───────────────────────────────────────────

export interface Sample {
  id: string;
  /** 用户输入：单条文本或对话 */
  input: string | ChatMessage[];
  /** 期望答案，scorer 用 */
  target?: Target;
  metadata?: Record<string, unknown>;
  // ch08 / ch10 / ch11 等会按需用 metadata 携带额外字段（context / setup / before 等），先不硬编码
}

export type Target =
  | string
  | string[]
  | {
      expectedToolCalls?: ExpectedToolCall[];
      expectedResponseContains?: string[];
      /** 后续章节会加：expectedTrajectory / expectedDbState 等，先用 metadata 兜底 */
      [k: string]: unknown;
    };

export interface Dataset {
  name?: string;
  samples: Sample[];
  size: number;
}

/** 数据集列名 ↔ Sample 字段名 的映射 */
export type FieldMap = {
  id?: string;
  input?: string;
  target?: string;
  metadata?: string;
};

// ─── Solver / TaskState / Generate ──────────────────────────────

export interface TaskState {
  sample: Sample;
  /** 对话历史（含 system / user / assistant / tool） */
  messages: ChatMessage[];
  /** 最近一次模型输出 */
  output?: ModelOutput;
  /** 累积的工具调用 */
  toolCalls: ToolCall[];
  metadata: Record<string, unknown>;
  /** solver 设为 true 提前结束链 */
  completed: boolean;
  /** 当前 epoch（pass^k 时多次跑同一 sample，ch15 会用） */
  epoch?: number;
}

export interface GenerateOpts {
  /** 工具调用策略：loop 一直跑到模型不再调工具 / single 只跑一轮 / none 跳过工具 */
  toolCalls?: 'loop' | 'single' | 'none';
  /** 模型温度，覆盖 task config */
  temperature?: number;
}

export type GenerateFn = (state: TaskState, opts?: GenerateOpts) => Promise<TaskState>;

export type Solver = (state: TaskState, generate: GenerateFn) => Promise<TaskState>;

// ─── Scorer / Score ─────────────────────────────────────────────

export type ScoreValue = 'C' | 'I' | 'P' | number;

export interface Score {
  /** Correct / Incorrect / Partial / 数值 */
  value: ScoreValue;
  /** 提取出来的答案（match scorer 用） */
  answer?: string;
  /** 不通过原因 / 评分依据 */
  explanation?: string;
  /** scorer 名字（runner 自动填） */
  scorer?: string;
  metadata?: Record<string, unknown>;
}

export type Scorer = (state: TaskState, target: Target) => Promise<Score>;

// 给 Scorer 加个 name 属性方便 runner 自动填 scorer 字段
export interface NamedScorer extends Scorer {
  scorerName?: string;
}

// ─── Task ───────────────────────────────────────────────────────

export interface TaskConfig {
  temperature?: number;
  maxTokens?: number;
  /** 同一 sample 跑几次（pass^k），ch15 会用 */
  epochs?: number;
  /** 单次 agent run 内消息上限 */
  messageLimit?: number;
  /** 单次 agent run 内工具调用次数上限 */
  toolCallLimit?: number;
}

export interface Task {
  name: string;
  dataset: Dataset;
  solver: Solver | Solver[];
  scorer: Scorer | Scorer[];
  config?: TaskConfig;
  /** 可选：task 级别元数据，会落进 EvalLog header */
  metadata?: Record<string, unknown>;
}

// ─── 工具：判断 target 形式 ──────────────────────────────────────

export function targetIsObject(
  t: Target | undefined,
): t is Extract<Target, Record<string, unknown>> {
  return typeof t === 'object' && t !== null && !Array.isArray(t);
}
