// context_recall —— 应该召回的关键信息有多少真的在 top-k 里
// target 要给 expectedContexts（ground truth）；scorer 计算 ∩ / |ground truth|
import type { Scorer, NamedScorer, Score, Target } from '../../types.js';
import { targetIsObject } from '../../types.js';

interface ContextRecallOpts {
  field?: string;
  groundTruthField?: string;
}

function getContexts(metadata: Record<string, unknown>, field: string): string[] {
  const v = metadata[field];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}

function getGroundTruth(target: Target | undefined, field: string): string[] {
  if (target === undefined) return [];
  if (Array.isArray(target)) return target;
  if (typeof target === 'string') return [target];
  if (targetIsObject(target)) {
    const v = (target as Record<string, unknown>)[field];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  }
  return [];
}

export function contextRecall(opts: ContextRecallOpts = {}): Scorer {
  const field = opts.field ?? 'retrievedContexts';
  const gtField = opts.groundTruthField ?? 'expectedContexts';

  const scorer: NamedScorer = async (state, target) => {
    const retrieved = getContexts(state.metadata, field);
    const gt = getGroundTruth(target, gtField);
    if (gt.length === 0) {
      return {
        value: 1,
        scorer: 'context_recall',
        explanation: 'ground truth 为空',
      };
    }
    let hits = 0;
    for (const g of gt) {
      const gLower = g.toLowerCase();
      const found = retrieved.some(
        (r) => r.toLowerCase().includes(gLower) || gLower.includes(r.toLowerCase()),
      );
      if (found) hits += 1;
    }
    const recall = hits / gt.length;
    const score: Score = { value: recall, scorer: 'context_recall' };
    if (recall < 1) {
      score.explanation = `召回 ${hits}/${gt.length} 条 ground truth`;
    }
    return score;
  };
  scorer.scorerName = 'context_recall';
  return scorer;
}
