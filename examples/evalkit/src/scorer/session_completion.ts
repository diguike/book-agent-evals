// sessionCompletion —— ch10：多轮评测的"任务完成率"
// sample.target.expectedFinalState 描述会话结束时应该达到的状态（DB 改动 / 关键 tool 调用过 / 关键 keyword 出现）
// 这个 scorer 只检查"是否所有 expected 条件都满足"
import type { Scorer, NamedScorer, Score, Target } from '../types.js';
import { targetIsObject } from '../types.js';

interface ExpectedFinalState {
  toolCallsRequired?: string[];
  responseContains?: string[];
  /** 自定义检查函数（高级用法） */
  customCheck?: (state: import('../types.js').TaskState) => boolean;
}

interface SessionCompletionOpts {
  field?: string;
}

function getExpected(target: Target | undefined, field: string): ExpectedFinalState {
  if (!targetIsObject(target)) return {};
  const v = (target as Record<string, unknown>)[field];
  return (v as ExpectedFinalState) ?? {};
}

export function sessionCompletion(opts: SessionCompletionOpts = {}): Scorer {
  const field = opts.field ?? 'expectedFinalState';

  const scorer: NamedScorer = async (state, target) => {
    const exp = getExpected(target, field);
    const reasons: string[] = [];

    if (exp.toolCallsRequired) {
      const used = new Set(state.toolCalls.map((tc) => tc.tool));
      for (const t of exp.toolCallsRequired) {
        if (!used.has(t)) reasons.push(`未调用 ${t}`);
      }
    }

    if (exp.responseContains) {
      const completion = state.output?.completion ?? '';
      const lc = completion.toLowerCase();
      for (const needle of exp.responseContains) {
        if (!lc.includes(needle.toLowerCase())) {
          reasons.push(`回复未包含 "${needle}"`);
        }
      }
    }

    if (exp.customCheck && !exp.customCheck(state)) {
      reasons.push('customCheck 失败');
    }

    const score: Score = {
      value: reasons.length === 0 ? 'C' : 'I',
      scorer: 'session_completion',
    };
    if (reasons.length > 0) score.explanation = reasons.join('; ');
    return score;
  };
  scorer.scorerName = 'session_completion';
  return scorer;
}
