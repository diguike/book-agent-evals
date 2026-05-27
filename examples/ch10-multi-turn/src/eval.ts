// ch10 demo —— 多轮评测：脚本化 turns + session_completion / role_adherence / turn_efficiency
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defineTask,
  jsonlDataset,
  chain,
  multiTurn,
  sessionCompletion,
  turnEfficiency,
  runTask,
} from '@inferloop/evalkit';
import { runShopAgent, type ChatMessage } from '@inferloop/shopagent';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function runAgentTurn(
  userMessage: string,
  history: { user: string; agent: string }[],
): Promise<{ agentReply: string; toolCalls?: { tool: string; args: Record<string, unknown> }[] }> {
  const messages: ChatMessage[] = [];
  for (const h of history) {
    messages.push({ role: 'user', content: h.user });
    messages.push({ role: 'assistant', content: h.agent });
  }
  const r = await runShopAgent({
    user_input: userMessage,
    history: messages,
    model: process.env.MODEL,
  });
  return {
    agentReply: r.response,
    toolCalls: r.tool_calls.map((tc) => ({ tool: tc.tool, args: tc.args })),
  };
}

const task = defineTask({
  name: 'ch10-multi-turn',
  dataset: jsonlDataset(resolve(__dirname, '../../eval-datasets/l2/v2.0.0.jsonl'), { limit: 10 }),
  solver: chain(multiTurn({ runAgentTurn })),
  scorer: [sessionCompletion(), turnEfficiency()],
});

await runTask(task, {
  model: process.env.MODEL ?? 'gpt-4o-mini',
  outputDir: resolve(__dirname, '../runs'),
  concurrency: 2,
});
