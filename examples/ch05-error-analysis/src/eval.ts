// ch05 demo —— Open-Axial Coding：扫一份 jsonl 日志，按错误类型聚类
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLog, type SampleEntry } from '@inferloop/evalkit';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ErrorBucket {
  pattern: RegExp;
  label: string;
  axial: string;
}

const buckets: ErrorBucket[] = [
  { pattern: /未调用期望工具：get_order/, label: 'missing_get_order', axial: 'policy 1 没遵守' },
  { pattern: /未调用期望工具：refund_order/, label: 'missing_refund_order', axial: '工具选择错' },
  { pattern: /未调用期望工具：update_shipping_address/, label: 'missing_update_address', axial: '工具选择错' },
  { pattern: /未调用期望工具：cancel_order/, label: 'missing_cancel', axial: '工具选择错' },
  { pattern: /未调用期望工具：search_faq/, label: 'missing_faq', axial: 'FAQ 不识别' },
  { pattern: /参数不匹配/, label: 'wrong_args', axial: '参数抽取错' },
  { pattern: /回复未包含期望字符串/, label: 'wrong_response', axial: '生成内容错' },
];

function categorize(reasons: string[]): string {
  for (const r of reasons) {
    for (const b of buckets) {
      if (b.pattern.test(r)) return `${b.label} (${b.axial})`;
    }
  }
  return 'other';
}

const logPath = process.argv[2] ?? resolve(__dirname, '../../ch04-dataset-seed/runs/');
console.log(`[ch05] 扫日志：${logPath}`);

import { readdirSync, statSync } from 'node:fs';
function findLatestLog(dir: string): string | null {
  try {
    if (statSync(dir).isFile()) return dir;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, m: statSync(resolve(dir, f)).mtime }))
      .sort((a, b) => b.m.getTime() - a.m.getTime());
    return files[0] ? resolve(dir, files[0].f) : null;
  } catch {
    return null;
  }
}

const latest = findLatestLog(logPath);
if (!latest) {
  console.log('[ch05] 没找到日志，请先在 ch04-dataset-seed/ 跑 npm run eval');
  process.exit(0);
}
console.log(`[ch05] 分析：${latest}`);

const log = parseLog(latest);
const buckets2 = new Map<string, SampleEntry[]>();
for (const s of log.samples) {
  if (s.scores.every((sc) => sc.value === 'C')) continue;
  const reasons = s.scores.filter((sc) => sc.explanation).map((sc) => sc.explanation as string);
  const cat = categorize(reasons);
  buckets2.set(cat, [...(buckets2.get(cat) ?? []), s]);
}

const sorted = [...buckets2.entries()].sort((a, b) => b[1].length - a[1].length);
console.log('\n[ch05] Open-Axial Coding 结果（按数量降序）：');
for (const [label, arr] of sorted) {
  console.log(`  ${arr.length.toString().padStart(3)} ${label}`);
  for (const s of arr.slice(0, 2)) {
    const reason = s.scores.find((sc) => sc.explanation)?.explanation ?? '';
    console.log(`       └ ${s.sampleId}: ${reason.slice(0, 80)}`);
  }
}
