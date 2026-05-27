// `evalkit list [dir]` —— ch07 新增
// 列出某目录下所有 jsonl 日志（按 mtime 倒序），方便快速找最近 run
import { listLogs } from '../log/reader.js';

export function listCli(dir: string): void {
  const infos = listLogs(dir);
  if (infos.length === 0) {
    console.log(`[list] ${dir} 下没有 jsonl 日志`);
    return;
  }
  console.log('  时间                | task                       | model        | n    | acc');
  console.log('  --------------------+----------------------------+--------------+------+-----');
  for (const info of infos) {
    const time = info.mtime.toISOString().slice(0, 19).replace('T', ' ');
    const task = info.taskName.padEnd(26).slice(0, 26);
    const model = info.model.padEnd(12).slice(0, 12);
    const n = String(info.sampleCount).padStart(4);
    const acc = info.accuracy !== undefined ? info.accuracy.toFixed(3) : '   - ';
    console.log(`  ${time} | ${task} | ${model} | ${n} | ${acc}`);
  }
}
