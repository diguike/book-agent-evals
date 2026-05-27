// ch07 demo —— EvalLog Zod schema + view/diff CLI 用法演示
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listLogs, parseLog } from '@inferloop/evalkit';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 扫几个章节的 runs/ 看一下
const dirs = [
  resolve(__dirname, '../../ch04-dataset-seed/runs'),
  resolve(__dirname, '../../ch06-provider/runs'),
];

for (const dir of dirs) {
  console.log(`\n[ch07] ${dir}`);
  try {
    const infos = listLogs(dir);
    for (const info of infos.slice(0, 5)) {
      const acc = info.accuracy !== undefined ? info.accuracy.toFixed(3) : '   - ';
      console.log(`  ${info.taskName.padEnd(30)} | ${info.model.padEnd(12)} | n=${info.sampleCount} | acc=${acc}`);
    }
    if (infos.length === 0) console.log('  （没有日志）');
  } catch (err) {
    console.log(`  ${(err as Error).message}`);
  }
}

// 解析最近一份做一下细看
const allInfos = dirs.flatMap((d) => {
  try {
    return listLogs(d);
  } catch {
    return [];
  }
});
if (allInfos.length > 0) {
  const latest = allInfos[0]!;
  const log = parseLog(latest.path);
  console.log(`\n[ch07] 最近日志详情：${latest.path}`);
  const failed = log.samples.filter((s) => !s.scores.every((sc) => sc.value === 'C'));
  console.log(`  失败样本：${failed.length}/${log.samples.length}`);
  for (const s of failed.slice(0, 3)) {
    console.log(`  ${s.sampleId}: ${s.scores.find((sc) => sc.explanation)?.explanation ?? ''}`);
  }
} else {
  console.log('\n[ch07] 没有可分析的日志，先跑 ch04 / ch06 的 demo 生成几份');
}
