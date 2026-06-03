// appendix-d demo —— 跑 shopagent-extended 的 12 工具版评测
//
// 支持两种配置入口（书附录 D 正文里提到的）：
//   1. 环境变量 SHOPAGENT_VERSION=extended（默认就是 extended，因为这个 demo 本来就是为扩展版准备的；
//      留这个 env 是为了和主线版 shopagent 区分，未来同一个 demo 想同时接两种版本时只改 env 即可）
//   2. 命令行 flag --dataset <name>，可选值：l1-ext / l2-ext / l1（用主线 v2.0.0）/ l3。
//      不传时默认 l1-ext（如果存在，回退到 l1）。
//      读法：npm run eval -- --dataset l2-ext
import { existsSync } from 'node:fs';
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

// 解析 --dataset 参数（npm run eval -- --dataset xxx 会把 xxx 放进 process.argv）
function parseDatasetArg(): string {
  const idx = process.argv.indexOf('--dataset');
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return 'l1-ext';
}

// 把 dataset 名映射到具体文件路径，文件不存在时回退到主线 v2.0.0
function resolveDatasetPath(name: string): string {
  const datasetsDir = resolve(__dirname, '../../eval-datasets');
  const candidates: Record<string, string[]> = {
    'l1-ext': [`${datasetsDir}/l1/v2.0.0-ext.jsonl`, `${datasetsDir}/l1/v2.0.0.jsonl`],
    'l2-ext': [`${datasetsDir}/l2/v2.0.0-ext.jsonl`, `${datasetsDir}/l2/v2.0.0.jsonl`],
    l1: [`${datasetsDir}/l1/v2.0.0.jsonl`],
    l2: [`${datasetsDir}/l2/v2.0.0.jsonl`],
    l3: [`${datasetsDir}/l3/v1.0.0.jsonl`],
  };
  const paths = candidates[name] ?? candidates['l1-ext'];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  // 兜底
  return resolve(__dirname, '../../eval-datasets/l1/v2.0.0.jsonl');
}

// 让 SHOPAGENT_VERSION 显式声明读哪一版（目前 demo 强绑 extended，但留个开关供未来扩展）
const version = process.env.SHOPAGENT_VERSION ?? 'extended';
if (version !== 'extended') {
  console.warn(
    `[appendix-d] SHOPAGENT_VERSION=${version} 不是 extended，本 demo 当前仅实现 extended 路径，仍按 extended 跑。`,
  );
}

const datasetName = parseDatasetArg();
const datasetPath = resolveDatasetPath(datasetName);
console.log(`[appendix-d] 数据集：${datasetName} → ${datasetPath}`);

const extendedSolver: Solver = async (state) => {
  const userInput = typeof state.sample.input === 'string' ? state.sample.input : '';
  const result = await runExtendedShopAgent({ user_input: userInput, model: process.env.MODEL });
  state.toolCalls = result.tool_calls.map((tc) => ({ tool: tc.tool, args: tc.args }));
  state.output = { completion: result.response, steps: result.steps };
  return state;
};

const task = defineTask({
  name: `appendix-d-extended-12-tools-${datasetName}`,
  dataset: jsonlDataset(datasetPath, { limit: 20 }),
  solver: chain(useTools(allShopAgentTools), extendedSolver),
  scorer: [toolCallMatch(), trajectoryMatch({ mode: 'subset_ordered' })],
});

await runTask(task, {
  model: process.env.MODEL ?? 'gpt-4o-mini',
  outputDir: resolve(__dirname, '../runs'),
  concurrency: 4,
});
