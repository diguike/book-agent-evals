// context_precision —— RAG 评测：检索回来的 top-k 上下文里，跟答案相关的占比
// 真实实现需要 LLM judge 判断每条 context 是否 relevant；这里给"有 ground truth contexts 时的 deterministic 版"
// + 可选 judge 版（需要传 router）
import type { Scorer, NamedScorer, Score, Target } from '../../types.js';
import { targetIsObject } from '../../types.js';
import type { ProviderRouter } from '../../provider/router.js';

interface ContextPrecisionOpts {
  /** state.metadata 里存检索结果的字段名（默认 'retrievedContexts'） */
  field?: string;
  /** target 里存 ground-truth contexts 的字段名（默认 'expectedContexts'） */
  groundTruthField?: string;
  /** 如果有 LLM judge，用它判断相关性；否则用字符串包含判断 */
  judgeRouter?: ProviderRouter;
  judgeModel?: string;
}

function getContexts(metadata: Record<string, unknown>, field: string): string[] {
  const v = metadata[field];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}

function getGroundTruth(target: Target | undefined, field: string): string[] {
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

/** 简单文本相关性：ground-truth 的关键词在 context 里出现的比例 */
function deterministicRelevance(ctx: string, groundTruth: string[]): boolean {
  if (groundTruth.length === 0) return false;
  const ctxLower = ctx.toLowerCase();
  return groundTruth.some((g) => {
    const gLower = g.toLowerCase();
    return ctxLower.includes(gLower) || gLower.includes(ctxLower);
  });
}

async function judgeRelevance(
  router: ProviderRouter,
  model: string,
  ctx: string,
  question: string,
): Promise<boolean> {
  const resp = await router.complete({
    model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: '判断"上下文"是否对回答"问题"有帮助。只回答 "yes" 或 "no"，不要解释。',
      },
      { role: 'user', content: `问题：${question}\n\n上下文：${ctx}\n\n相关吗？` },
    ],
  });
  return /^yes/i.test(resp.content.trim());
}

export function contextPrecision(opts: ContextPrecisionOpts = {}): Scorer {
  const field = opts.field ?? 'retrievedContexts';
  const gtField = opts.groundTruthField ?? 'expectedContexts';

  const scorer: NamedScorer = async (state, target) => {
    const ctxs = getContexts(state.metadata, field);
    if (ctxs.length === 0) {
      return {
        value: 0,
        scorer: 'context_precision',
        explanation: `state.metadata.${field} 为空，无法计算 precision`,
      };
    }
    const question = typeof state.sample.input === 'string' ? state.sample.input : '';
    let relevantCount = 0;
    if (opts.judgeRouter && opts.judgeModel) {
      for (const c of ctxs) {
        if (await judgeRelevance(opts.judgeRouter, opts.judgeModel, c, question)) {
          relevantCount += 1;
        }
      }
    } else {
      const gt = getGroundTruth(target, gtField);
      for (const c of ctxs) {
        if (deterministicRelevance(c, gt)) relevantCount += 1;
      }
    }
    const precision = relevantCount / ctxs.length;
    const score: Score = {
      value: precision,
      scorer: 'context_precision',
    };
    if (precision < 1) {
      score.explanation = `top-${ctxs.length} 中相关 ${relevantCount} 条（precision=${precision.toFixed(2)}）`;
    }
    return score;
  };
  scorer.scorerName = 'context_precision';
  return scorer;
}
