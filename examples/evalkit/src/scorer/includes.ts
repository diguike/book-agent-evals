// includes scorer —— target 字符串是否出现在 agent 回复里（支持多个字符串都要命中或命中任一）
import type { Scorer, NamedScorer, Score, Target } from '../types.js';
import { targetIsObject } from '../types.js';

interface IncludesOpts {
  /** 'all'（默认）所有字符串都要命中；'any' 任一命中即可 */
  mode?: 'all' | 'any';
  ignoreCase?: boolean;
  /** target 是对象时，从哪个字段取期望字符串列表（默认 'expectedResponseContains'） */
  field?: string;
}

function normalize(s: string, ignoreCase: boolean): string {
  return ignoreCase ? s.toLowerCase() : s;
}

function targetToList(target: Target | undefined, field: string): string[] {
  if (target === undefined) return [];
  if (typeof target === 'string') return [target];
  if (Array.isArray(target)) return target;
  if (targetIsObject(target)) {
    const v = (target as Record<string, unknown>)[field];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
    if (typeof v === 'string') return [v];
  }
  return [];
}

export function includes(opts: IncludesOpts = {}): Scorer {
  const mode = opts.mode ?? 'all';
  const ignoreCase = opts.ignoreCase ?? true;
  const field = opts.field ?? 'expectedResponseContains';

  const scorer: NamedScorer = async (state, target) => {
    const completion = state.output?.completion ?? '';
    const haystack = normalize(completion, ignoreCase);
    const needles = targetToList(target, field);

    if (needles.length === 0) {
      // 没有期望字符串 → 算通过（不约束）
      return { value: 'C', answer: completion, scorer: 'includes' };
    }

    const hits = needles.filter((n) => haystack.includes(normalize(n, ignoreCase)));
    const ok = mode === 'all' ? hits.length === needles.length : hits.length > 0;
    const score: Score = {
      value: ok ? 'C' : 'I',
      answer: completion,
      scorer: 'includes',
    };
    if (!ok) {
      const missed = needles.filter((n) => !haystack.includes(normalize(n, ignoreCase)));
      score.explanation = `回复未包含期望字符串：${JSON.stringify(missed)}`;
    }
    return score;
  };
  scorer.scorerName = 'includes';
  return scorer;
}
