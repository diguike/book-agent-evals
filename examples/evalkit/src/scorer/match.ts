// match scorer —— 完全匹配 target 字符串（去前后空白，可选忽略大小写）
import type { Scorer, NamedScorer, Score, Target } from '../types.js';

interface MatchOpts {
  ignoreCase?: boolean;
  /** 从哪里提取 answer：'completion'（默认）/ 'last_message' */
  extractFrom?: 'completion' | 'last_message';
}

function normalize(s: string, ignoreCase: boolean): string {
  return ignoreCase ? s.trim().toLowerCase() : s.trim();
}

function targetToStrings(target: Target | undefined): string[] {
  if (target === undefined) return [];
  if (typeof target === 'string') return [target];
  if (Array.isArray(target)) return target;
  return [];
}

export function match(opts: MatchOpts = {}): Scorer {
  const ignoreCase = opts.ignoreCase ?? false;
  const extractFrom = opts.extractFrom ?? 'completion';

  const scorer: NamedScorer = async (state, target) => {
    let answer = '';
    if (extractFrom === 'completion') {
      answer = state.output?.completion ?? '';
    } else {
      const last = [...state.messages].reverse().find((m) => m.role === 'assistant');
      answer = last?.content ?? '';
    }
    const candidates = targetToStrings(target);
    const ans = normalize(answer, ignoreCase);
    const ok = candidates.some((c) => normalize(c, ignoreCase) === ans);
    const score: Score = {
      value: ok ? 'C' : 'I',
      answer,
      scorer: 'match',
    };
    if (!ok) score.explanation = `期望 ${JSON.stringify(candidates)}，实际 "${answer}"`;
    return score;
  };
  scorer.scorerName = 'match';
  return scorer;
}
