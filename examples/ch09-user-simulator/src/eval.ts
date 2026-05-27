// ch09 demo —— user simulator：用 LLM 模拟用户跟 agent 对话
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defineTask,
  jsonlDataset,
  chain,
  userSimulator,
  sessionCompletion,
  turnEfficiency,
  runTask,
  type Solver,
} from '@inferloop/evalkit';
import { runShopAgent } from '@inferloop/shopagent';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 包一个 runAgentTurn：直接调 runShopAgent 单轮
async function runAgentTurn(userMessage: string): Promise<{ agentReply: string; toolCalls?: { tool: string; args: Record<string, unknown> }[] }> {
  const r = await runShopAgent({ user_input: userMessage, model: process.env.MODEL });
  return { agentReply: r.response, toolCalls: r.tool_calls.map((tc) => ({ tool: tc.tool, args: tc.args })) };
}

const simSolver: Solver = userSimulator({
  model: process.env.SIM_MODEL ?? 'gpt-4o-mini',
  maxTurns: 6,
  runAgentTurn,
});

const task = defineTask({
  name: 'ch09-user-simulator',
  dataset: jsonlDataset(resolve(__dirname, '../../eval-datasets/l2/v2.0.0.jsonl'), { limit: 5 }),
  solver: chain(simSolver),
  scorer: [sessionCompletion(), turnEfficiency()],
});

await runTask(task, {
  model: process.env.MODEL ?? 'gpt-4o-mini',
  outputDir: resolve(__dirname, '../runs'),
  concurrency: 2,
});
