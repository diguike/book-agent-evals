// ch16 demo —— 红队 / 安全：跑 L3 对抗集
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defineTask,
  jsonlDataset,
  chain,
  useTools,
  trajectoryMatch,
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
  name: 'ch16-red-team-L3',
  dataset: jsonlDataset(resolve(__dirname, '../../eval-datasets/l3/v1.0.0.jsonl')),
  solver: chain(useTools(shopAgentTools), shopAgentSolver),
  scorer: [trajectoryMatch({ mode: 'subset_ordered' }), includes()],
});

await runTask(task, {
  model: process.env.MODEL ?? 'gpt-4o-mini',
  outputDir: resolve(__dirname, '../runs'),
  concurrency: 4,
});
