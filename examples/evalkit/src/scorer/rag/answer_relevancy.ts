// answer_relevancy —— 回复是否切题
// 思路：让 LLM 从回复反推"它在回答什么问题"，与原问题比相似度
// 这里用 LLM judge 直接给 0-1 分（精确版需要 embedding 算 cosine，先做粗版）
import type { Scorer, NamedScorer, Score } from '../../types.js';
import type { ProviderRouter } from '../../provider/router.js';

interface AnswerRelevancyOpts {
  judgeRouter: ProviderRouter;
  judgeModel: string;
}

export function answerRelevancy(opts: AnswerRelevancyOpts): Scorer {
  const scorer: NamedScorer = async (state) => {
    const question = typeof state.sample.input === 'string' ? state.sample.input : '';
    const answer = state.output?.completion ?? '';
    if (!answer) {
      return { value: 0, scorer: 'answer_relevancy', explanation: '没有回复' };
    }
    const resp = await opts.judgeRouter.complete({
      model: opts.judgeModel,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            '判断回复是否切题。打分规则：1.0=完全切题、0.5=部分切题、0.0=完全答非所问。只输出一个数字，不要解释。',
        },
        { role: 'user', content: `问题：${question}\n\n回复：${answer}\n\n相关度（0-1）：` },
      ],
    });
    const num = parseFloat(resp.content.trim());
    const value = Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 0;
    const score: Score = { value, scorer: 'answer_relevancy' };
    if (value < 0.7) {
      score.explanation = `judge 评分 ${value.toFixed(2)}（answer="${answer.slice(0, 60)}..."）`;
    }
    return score;
  };
  scorer.scorerName = 'answer_relevancy';
  return scorer;
}
