// latencyScorer —— ch12：每次工具调用 + agent 整体的耗时是否在预算内
// 注意：单次 ProviderRequest 耗时不在 state 里（v1 设计），这里只看 sampleRunResult 的 timingMs
// 通过 target.expectedMaxLatencyMs 设阈值
import type { Scorer, NamedScorer, Score, Target } from '../../types.js';
import { targetIsObject } from '../../types.js';

interface LatencyOpts {
  field?: string;
  /** 拿 timingMs 的字段名（state.metadata 里）默认从 metadata.timingMs 取；
   * runner 不会自动塞，需要在 solver 链尾的 solver 自己塞 */
  timingField?: string;
  /** 当超出 1.5× 阈值给 I，否则给 P */
  partialMul?: number;
}

export function latencyScorer(opts: LatencyOpts = {}): Scorer {
  const field = opts.field ?? 'expectedMaxLatencyMs';
  const timingField = opts.timingField ?? 'timingMs';
  const partialMul = opts.partialMul ?? 1.5;

  const scorer: NamedScorer = async (state, target) => {
    let threshold = 0;
    if (targetIsObject(target)) {
      const v = (target as Record<string, unknown>)[field];
      if (typeof v === 'number') threshold = v;
    }
    if (threshold <= 0) {
      return { value: 'C', scorer: 'latency', explanation: '未指定 latency 阈值' };
    }
    const actual = (state.metadata[timingField] as number | undefined) ?? 0;
    let value: 'C' | 'P' | 'I' = 'C';
    if (actual > threshold * partialMul) value = 'I';
    else if (actual > threshold) value = 'P';

    const score: Score = { value, scorer: 'latency' };
    if (value !== 'C') {
      score.explanation = `实际 ${actual}ms，阈值 ${threshold}ms`;
    }
    score.metadata = { actualMs: actual, thresholdMs: threshold };
    return score;
  };
  scorer.scorerName = 'latency';
  return scorer;
}
