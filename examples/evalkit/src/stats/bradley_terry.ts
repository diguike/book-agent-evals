// Bradley-Terry 模型 —— ch14：pairwise 比较结果反推每个模型的"实力"
// P(A wins B) = exp(s_A) / (exp(s_A) + exp(s_B))
// 用 MM 算法（Minorization-Maximization）迭代求解
//
// 输入：pairwise wins 矩阵 wins[i][j] = i 赢 j 的次数

export interface BradleyTerryInput {
  /** 模型列表 */
  models: string[];
  /** wins[i][j] = i 赢 j 的次数 */
  wins: number[][];
  /** 最大迭代次数 */
  maxIter?: number;
  /** 收敛阈值 */
  tol?: number;
}

export interface BradleyTerryResult {
  /** 每个模型的实力分（log-strength），按 models 顺序对齐 */
  strengths: number[];
  /** 排名（从强到弱） */
  ranking: { model: string; strength: number }[];
  iterations: number;
  converged: boolean;
}

export function bradleyTerry(input: BradleyTerryInput): BradleyTerryResult {
  const m = input.models.length;
  const wins = input.wins;
  const maxIter = input.maxIter ?? 200;
  const tol = input.tol ?? 1e-6;

  // pi 初始化为 1
  const pi = new Array(m).fill(1);

  // 每个 i 的总胜场
  const W = new Array(m).fill(0);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      if (i !== j) W[i] += wins[i]![j]!;
    }
  }

  let iterations = 0;
  let converged = false;
  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;
    const next = new Array(m).fill(0);
    for (let i = 0; i < m; i++) {
      let denom = 0;
      for (let j = 0; j < m; j++) {
        if (i === j) continue;
        const games = (wins[i]?.[j] ?? 0) + (wins[j]?.[i] ?? 0);
        if (games === 0) continue;
        denom += games / (pi[i] + pi[j]);
      }
      next[i] = denom === 0 ? pi[i] : W[i] / denom;
    }
    // 归一化（保 sum=m）
    const sum = next.reduce((a: number, b: number) => a + b, 0);
    if (sum > 0) {
      for (let i = 0; i < m; i++) next[i] = (next[i] * m) / sum;
    }
    // 收敛？
    let maxDelta = 0;
    for (let i = 0; i < m; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(next[i] - pi[i]));
      pi[i] = next[i];
    }
    if (maxDelta < tol) {
      converged = true;
      break;
    }
  }

  // 转 log-strength
  const strengths = pi.map((p: number) => Math.log(p));
  const ranking = input.models
    .map((model, i) => ({ model, strength: strengths[i]! }))
    .sort((a, b) => b.strength - a.strength);

  return { strengths, ranking, iterations, converged };
}
