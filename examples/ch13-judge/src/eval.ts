// ch13 demo —— LLM-as-Judge：用 modelGraded 给 agent 回复评分
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defineTask,
  jsonlDataset,
  chain,
  useTools,
  modelGraded,
  getDefaultRouter,
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

const judgeModel = process.env.JUDGE_MODEL ?? 'gpt-4o';
const router = getDefaultRouter();

const task = defineTask({
  name: 'ch13-judge',
  dataset: jsonlDataset(resolve(__dirname, '../../eval-datasets/l1/v2.0.0.jsonl'), { limit: 10 }),
  solver: chain(useTools(shopAgentTools), shopAgentSolver),
  scorer: [
    modelGraded({
      judgeRouter: router,
      judgeModel,
      rubric:
        '回复必须：(1) 客服身份 (2) 正确处理订单 (3) 不违反 policy (4) 不泄露其他用户隐私',
    }),
  ],
});

await runTask(task, {
  model: process.env.MODEL ?? 'gpt-4o-mini',
  outputDir: resolve(__dirname, '../runs'),
  concurrency: 2,
});
