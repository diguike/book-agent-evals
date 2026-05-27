// pass^k 计算 —— ch15
// 给定 n 次独立试验中 c 次通过，计算"k 次都过"的无偏估计
// pass^k = 1 - C(n-c, k) / C(n, k)（注意是组合数，OpenAI HumanEval 同款）
//
// 注意 ≠ pass@k（pass-at-k 是"任 k 次中至少一次过"，常见于代码生成）
// 本书一致用 pass^k（连读"pass to the k"），表示"k 次都过的可靠性"

function logComb(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  if (k === 0 || k === n) return 0;
  let acc = 0;
  for (let i = 1; i <= k; i++) {
    acc += Math.log(n - i + 1) - Math.log(i);
  }
  return acc;
}

/** 单个 sample 的 pass^k */
export function passKForSample(c: number, n: number, k: number): number {
  if (k > n) return 0;
  if (c === n) return 1;
  if (c < k) return 0;
  // 1 - C(n-c, k) / C(n, k)
  const log = logComb(n - c, k) - logComb(n, k);
  return 1 - Math.exp(log);
}

/** 别名：正文 ch15 用的 passHatK 名字。参数顺序：(numTrials, successCount, k) */
export function passHatK(numTrials: number, successCount: number, k: number): number {
  return passKForSample(successCount, numTrials, k);
}

export interface PassKDatasetInput {
  /** 每个 sample 在 n 次试验中通过了几次 */
  perSamplePassCounts: number[];
  /** 试验次数 n */
  trials: number;
  /** 要算的 k */
  k: number;
}

export function passKDataset(input: PassKDatasetInput): number {
  if (input.perSamplePassCounts.length === 0) return 0;
  const sum = input.perSamplePassCounts.reduce(
    (acc, c) => acc + passKForSample(c, input.trials, input.k),
    0,
  );
  return sum / input.perSamplePassCounts.length;
}

/** 别名：正文 ch15 用的 passKAcrossTasks 名字 */
export function passKAcrossTasks(
  results: { taskId: string; trialsWithSuccess: number; totalTrials: number }[],
  k: number,
): number {
  if (results.length === 0) return 0;
  return (
    results.reduce(
      (sum, r) => sum + passKForSample(r.trialsWithSuccess, r.totalTrials, k),
      0,
    ) / results.length
  );
}

/** 一组 k 值同时算，方便画曲线 */
export function passKCurve(
  perSamplePassCounts: number[],
  trials: number,
  ks: number[],
): { k: number; passK: number }[] {
  return ks.map((k) => ({
    k,
    passK: passKDataset({ perSamplePassCounts, trials, k }),
  }));
}
