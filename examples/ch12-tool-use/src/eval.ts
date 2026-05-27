// ch12 demo —— schemaMatch + latencyScorer
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defineTask,
  jsonlDataset,
  chain,
  useTools,
  schemaMatch,
  latencyScorer,
  toolCallMatch,
  runTask,
  type Solver,
} from '@inferloop/evalkit';
import { runShopAgent, shopAgentTools } from '@inferloop/shopagent';

const __dirname = dirname(fileURLToPath(import.meta.url));

const shopAgentSolver: Solver = async (state) => {
  const t0 = Date.now();
  const userInput = typeof state.sample.input === 'string' ? state.sample.input : '';
  const result = await runShopAgent({ user_input: userInput, model: process.env.MODEL });
  state.toolCalls = result.tool_calls.map((tc) => ({ tool: tc.tool, args: tc.args }));
  state.output = { completion: result.response, steps: result.steps };
  state.metadata.timingMs = Date.now() - t0;
  return state;
};

// stride 采样：从 200 条均匀取 20 条覆盖各类别
const fullDataset = jsonlDataset(resolve(__dirname, '../../eval-datasets/l1/v2.0.0.jsonl'));
const TARGET_N = 20;
const stride = Math.max(1, Math.floor(fullDataset.size / TARGET_N));
const sampledSamples = fullDataset.samples.filter((_, i) => i % stride === 0).slice(0, TARGET_N);
const dataset = { ...fullDataset, samples: sampledSamples, size: sampledSamples.length };

const task = defineTask({
  name: 'ch12-tool-use',
  dataset,
  solver: chain(useTools(shopAgentTools), shopAgentSolver),
  scorer: [toolCallMatch(), schemaMatch({ mode: 'lax' }), latencyScorer()],
});

// 给所有样本设 latency 阈值 5 秒
for (const s of task.dataset.samples) {
  if (typeof s.target === 'object' && !Array.isArray(s.target) && s.target !== null) {
    (s.target as Record<string, unknown>).expectedMaxLatencyMs = 5000;
  }
}

await runTask(task, {
  model: process.env.MODEL ?? 'gpt-4o-mini',
  outputDir: resolve(__dirname, '../runs'),
  concurrency: 4,
});
