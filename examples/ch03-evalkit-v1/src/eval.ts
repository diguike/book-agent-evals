// ch03 demo —— 用 EvalKit v1 接口跑 ch02 的同一份评测集，验证抽象成立
// 跑：npm run eval
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defineTask,
  jsonlDataset,
  chain,
  useTools,
  generate,
  toolCallMatch,
  includes,
  runTask,
  type Solver,
} from '@inferloop/evalkit';
import { runShopAgent, shopAgentTools } from '@inferloop/shopagent';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 把 ShopAgent 包成一个 Solver
const shopAgentSolver: Solver = async (state) => {
  const userInput = typeof state.sample.input === 'string' ? state.sample.input : '';
  const result = await runShopAgent({ user_input: userInput, model: process.env.MODEL });
  state.toolCalls = result.tool_calls.map((tc) => ({ tool: tc.tool, args: tc.args, result: tc.result }));
  state.messages.push({ role: 'user', content: userInput });
  state.messages.push({ role: 'assistant', content: result.response });
  state.output = { completion: result.response, steps: result.steps };
  return state;
};

const task = defineTask({
  name: 'ch03-evalkit-v1-rerun',
  dataset: jsonlDataset(
    resolve(__dirname, '../../ch02-hello-world/datasets/l1-seed-10.jsonl'),
    {
      fieldMap: { input: 'user_input' },
    },
  ),
  solver: chain(useTools(shopAgentTools), shopAgentSolver, generate({ toolCalls: 'none' })),
  scorer: [toolCallMatch(), includes()],
});

// 数据集里 expected_tool_calls / expected_response_contains 是顶层字段，
// jsonl loader 会把它们扔进 metadata；scorer 要 Target 形态
for (const s of task.dataset.samples) {
  const meta = s.metadata ?? {};
  s.target = {
    expectedToolCalls: (meta.expected_tool_calls as never) ?? [],
    expectedResponseContains: (meta.expected_response_contains as never) ?? [],
  };
}

await runTask(task, {
  model: process.env.MODEL ?? 'gpt-4o',
  outputDir: resolve(__dirname, '../runs'),
});
