// ch18 demo —— 数据飞轮：从生产日志反挖新评测样本
// 模拟过程：扫 ch17 跑出来的 jsonl，挑出"边界 case"加进 v2.1.0 候选集
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { parseLog, type SampleEntry } from '@inferloop/evalkit';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findLatestLog(dir: string): string | null {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, m: statSync(resolve(dir, f)).mtime }))
      .sort((a, b) => b.m.getTime() - a.m.getTime());
    return files[0] ? resolve(dir, files[0].f) : null;
  } catch {
    return null;
  }
}

const logPath = process.argv[2] ?? findLatestLog(resolve(__dirname, '../../ch17-dataset-v2/runs'));
if (!logPath) {
  console.log('[ch18] 没找到 ch17 日志，请先 cd ../ch17-dataset-v2 && npm run eval');
  process.exit(0);
}

console.log('[ch18] 扫日志：' + logPath);
const log = parseLog(logPath);

// 找出"边界 case"：失败的，特别是 explanation 包含 policy 关键词的
const interesting: SampleEntry[] = log.samples.filter((s) => {
  const failed = !s.scores.every((sc) => sc.value === 'C');
  if (!failed) return false;
  const reasons = s.scores.map((sc) => sc.explanation ?? '').join(' ');
  return /policy|已发货|不能|无法|超额|身份/.test(reasons);
});

console.log(`[ch18] 找到 ${interesting.length} 条候选边界 case（满足 policy 或反模式）`);

// 输出成新的"v2.1.0 候选集"jsonl
const outDir = resolve(__dirname, '../candidates');
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, 'v2.1.0-candidates.jsonl');
const lines = interesting.map((s) => {
  const last = s.messages[s.messages.length - 1];
  return JSON.stringify({
    id: 'L1-CAND-' + s.sampleId,
    input: '（候选 from ' + s.sampleId + '）',
    target: {},
    metadata: {
      source: 'flywheel',
      original_sample: s.sampleId,
      tool_calls: s.toolCalls,
      reason: s.scores.find((sc) => sc.explanation)?.explanation,
      last_message: last?.content,
    },
  });
});
writeFileSync(outPath, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
console.log('[ch18] 写入候选集：' + outPath);
console.log('       下一步：人工筛选 → 补 target 字段 → 合并进 L1 v2.1.0');
