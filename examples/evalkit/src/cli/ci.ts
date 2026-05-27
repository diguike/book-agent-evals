// `evalkit ci <baseline> <candidate>` —— ch19：CI 守门
// 给 candidate 跟 baseline 比，超出 regression 阈值或显著退化时 exit 1
import { parseLog } from '../log/reader.js';
import { mcnemar } from '../stats/significance.js';
import type { SampleEntry } from '../log/schema.js';

interface CiOpts {
  /** 允许的最大 regression 条数（默认 0） */
  regressionThreshold?: number;
  /** 允许的最大 accuracy 下降比例（默认 0.02 = 2 个百分点） */
  accuracyDropThreshold?: number;
  /** 是否跑 McNemar 显著性检验，默认 true */
  significance?: boolean;
  /** McNemar p 值阈值，默认 0.05 */
  pValueThreshold?: number;
}

function passed(s: SampleEntry): boolean {
  return s.scores.every((sc) => sc.value === 'C');
}

export function ciCli(baseline: string, candidate: string, opts: CiOpts = {}): void {
  const regressionThreshold = opts.regressionThreshold ?? 0;
  const accDrop = opts.accuracyDropThreshold ?? 0.02;
  const significance = opts.significance ?? true;
  const pThreshold = opts.pValueThreshold ?? 0.05;

  const base = parseLog(baseline);
  const cand = parseLog(candidate);

  const baseMap = new Map<string, SampleEntry>();
  for (const s of base.samples) baseMap.set(s.sampleId, s);
  const candMap = new Map<string, SampleEntry>();
  for (const s of cand.samples) candMap.set(s.sampleId, s);

  // 按对齐的 sampleId 收集 pass arrays
  const sharedIds: string[] = [];
  const basePass: number[] = [];
  const candPass: number[] = [];
  let regressionCount = 0;
  const regressionIds: string[] = [];

  for (const id of baseMap.keys()) {
    const c = candMap.get(id);
    if (!c) continue;
    const b = baseMap.get(id)!;
    sharedIds.push(id);
    const bp = passed(b);
    const cp = passed(c);
    basePass.push(bp ? 1 : 0);
    candPass.push(cp ? 1 : 0);
    if (bp && !cp) {
      regressionCount += 1;
      regressionIds.push(id);
    }
  }

  const baseAcc =
    basePass.length === 0 ? 0 : basePass.reduce((a, b) => a + b, 0) / basePass.length;
  const candAcc =
    candPass.length === 0 ? 0 : candPass.reduce((a, b) => a + b, 0) / candPass.length;
  const diff = candAcc - baseAcc;

  let mcResult: ReturnType<typeof mcnemar> | undefined;
  if (significance && basePass.length > 0) {
    mcResult = mcnemar({ baseline: basePass, candidate: candPass });
  }

  console.log(`[ci] 对齐 sample 数: ${sharedIds.length}`);
  console.log(`[ci] baseline acc=${baseAcc.toFixed(3)} → candidate acc=${candAcc.toFixed(3)} (Δ=${diff.toFixed(3)})`);
  console.log(`[ci] regression: ${regressionCount} 条`);
  if (mcResult) {
    console.log(
      `[ci] McNemar: b=${mcResult.b}, c=${mcResult.c}, chi²=${mcResult.chiSquare.toFixed(3)}, p=${mcResult.pValue.toFixed(4)}`,
    );
  }

  const failures: string[] = [];
  if (regressionCount > regressionThreshold) {
    failures.push(`regression ${regressionCount} > 阈值 ${regressionThreshold}`);
  }
  if (-diff > accDrop) {
    failures.push(`accuracy 下降 ${(-diff).toFixed(3)} > 阈值 ${accDrop}`);
  }
  if (mcResult && mcResult.b > mcResult.c && mcResult.pValue < pThreshold) {
    failures.push(`McNemar 显示显著退化 (p=${mcResult.pValue.toFixed(4)} < ${pThreshold})`);
  }

  if (failures.length > 0) {
    console.error('[ci] FAIL:');
    for (const f of failures) console.error(`  - ${f}`);
    if (regressionIds.length > 0 && regressionIds.length <= 10) {
      console.error(`[ci] 退化 sample ids: ${regressionIds.join(', ')}`);
    }
    process.exit(1);
  }
  console.log('[ci] PASS');
}
