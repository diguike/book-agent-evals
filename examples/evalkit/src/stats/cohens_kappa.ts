// Cohen's kappa —— ch14：两个评分者（通常是 judge 模型 vs 人类标注）的一致性
// kappa = (po - pe) / (1 - pe)，po=观察一致率，pe=随机一致率
// 经验阈值：>0.8 几乎完全一致，0.6-0.8 强一致，0.4-0.6 中等，<0.4 弱

export interface KappaInput {
  rater1: (string | number)[];
  rater2: (string | number)[];
}

export interface KappaResult {
  kappa: number;
  agreement: number;
  expectedAgreement: number;
  n: number;
  categories: (string | number)[];
}

export function cohensKappa(input: KappaInput): KappaResult {
  if (input.rater1.length !== input.rater2.length) {
    throw new Error(`Cohen's kappa：rater1 和 rater2 长度不一致（${input.rater1.length} vs ${input.rater2.length}）`);
  }
  const n = input.rater1.length;
  if (n === 0) return { kappa: 1, agreement: 1, expectedAgreement: 1, n: 0, categories: [] };

  const categories = Array.from(new Set([...input.rater1, ...input.rater2])).sort((a, b) =>
    String(a).localeCompare(String(b)),
  );

  // 观察一致
  let agree = 0;
  for (let i = 0; i < n; i++) {
    if (input.rater1[i] === input.rater2[i]) agree += 1;
  }
  const po = agree / n;

  // 随机一致
  const r1Marg: Record<string, number> = {};
  const r2Marg: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    r1Marg[String(input.rater1[i])] = (r1Marg[String(input.rater1[i])] ?? 0) + 1;
    r2Marg[String(input.rater2[i])] = (r2Marg[String(input.rater2[i])] ?? 0) + 1;
  }
  let pe = 0;
  for (const c of categories) {
    const p1 = (r1Marg[String(c)] ?? 0) / n;
    const p2 = (r2Marg[String(c)] ?? 0) / n;
    pe += p1 * p2;
  }

  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  return { kappa, agreement: po, expectedAgreement: pe, n, categories };
}
