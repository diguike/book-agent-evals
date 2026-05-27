// Judgy —— ch14：判断 LLM judge 和人类标注的差距，含偏置纠正
// 论文：Hamel Husain 的 "Judgy" 套路；核心三个指标：
//   - TPR (True Positive Rate)
//   - TNR (True Negative Rate)
//   - balanced accuracy = (TPR + TNR) / 2
// 加 confusion matrix 让作者能看到 judge 偏向 false positive 还是 false negative

export interface JudgyInput {
  /** 真值（人类标注），'C' 或 'I' */
  truth: ('C' | 'I')[];
  /** judge 标注，'C' 或 'I' */
  judge: ('C' | 'I')[];
}

export interface JudgyResult {
  tpr: number;
  tnr: number;
  balancedAccuracy: number;
  accuracy: number;
  confusion: {
    truePositive: number;
    falsePositive: number;
    trueNegative: number;
    falseNegative: number;
  };
  n: number;
}

export function judgy(input: JudgyInput): JudgyResult {
  if (input.truth.length !== input.judge.length) {
    throw new Error(`judgy：truth 和 judge 长度不一致`);
  }
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = 0; i < input.truth.length; i++) {
    const t = input.truth[i];
    const j = input.judge[i];
    if (t === 'C' && j === 'C') tp += 1;
    else if (t === 'I' && j === 'C') fp += 1;
    else if (t === 'I' && j === 'I') tn += 1;
    else if (t === 'C' && j === 'I') fn += 1;
  }
  const posTotal = tp + fn;
  const negTotal = tn + fp;
  const tpr = posTotal === 0 ? 0 : tp / posTotal;
  const tnr = negTotal === 0 ? 0 : tn / negTotal;
  const n = input.truth.length;
  return {
    tpr,
    tnr,
    balancedAccuracy: (tpr + tnr) / 2,
    accuracy: n === 0 ? 0 : (tp + tn) / n,
    confusion: { truePositive: tp, falsePositive: fp, trueNegative: tn, falseNegative: fn },
    n,
  };
}
