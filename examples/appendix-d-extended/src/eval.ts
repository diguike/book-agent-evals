// appendix-d demo —— 跑 shopagent-extended 的 12 工具版评测
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defineTask,
  jsonlDataset,
  chain,
  useTools,
  toolCallMatch,
  trajectoryMatch,
  runTask,
  type Solver,
} from '@inferloop/evalkit';
import { runExtendedShopAgent, allShopAgentTools } from '@inferloop/shopagent-extended';

const __dirname = dirname(fileURLToPath(import.meta.url));

const extendedSolver: Solver = async (state) => {
  const userInput = typeof state.sample.input === 'string' ? state.sample.input : '';
  const result = await runExtendedShopAgent({ user_input: userInput, model: process.env.MODEL });
  state.toolCalls = result.tool_calls.map((tc) => ({ tool: tc.tool, args: tc.args }));
  state.output = { completion: result.response, steps: result.steps };
  return state;
};

const task = defineTask({
  name: 'appendix-d-extended-12-tools',
  dataset: jsonlDataset(resolve(__dirname, '../../eval-datasets/l1/v2.0.0.jsonl'), { limit: 20 }),
  solver: chain(useTools(allShopAgentTools), extendedSolver),
  scorer: [toolCallMatch(), trajectoryMatch({ mode: 'subset_ordered' })],
});

await runTask(task, {
  model: process.env.MODEL ?? 'gpt-4o-mini',
  outputDir: resolve(__dirname, '../runs'),
  concurrency: 4,
});
