// EvalLog Zod schema —— ch07 引入
// 每行 JSONL 在写入前过一遍 schema 校验，挂了快速失败而不是默默写脏数据
// 读取（view / diff）时也走 schema parse，能拿到强类型
import { z } from 'zod';

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({ name: z.string(), arguments: z.string() }),
      }),
    )
    .optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});

export const ToolCallSchema = z.object({
  tool: z.string(),
  args: z.record(z.unknown()),
  result: z.unknown().optional(),
});

export const ScoreSchema = z.object({
  value: z.union([z.literal('C'), z.literal('I'), z.literal('P'), z.number()]),
  answer: z.string().optional(),
  explanation: z.string().optional(),
  scorer: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const ModelOutputSchema = z.object({
  completion: z.string(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
  steps: z.number().optional(),
});

export const HeaderEntrySchema = z.object({
  type: z.literal('header'),
  taskName: z.string(),
  model: z.string(),
  datasetSize: z.number(),
  startedAt: z.string(),
  metadata: z.record(z.unknown()).optional(),
});

export const SampleEntrySchema = z.object({
  type: z.literal('sample'),
  sampleId: z.string(),
  epoch: z.number().optional(),
  scores: z.array(ScoreSchema),
  timingMs: z.number(),
  messages: z.array(ChatMessageSchema),
  toolCalls: z.array(ToolCallSchema),
  output: ModelOutputSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const FooterEntrySchema = z.object({
  type: z.literal('footer'),
  metrics: z.record(z.number()),
  completedAt: z.string(),
});

export const LogEntrySchema = z.discriminatedUnion('type', [
  HeaderEntrySchema,
  SampleEntrySchema,
  FooterEntrySchema,
]);

export type LogEntry = z.infer<typeof LogEntrySchema>;
export type HeaderEntry = z.infer<typeof HeaderEntrySchema>;
export type SampleEntry = z.infer<typeof SampleEntrySchema>;
export type FooterEntry = z.infer<typeof FooterEntrySchema>;
