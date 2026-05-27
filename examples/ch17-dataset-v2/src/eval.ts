// ch17 demo —— 招牌菜 1B：把 L1 v2 跑一遍完整 200 条
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defineTask,
  jsonlDataset,
  chain,
  useTools,
  toolCallMatch,
  includes,
  runTask,
  type Solver,
} from '@inferloop/evalkit';
import { runShopAgent, shopAgentTools } from '@inferloop/shopagent';

const __dirname = dirname(fileURLToPath(import.meta.url));

const shopAgentSolver: Solver = async (state) => {
  const userInput = typeof state.sample.input === 'string' ? state.sample.input : '';
  const result = await runShopAgent({ user_input: userInput, model: process.env.MODEL });
  state.toolCalls = result.tool_calls.map((tc) => ({ tool: tc.tool, args: tc.args }));
  state.output = { completion: result.response, steps: result.steps };
  return state;
};

const task = defineTask({
  name: 'ch17-l1-v2',
  dataset: jsonlDataset(resolve(__dirname, '../../eval-datasets/l1/v2.0.0.jsonl')),
  solver: chain(useTools(shopAgentTools), shopAgentSolver),
  scorer: [toolCallMatch(), includes()],
});

await runTask(task, {
  model: process.env.MODEL ?? 'gpt-4o-mini',
  outputDir: resolve(__dirname, '../runs'),
  concurrency: 8,
});
