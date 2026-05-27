// ch06 demo —— Provider 抽象：用 ProviderRouter + 并发 + cache 跑同一份评测集
// 对比启用 cache 前后的总耗时差异
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
  ProviderRouter,
  FileCache,
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

// 演示：自定义 Router（关掉 cache）
const router = new ProviderRouter({
  cache: { dir: resolve(__dirname, '../.cache'), disabled: process.env.NO_CACHE === '1' },
  retry: { maxAttempts: 3 },
});
void router;

const task = defineTask({
  name: 'ch06-provider-concurrent',
  dataset: jsonlDataset(resolve(__dirname, '../../eval-datasets/l1/v2.0.0.jsonl'), { limit: 30 }),
  solver: chain(useTools(shopAgentTools), shopAgentSolver),
  scorer: [toolCallMatch(), includes()],
});

const t0 = Date.now();
const result = await runTask(task, {
  model: process.env.MODEL ?? 'gpt-4o-mini',
  concurrency: parseInt(process.env.CONCURRENCY ?? '4', 10),
  outputDir: resolve(__dirname, '../runs'),
});
console.log(`[ch06] 整体耗时 ${Date.now() - t0}ms（并发=${process.env.CONCURRENCY ?? 4}）`);
console.log(`[ch06] cache 状态：${process.env.NO_CACHE === '1' ? '关' : '开'}`);
void result;

console.log('\n[ch06] 提示：再跑一次（cache 命中）应该明显更快。');
console.log('       NO_CACHE=1 npm run eval 可以关掉 cache 对比。');
