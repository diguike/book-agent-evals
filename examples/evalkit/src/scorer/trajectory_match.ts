// trajectoryMatch —— ch11：agent 的工具调用 trajectory 跟期望路径匹配
// 比 toolCallMatch 更严：要求顺序 + 中间不能多出"不该调的工具"
//
// 三种模式：
//   - 'exact'：完全一致（顺序 + 工具数）
//   - 'subset_ordered'：期望的子序列要按顺序出现（默认）
//   - 'set'：工具集合一致，顺序不管
//
// 同时支持"禁用工具列表"：trajectory 里不能出现 forbiddenTools
import type { Scorer, NamedScorer, Score, Target, ExpectedToolCall } from '../types.js';
import { targetIsObject } from '../types.js';

interface TrajectoryMatchOpts {
  field?: string;
  forbiddenField?: string;
  mode?: 'exact' | 'subset_ordered' | 'set';
}

function getExpected(target: Target | undefined, field: string): ExpectedToolCall[] {
  if (!targetIsObject(target)) return [];
  const v = (target as Record<string, unknown>)[field];
  return Array.isArray(v) ? (v as ExpectedToolCall[]) : [];
}

function getForbidden(target: Target | undefined, field: string): string[] {
  if (!targetIsObject(target)) return [];
  const v = (target as Record<string, unknown>)[field];
  return Array.isArray(v) ? (v.filter((x): x is string => typeof x === 'string')) : [];
}

function argsMatch(actual: Record<string, unknown>, exp: ExpectedToolCall): boolean {
  const argsExpected = exp.args_match ?? {};
  for (const [k, v] of Object.entries(argsExpected)) {
    if (JSON.stringify(actual[k]) !== JSON.stringify(v)) return false;
  }
  return true;
}

export function trajectoryMatch(opts: TrajectoryMatchOpts = {}): Scorer {
  const field = opts.field ?? 'expectedTrajectory';
  const forbiddenField = opts.forbiddenField ?? 'forbiddenTools';
  const mode = opts.mode ?? 'subset_ordered';

  const scorer: NamedScorer = async (state, target) => {
    const expected = getExpected(target, field);
    const forbidden = getForbidden(target, forbiddenField);
    const actual = state.toolCalls;
    const reasons: string[] = [];

    // 禁用工具检查
    for (const tc of actual) {
      if (forbidden.includes(tc.tool)) {
        reasons.push(`调用了禁用工具 ${tc.tool}`);
      }
    }

    if (expected.length > 0) {
      if (mode === 'exact') {
        if (actual.length !== expected.length) {
          reasons.push(`长度不一致：期望 ${expected.length}，实际 ${actual.length}`);
        } else {
          for (let i = 0; i < expected.length; i++) {
            const e = expected[i]!;
            const a = actual[i]!;
            if (a.tool !== e.tool) {
              reasons.push(`第 ${i + 1} 步：期望 ${e.tool}，实际 ${a.tool}`);
            } else if (!argsMatch(a.args, e)) {
              reasons.push(
                `第 ${i + 1} 步 ${e.tool} 参数不匹配：期望 ${JSON.stringify(e.args_match)}，实际 ${JSON.stringify(a.args)}`,
              );
            }
          }
        }
      } else if (mode === 'subset_ordered') {
        let pos = 0;
        for (const e of expected) {
          let found = -1;
          for (let i = pos; i < actual.length; i++) {
            if (actual[i]!.tool === e.tool && argsMatch(actual[i]!.args, e)) {
              found = i;
              break;
            }
          }
          if (found < 0) {
            reasons.push(`未按顺序找到 ${e.tool}（args=${JSON.stringify(e.args_match ?? {})}）`);
            break;
          }
          pos = found + 1;
        }
      } else {
        // set 模式
        const actualSet = new Set(actual.map((a) => a.tool));
        for (const e of expected) {
          if (!actualSet.has(e.tool)) reasons.push(`未调用 ${e.tool}`);
        }
      }
    }

    const score: Score = {
      value: reasons.length === 0 ? 'C' : 'I',
      scorer: 'trajectory_match',
    };
    if (reasons.length > 0) score.explanation = reasons.join('; ');
    return score;
  };
  scorer.scorerName = 'trajectory_match';
  return scorer;
}
