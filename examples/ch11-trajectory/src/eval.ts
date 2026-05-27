// ch11 demo —— trajectory_match + db_state_delta
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defineTask,
  jsonlDataset,
  chain,
  useTools,
  toolCallMatch,
  trajectoryMatch,
  dbStateDelta,
  runTask,
  type Solver,
} from '@inferloop/evalkit';
import { runShopAgent, shopAgentTools, snapshotDb } from '@inferloop/shopagent';

const __dirname = dirname(fileURLToPath(import.meta.url));

const shopAgentWithSnapshotSolver: Solver = async (state) => {
  // 跑前快照
  state.metadata.before = snapshotDb();
  const userInput = typeof state.sample.input === 'string' ? state.sample.input : '';
  const result = await runShopAgent({ user_input: userInput, model: process.env.MODEL });
  state.toolCalls = result.tool_calls.map((tc) => ({ tool: tc.tool, args: tc.args }));
  state.output = { completion: result.response, steps: result.steps };
  // 跑后快照
  state.metadata.after = snapshotDb();
  return state;
};

// 用 stride 采样让 30 条覆盖各类别（前 60 条全是 query_order，要混入 refund / address / cancel）
const fullDataset = jsonlDataset(resolve(__dirname, '../../eval-datasets/l1/v2.0.0.jsonl'));
const TARGET_N = 30;
const stride = Math.max(1, Math.floor(fullDataset.size / TARGET_N));
const sampledSamples = fullDataset.samples.filter((_, i) => i % stride === 0).slice(0, TARGET_N);
const dataset = { ...fullDataset, samples: sampledSamples, size: sampledSamples.length };

const task = defineTask({
  name: 'ch11-trajectory',
  dataset,
  solver: chain(useTools(shopAgentTools), shopAgentWithSnapshotSolver),
  scorer: [toolCallMatch(), trajectoryMatch({ mode: 'subset_ordered' }), dbStateDelta()],
});

await runTask(task, {
  model: process.env.MODEL ?? 'gpt-4o-mini',
  outputDir: resolve(__dirname, '../runs'),
  concurrency: 2,
});
