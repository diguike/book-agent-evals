// faithfulness —— agent 回复里的"断言"是否都能在 retrieved contexts 里找到依据
// 需要 LLM judge：第一步把回复拆成断言，第二步逐条判断断言是否能从 context 推出
// 这里给完整 judge 版（要传 router 和 judge 模型）
import type { Scorer, NamedScorer, Score } from '../../types.js';
import type { ProviderRouter } from '../../provider/router.js';

interface FaithfulnessOpts {
  judgeRouter: ProviderRouter;
  judgeModel: string;
  contextField?: string;
}

async function extractClaims(
  router: ProviderRouter,
  model: string,
  answer: string,
): Promise<string[]> {
  const resp = await router.complete({
    model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          '把下面的回复拆成"断言"列表，每行一个断言，不要编号，不要解释。一个断言是一句可独立判断真假的陈述。',
      },
      { role: 'user', content: answer },
    ],
  });
  return resp.content
    .split('\n')
    .map((l) => l.trim().replace(/^[-*•]\s*/, ''))
    .filter((l) => l.length > 0);
}

async function isSupportedByContext(
  router: ProviderRouter,
  model: string,
  claim: string,
  contexts: string[],
): Promise<boolean> {
  const ctxJoined = contexts.map((c, i) => `[${i + 1}] ${c}`).join('\n');
  const resp = await router.complete({
    model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: '判断"断言"是否能从"上下文"中推出。只回答 yes 或 no，不要解释。',
      },
      { role: 'user', content: `上下文：\n${ctxJoined}\n\n断言：${claim}\n\n能推出吗？` },
    ],
  });
  return /^yes/i.test(resp.content.trim());
}

export function faithfulness(opts: FaithfulnessOpts): Scorer {
  const ctxField = opts.contextField ?? 'retrievedContexts';

  const scorer: NamedScorer = async (state) => {
    const answer = state.output?.completion ?? '';
    const contexts = (state.metadata[ctxField] as string[] | undefined) ?? [];
    if (!answer) {
      return { value: 0, scorer: 'faithfulness', explanation: '没有回复' };
    }
    if (contexts.length === 0) {
      return { value: 0, scorer: 'faithfulness', explanation: '没有 retrieved contexts' };
    }
    const claims = await extractClaims(opts.judgeRouter, opts.judgeModel, answer);
    if (claims.length === 0) {
      return { value: 1, scorer: 'faithfulness', explanation: '回复中无可验证断言' };
    }
    let supported = 0;
    for (const c of claims) {
      if (await isSupportedByContext(opts.judgeRouter, opts.judgeModel, c, contexts)) {
        supported += 1;
      }
    }
    const value = supported / claims.length;
    const score: Score = { value, scorer: 'faithfulness' };
    if (value < 1) {
      score.explanation = `${supported}/${claims.length} 断言能从 context 推出（faithfulness=${value.toFixed(2)}）`;
    }
    return score;
  };
  scorer.scorerName = 'faithfulness';
  return scorer;
}
