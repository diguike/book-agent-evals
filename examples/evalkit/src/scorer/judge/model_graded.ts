// modelGraded —— ch13：LLM-as-Judge 评打分
// 给 judge 一个 rubric，让它判断 agent 回复是否符合
import type { Scorer, NamedScorer, Score, Target } from '../../types.js';
import { targetIsObject } from '../../types.js';
import type { ProviderRouter } from '../../provider/router.js';

interface ModelGradedOpts {
  judgeRouter: ProviderRouter;
  judgeModel: string;
  /** rubric 提示词 —— 告诉 judge 怎么判断 */
  rubric: string;
  /** 输出模板：用 ${answer} ${target} 占位 */
  template?: string;
  /** 把 judge 输出解析成 score；返回 'C'/'I'/'P' 或数值 */
  parseScore?: (judgeOutput: string) => { value: Score['value']; explanation?: string };
}

function defaultParse(out: string): { value: Score['value']; explanation?: string } {
  const trimmed = out.trim();
  // 第一行通常是判定
  const firstLine = trimmed.split('\n')[0]!.trim().toUpperCase();
  if (firstLine.startsWith('GRADE: C') || firstLine === 'C' || firstLine.includes('CORRECT')) {
    return { value: 'C' };
  }
  if (firstLine.startsWith('GRADE: I') || firstLine === 'I' || firstLine.includes('INCORRECT')) {
    return { value: 'I', explanation: trimmed };
  }
  if (firstLine.startsWith('GRADE: P') || firstLine === 'P' || firstLine.includes('PARTIAL')) {
    return { value: 'P', explanation: trimmed };
  }
  // 兜底：找数字
  const num = parseFloat(trimmed);
  if (Number.isFinite(num)) return { value: Math.max(0, Math.min(1, num)) };
  return { value: 'I', explanation: `无法解析 judge 输出：${trimmed.slice(0, 80)}` };
}

const DEFAULT_TEMPLATE = `按 rubric 给 agent 的回复评分。

Rubric:
\${rubric}

参考答案（target）:
\${target}

Agent 回复:
\${answer}

请按格式输出第一行：GRADE: C/I/P （C=完全符合，I=不符合，P=部分符合）
第二行起：简短理由。`;

export function modelGraded(opts: ModelGradedOpts): Scorer {
  const template = opts.template ?? DEFAULT_TEMPLATE;
  const parse = opts.parseScore ?? defaultParse;

  const scorer: NamedScorer = async (state, target) => {
    const answer = state.output?.completion ?? '';
    let targetStr = '';
    if (typeof target === 'string') targetStr = target;
    else if (Array.isArray(target)) targetStr = target.join(' / ');
    else if (targetIsObject(target)) targetStr = JSON.stringify(target);

    const prompt = template
      .replace(/\$\{rubric\}/g, opts.rubric)
      .replace(/\$\{answer\}/g, answer)
      .replace(/\$\{target\}/g, targetStr);

    const resp = await opts.judgeRouter.complete({
      model: opts.judgeModel,
      temperature: 0,
      messages: [
        { role: 'system', content: '你是严格但公正的 evaluator。' },
        { role: 'user', content: prompt },
      ],
    });

    const { value, explanation } = parse(resp.content);
    const score: Score = {
      value,
      answer,
      scorer: 'model_graded',
    };
    if (explanation) score.explanation = explanation;
    score.metadata = { judgeModel: opts.judgeModel, judgeOutput: resp.content };
    return score;
  };
  scorer.scorerName = 'model_graded';
  return scorer;
}
