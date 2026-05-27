// 显著性检验 —— ch19 CI 守门用
// 两个评测的 accuracy 差距是否显著？用 McNemar test（成对二项）

export interface McNemarInput {
  /** baseline pass-array：每条 sample 的 0/1 */
  baseline: number[];
  /** candidate pass-array：同上，必须跟 baseline 对齐 */
  candidate: number[];
}

export interface McNemarResult {
  /** 仅 baseline 过 → candidate 错（B 改坏） */
  b: number;
  /** 仅 candidate 过 → baseline 错（C 改对） */
  c: number;
  /** chi-square statistic */
  chiSquare: number;
  /** p-value approx（chi-square df=1） */
  pValue: number;
  /** 接受/拒绝在 alpha=0.05 下的零假设（"没差距"） */
  significant: boolean;
}

/** chi-square CDF approximation for df=1 via erfc */
function erfc(x: number): number {
  // Abramowitz & Stegun 7.1.26
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const ans =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? ans : 2 - ans;
}

function chi2CdfDf1(x: number): number {
  // df=1: CDF(x) = erf(sqrt(x/2))
  if (x <= 0) return 0;
  return 1 - erfc(Math.sqrt(x / 2));
}

export function mcnemar(input: McNemarInput): McNemarResult {
  if (input.baseline.length !== input.candidate.length) {
    throw new Error(`McNemar：baseline/candidate 长度不一致`);
  }
  let b = 0;
  let c = 0;
  for (let i = 0; i < input.baseline.length; i++) {
    if (input.baseline[i] === 1 && input.candidate[i] === 0) b += 1;
    if (input.baseline[i] === 0 && input.candidate[i] === 1) c += 1;
  }
  // 加 1 的连续性校正版（小样本更准）
  const chi = b + c === 0 ? 0 : Math.pow(Math.abs(b - c) - 1, 2) / (b + c);
  const pValue = 1 - chi2CdfDf1(chi);
  return {
    b,
    c,
    chiSquare: chi,
    pValue,
    significant: pValue < 0.05,
  };
}
