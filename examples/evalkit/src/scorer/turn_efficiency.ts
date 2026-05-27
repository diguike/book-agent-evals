// turnEfficiency —— ch10：多轮评测的"效率"，期望 ≤ N 轮搞定
// expectedMaxTurns 在 target 里指定；实际 turn 数从 state.output.steps 或 turnHistory.length 取
import type { Scorer, NamedScorer, Score, Target } from '../types.js';
import { targetIsObject } from '../types.js';

interface TurnEfficiencyOpts {
  field?: string;
  /** 当实际 ≤ 期望时给 C；当超出但 ≤ 1.5× 给 P；再多给 I */
  partialThreshold?: number;
}

export function turnEfficiency(opts: TurnEfficiencyOpts = {}): Scorer {
  const field = opts.field ?? 'expectedMaxTurns';
  const partialMul = opts.partialThreshold ?? 1.5;

  const scorer: NamedScorer = async (state, target) => {
    let expected = 0;
    if (targetIsObject(target)) {
      const v = (target as Record<string, unknown>)[field];
      if (typeof v === 'number') expected = v;
    }
    if (expected <= 0) {
      return { value: 'C', scorer: 'turn_efficiency', explanation: '未指定期望轮数' };
    }
    const turns =
      (state.metadata.turnHistory as { user: string; agent: string }[] | undefined)?.length ??
      state.output?.steps ??
      0;
    let value: 'C' | 'P' | 'I' = 'I';
    if (turns <= expected) value = 'C';
    else if (turns <= Math.ceil(expected * partialMul)) value = 'P';
    const score: Score = { value, scorer: 'turn_efficiency' };
    if (value !== 'C') {
      score.explanation = `实际 ${turns} 轮，期望 ≤ ${expected} 轮`;
    }
    score.metadata = { turns, expected };
    return score;
  };
  scorer.scorerName = 'turn_efficiency';
  return scorer;
}
