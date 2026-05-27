// ch15 demo —— pass^k：同一 sample 跑 8 次，看一致性
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
  multiTrialAnalysis,
  formatPassKTable,
  type Solver,
} from '@inferloop/evalkit';
import { runShopAgent, shopAgentTools } from '@inferloop/shopagent';

const __dirname = dirname(fileURLToPath(import.meta.url));

const shopAgentSolver: Solver = async (state) => {
  const userInput = typeof state.sample.input === 'string' ? state.sample.input : '';
  const result = await runShopAgent({
    user_input: userInput,
    model: process.env.MODEL,
    temperature: 1, // 故意拉高 temp 看一致性
  });
  state.toolCalls = result.tool_calls.map((tc) => ({ tool: tc.tool, args: tc.args }));
  state.output = { completion: result.response, steps: result.steps };
  return state;
};

const task = defineTask({
  name: 'ch15-pass-k',
  dataset: jsonlDataset(resolve(__dirname, '../../eval-datasets/l1/v2.0.0.jsonl'), { limit: 5 }),
  solver: chain(useTools(shopAgentTools), shopAgentSolver),
  scorer: [toolCallMatch(), includes()],
});

const result = await runTask(task, {
  model: process.env.MODEL ?? 'gpt-4o-mini',
  outputDir: resolve(__dirname, '../runs'),
  concurrency: 4,
  epochs: 8, // 同一 sample 跑 8 次
});

const report = multiTrialAnalysis(result, [1, 2, 4, 8]);
console.log('\n[ch15] pass^k 曲线（n=' + report.trials + '）');
console.log(formatPassKTable(report));
