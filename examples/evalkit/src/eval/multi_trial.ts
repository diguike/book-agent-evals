// multiTrialAnalysis —— ch15：从已经跑完的 RunResult 提取 pass^k 数据
// runner 已经支持 epochs，所以"跑"这部分不用重复实现，这里只做 post-processing
import type { RunResult } from './runner.js';
import { passKDataset, passKCurve } from '../stats/pass_k.js';

export interface MultiTrialReport {
  perSamplePassCounts: number[];
  trials: number;
  passKByK: { k: number; passK: number }[];
}

export function multiTrialAnalysis(result: RunResult, ks: number[] = [1, 2, 3, 4, 5, 8]): MultiTrialReport {
  const bySample = new Map<string, number>();
  const epochCount = new Map<string, number>();
  for (const r of result.samples) {
    const allPass = r.scores.every((s) => s.value === 'C');
    bySample.set(r.sampleId, (bySample.get(r.sampleId) ?? 0) + (allPass ? 1 : 0));
    epochCount.set(r.sampleId, (epochCount.get(r.sampleId) ?? 0) + 1);
  }
  const trials = epochCount.size > 0 ? Math.max(...Array.from(epochCount.values())) : 0;
  const perSamplePassCounts = Array.from(bySample.values());
  const validKs = ks.filter((k) => k <= trials);
  return {
    perSamplePassCounts,
    trials,
    passKByK: passKCurve(perSamplePassCounts, trials, validKs),
  };
}

/** 给定 trial 数据，打印 pass^k 曲线表 */
export function formatPassKTable(report: MultiTrialReport): string {
  const lines: string[] = [`  k  | pass^k`];
  lines.push(`  ---+-------`);
  for (const { k, passK } of report.passKByK) {
    lines.push(`  ${String(k).padStart(2)} | ${passK.toFixed(3)}`);
  }
  return lines.join('\n');
}
