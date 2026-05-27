// `evalkit diff <baseline> <candidate>` —— ch07 真实实现
// 按 sampleId 对齐，区分 regression / improvement / unchanged，可选打印 trajectory diff
import { parseLog } from '../log/reader.js';
import type { SampleEntry } from '../log/schema.js';

interface DiffOpts {
  /** 打印 regression 样本的 trajectory 对比 */
  showTrajectory?: boolean;
  /** 只看 regression（默认 true，improvement 也打但更少） */
  regressionOnly?: boolean;
}

function passed(s: SampleEntry): boolean {
  return s.scores.every((sc) => sc.value === 'C');
}

function summarizeTools(s: SampleEntry): string {
  return s.toolCalls.map((tc) => tc.tool).join(' → ') || '(无工具调用)';
}

export function diffCli(baseline: string, candidate: string, opts: DiffOpts = {}): void {
  const base = parseLog(baseline);
  const cand = parseLog(candidate);

  const baseMap = new Map<string, SampleEntry>();
  for (const s of base.samples) baseMap.set(s.sampleId, s);
  const candMap = new Map<string, SampleEntry>();
  for (const s of cand.samples) candMap.set(s.sampleId, s);

  const allIds = new Set<string>([...baseMap.keys(), ...candMap.keys()]);
  let regressed = 0;
  let improved = 0;
  let unchanged = 0;
  const onlyBase: string[] = [];
  const onlyCand: string[] = [];

  for (const id of allIds) {
    const b = baseMap.get(id);
    const c = candMap.get(id);
    if (!b) {
      onlyCand.push(id);
      continue;
    }
    if (!c) {
      onlyBase.push(id);
      continue;
    }
    const bp = passed(b);
    const cp = passed(c);
    if (bp && !cp) {
      regressed += 1;
      console.log(`✗→ ${id} (regression)`);
      const cReason = c.scores
        .filter((s) => s.value !== 'C')
        .map((s) => s.explanation ?? '')
        .join('; ');
      if (cReason) console.log(`     reason: ${cReason}`);
      if (opts.showTrajectory) {
        console.log(`     baseline tools: ${summarizeTools(b)}`);
        console.log(`     candidate tools: ${summarizeTools(c)}`);
      }
    } else if (!bp && cp) {
      improved += 1;
      if (!opts.regressionOnly) console.log(`→✓ ${id} (improvement)`);
    } else {
      unchanged += 1;
    }
  }

  console.log('');
  console.log(`[diff] regression=${regressed} improvement=${improved} unchanged=${unchanged}`);
  if (onlyBase.length > 0) console.log(`[diff] only in baseline: ${onlyBase.length}`);
  if (onlyCand.length > 0) console.log(`[diff] only in candidate: ${onlyCand.length}`);

  // 显著性提示（粗）：N>30 时给个 p 值近似（精确版见 stats/significance）
  if (allIds.size >= 30) {
    const baseAcc = base.footer?.metrics.accuracy ?? 0;
    const candAcc = cand.footer?.metrics.accuracy ?? 0;
    console.log(
      `[diff] baseline acc=${baseAcc.toFixed(3)} → candidate acc=${candAcc.toFixed(3)} (Δ=${(candAcc - baseAcc).toFixed(3)})`,
    );
  }
}
