// toolCallMatch scorer —— 期望工具调用是否都发生 + 参数匹配
// 升级自 ch02 minimal 的 score() 函数
import type { Scorer, NamedScorer, Score, Target, ExpectedToolCall, ToolCall } from '../types.js';
import { targetIsObject } from '../types.js';

interface ToolCallMatchOpts {
  /** target 是对象时从哪个字段取期望调用列表 */
  field?: string;
  /** 是否要求顺序一致（默认 false） */
  ordered?: boolean;
}

function targetToExpected(target: Target | undefined, field: string): ExpectedToolCall[] {
  if (target === undefined) return [];
  if (typeof target === 'string' || Array.isArray(target)) return [];
  if (targetIsObject(target)) {
    const v = (target as Record<string, unknown>)[field];
    if (Array.isArray(v)) return v as ExpectedToolCall[];
  }
  return [];
}

function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function argsMatch(actual: Record<string, unknown>, expected: ExpectedToolCall): boolean {
  const mode = expected.match_mode ?? 'subset';
  const argsExpected = expected.args_match ?? {};
  if (mode === 'exact') {
    const keysA = Object.keys(actual).sort();
    const keysE = Object.keys(argsExpected).sort();
    if (keysA.length !== keysE.length) return false;
    for (let i = 0; i < keysA.length; i++) {
      if (keysA[i] !== keysE[i]) return false;
    }
  }
  for (const [k, v] of Object.entries(argsExpected)) {
    if (!jsonEq(actual[k], v)) return false;
  }
  return true;
}

/** 找到匹配指定 expected 的 ToolCall（考虑 occurrence） */
function findMatchingCall(
  calls: ToolCall[],
  expected: ExpectedToolCall,
): { index: number; ok: boolean; failedAt?: string } {
  let seenOfThisTool = 0;
  const targetOccurrence = expected.occurrence ?? 1;
  for (let i = 0; i < calls.length; i++) {
    if (calls[i]!.tool !== expected.tool) continue;
    seenOfThisTool += 1;
    if (seenOfThisTool < targetOccurrence) continue;
    // 找到第 targetOccurrence 次调用，检查参数
    if (argsMatch(calls[i]!.args, expected)) {
      return { index: i, ok: true };
    }
    return {
      index: i,
      ok: false,
      failedAt: `参数不匹配：期望 ${JSON.stringify(expected.args_match)}，实际 ${JSON.stringify(calls[i]!.args)}`,
    };
  }
  return { index: -1, ok: false, failedAt: `未找到 ${expected.tool} 的第 ${targetOccurrence} 次调用` };
}

export function toolCallMatch(opts: ToolCallMatchOpts = {}): Scorer {
  const field = opts.field ?? 'expectedToolCalls';
  const ordered = opts.ordered ?? false;

  const scorer: NamedScorer = async (state, target) => {
    const expected = targetToExpected(target, field);
    const actual = state.toolCalls;
    const reasons: string[] = [];

    if (expected.length === 0) {
      return { value: 'C', scorer: 'tool_call_match' };
    }

    const matchedIndices: number[] = [];
    for (const e of expected) {
      const result = findMatchingCall(actual, e);
      if (!result.ok) {
        reasons.push(`工具 ${e.tool}：${result.failedAt}`);
      } else {
        matchedIndices.push(result.index);
      }
    }

    if (reasons.length === 0 && ordered) {
      // 顺序检查
      for (let i = 1; i < matchedIndices.length; i++) {
        if (matchedIndices[i]! < matchedIndices[i - 1]!) {
          reasons.push(
            `工具调用顺序不对：${expected[i]!.tool} 应在 ${expected[i - 1]!.tool} 之后`,
          );
          break;
        }
      }
    }

    const score: Score = {
      value: reasons.length === 0 ? 'C' : 'I',
      scorer: 'tool_call_match',
    };
    if (reasons.length > 0) score.explanation = reasons.join('; ');
    return score;
  };
  scorer.scorerName = 'tool_call_match';
  return scorer;
}
