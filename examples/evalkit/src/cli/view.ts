// `evalkit view <log>` —— ch07 真实实现
// 渲染 header / samples（含 trajectory：tool calls 顺序、score 详情）/ footer
import { parseLog } from '../log/reader.js';
import type { SampleEntry } from '../log/schema.js';

interface ViewOpts {
  /** 只看某个 sample */
  sample?: string;
  /** 只看失败的 */
  failedOnly?: boolean;
  /** 是否打印每条 sample 的完整 trajectory（默认只汇总） */
  trajectory?: boolean;
  /** 限制打印前 N 条 */
  limit?: number;
}

function sampleFailed(s: SampleEntry): boolean {
  return !s.scores.every((sc) => sc.value === 'C');
}

function renderTrajectory(s: SampleEntry): string {
  const lines: string[] = [];
  for (const tc of s.toolCalls) {
    const argsStr = JSON.stringify(tc.args);
    const trimmed = argsStr.length > 80 ? argsStr.slice(0, 77) + '...' : argsStr;
    lines.push(`    [tool] ${tc.tool}(${trimmed})`);
  }
  if (s.output?.completion) {
    const compl = s.output.completion;
    const text = compl.length > 200 ? compl.slice(0, 197) + '...' : compl;
    lines.push(`    [reply] ${text}`);
  }
  return lines.join('\n');
}

function renderSample(s: SampleEntry, withTrajectory: boolean): string {
  const passed = !sampleFailed(s);
  const mark = passed ? '✓' : '✗';
  const ep = s.epoch !== undefined ? `[ep${s.epoch}]` : '';
  const reasons = s.scores
    .filter((sc) => sc.value !== 'C' && sc.explanation)
    .map((sc) => `${sc.scorer ?? 'scorer'}: ${sc.explanation as string}`)
    .join('; ');
  const head = `${mark} ${s.sampleId}${ep} (${s.timingMs}ms) ${reasons}`;
  if (!withTrajectory) return head;
  return head + '\n' + renderTrajectory(s);
}

export function viewCli(logFile: string, opts: ViewOpts = {}): void {
  const log = parseLog(logFile);
  console.log(
    `[header] task=${log.header.taskName} model=${log.header.model} size=${log.header.datasetSize}`,
  );

  let samples = log.samples;
  if (opts.sample) samples = samples.filter((s) => s.sampleId === opts.sample);
  if (opts.failedOnly) samples = samples.filter(sampleFailed);
  if (opts.limit) samples = samples.slice(0, opts.limit);

  for (const s of samples) {
    console.log(renderSample(s, opts.trajectory ?? false));
  }

  if (log.footer) {
    const m = log.footer.metrics;
    const acc = m.accuracy ?? 0;
    const c = m.correct ?? 0;
    const t = m.total ?? 0;
    console.log(`[footer] accuracy = ${acc.toFixed(3)} (${c}/${t})`);
  }
}
