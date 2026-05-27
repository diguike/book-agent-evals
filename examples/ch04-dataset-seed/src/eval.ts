// ch04 demo —— 招牌菜 1A：用 60 条种子评测集跑一次
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

// 招牌菜 1A 真实做法：从 200 条按类别均匀采 60 条种子
// 用 stride 抽样让 60 条覆盖各 category（前 60 条全是 query_order 不能代表混合场景）
const fullDataset = jsonlDataset(resolve(__dirname, '../../eval-datasets/l1/v2.0.0.jsonl'));
const TARGET_N = 60;
const stride = Math.max(1, Math.floor(fullDataset.size / TARGET_N));
const sampledSamples = fullDataset.samples.filter((_, i) => i % stride === 0).slice(0, TARGET_N);
const dataset = { ...fullDataset, samples: sampledSamples, size: sampledSamples.length };

const task = defineTask({
  name: 'ch04-l1-seed-60-mixed',
  dataset,
  solver: chain(useTools(shopAgentTools), shopAgentSolver),
  scorer: [toolCallMatch(), includes()],
});

await runTask(task, {
  model: process.env.MODEL ?? 'gpt-4o-mini',
  concurrency: 4,
  outputDir: resolve(__dirname, '../runs'),
});
