// 第 2 章 Hello World 评测 —— EvalKit minimal
// 配套书章节：book/02-hello-world-eval.md
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runShopAgent } from '@inferloop/shopagent';

const __dirname = dirname(fileURLToPath(import.meta.url));

// —— 1. 加载数据集 ——
interface Sample {
  id: string;
  user_input: string;
  expected_tool_calls: { tool: string; args_match: Record<string, unknown> }[];
  expected_response_contains: string[];
}

function loadDataset(path: string): Sample[] {
  const lines = readFileSync(path, 'utf-8').trim().split('\n');
  return lines.map((line) => JSON.parse(line) as Sample);
}

// —— 2. 跑被测对象 ——
interface AgentRun {
  response: string;
  tool_calls: { tool: string; args: Record<string, unknown> }[];
}

async function runAgent(sample: Sample, model: string): Promise<AgentRun> {
  return await runShopAgent({
    user_input: sample.user_input,
    model,
    temperature: 0,
  });
}

// —— 3. 打分 ——
interface Score {
  value: 'C' | 'I';
  reasons: string[];
}

function score(sample: Sample, run: AgentRun): Score {
  const reasons: string[] = [];

  // 3.1 期望工具调用是否都被调到，参数是否匹配
  for (const expected of sample.expected_tool_calls) {
    const actual = run.tool_calls.find((c) => c.tool === expected.tool);
    if (!actual) {
      reasons.push(`未调用期望工具：${expected.tool}`);
      continue;
    }
    for (const [k, v] of Object.entries(expected.args_match)) {
      if (JSON.stringify(actual.args[k]) !== JSON.stringify(v)) {
        reasons.push(
          `工具 ${expected.tool} 参数不匹配：${k} 期望 ${JSON.stringify(v)}，实际 ${JSON.stringify(actual.args[k])}`
        );
      }
    }
  }

  // 3.2 回复是否包含期望字符串
  const respLower = run.response.toLowerCase().replace(/，/g, '');
  for (const needle of sample.expected_response_contains) {
    if (!respLower.includes(needle.toLowerCase())) {
      reasons.push(`回复未包含期望字符串：${needle}`);
    }
  }

  return { value: reasons.length === 0 ? 'C' : 'I', reasons };
}

// —— 4. 写日志 + 主流程 ——
interface SampleResult {
  id: string;
  user_input: string;
  run: AgentRun;
  score: Score;
  timing_ms: number;
}

async function main() {
  const model = process.env.MODEL ?? 'gpt-4o';
  const dataset = loadDataset(resolve(__dirname, '../datasets/l1-seed-10.jsonl'));
  const results: SampleResult[] = [];

  console.log(`[evalkit-minimal] 评测开始：${dataset.length} 条样本，模型 ${model}`);

  for (const sample of dataset) {
    const t0 = Date.now();
    const run = await runAgent(sample, model);
    const s = score(sample, run);
    const elapsed = Date.now() - t0;

    results.push({
      id: sample.id,
      user_input: sample.user_input,
      run,
      score: s,
      timing_ms: elapsed,
    });

    const mark = s.value === 'C' ? '✓' : '✗';
    console.log(`${mark} ${sample.id} (${elapsed}ms) ${s.reasons.join('; ')}`);
  }

  // 汇总
  const correct = results.filter((r) => r.score.value === 'C').length;
  const accuracy = correct / results.length;
  console.log(`\n[evalkit-minimal] pass^1 = ${accuracy.toFixed(3)} (${correct}/${results.length})`);

  // 写 JSONL 日志
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = resolve(__dirname, `../runs/${ts}_${model}.jsonl`);
  mkdirSync(dirname(outPath), { recursive: true });
  const lines = results.map((r) => JSON.stringify(r));
  writeFileSync(outPath, lines.join('\n'));
  console.log(`[evalkit-minimal] 日志已写入：${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
