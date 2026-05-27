// pairwiseJudge —— ch13：两个模型/prompt/版本的回复让 judge 选哪个更好
// 配合 Bradley-Terry / Elo 算总分（ch14 stats）
import type { Scorer, NamedScorer, Score } from '../../types.js';
import type { ProviderRouter } from '../../provider/router.js';

interface PairwiseOpts {
  judgeRouter: ProviderRouter;
  judgeModel: string;
  /** 'B' 的 completion 从 state.metadata.candidateB 取 */
  candidateField?: string;
  /** 反转顺序跑两次取均值（消除 position bias），默认 true */
  reduceBias?: boolean;
}

async function judgeOnce(
  router: ProviderRouter,
  model: string,
  question: string,
  a: string,
  b: string,
): Promise<'A' | 'B' | 'TIE'> {
  const resp = await router.complete({
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: '比较两个回复哪个更好。只回答 "A" / "B" / "TIE"，不要解释。' },
      { role: 'user', content: `问题：${question}\n\n回复 A：${a}\n\n回复 B：${b}\n\n更好的是？` },
    ],
  });
  const first = resp.content.trim().toUpperCase().split(/\s+/)[0] ?? '';
  if (first.startsWith('A')) return 'A';
  if (first.startsWith('B')) return 'B';
  return 'TIE';
}

export function pairwiseJudge(opts: PairwiseOpts): Scorer {
  const field = opts.candidateField ?? 'candidateB';
  const reduceBias = opts.reduceBias ?? true;

  const scorer: NamedScorer = async (state) => {
    const question = typeof state.sample.input === 'string' ? state.sample.input : '';
    const a = state.output?.completion ?? '';
    const b = (state.metadata[field] as string | undefined) ?? '';
    if (!b) {
      return { value: 'I', scorer: 'pairwise_judge', explanation: `state.metadata.${field} 为空` };
    }
    const r1 = await judgeOnce(opts.judgeRouter, opts.judgeModel, question, a, b);
    let winner: 'A' | 'B' | 'TIE' = r1;
    if (reduceBias) {
      const r2 = await judgeOnce(opts.judgeRouter, opts.judgeModel, question, b, a);
      // 第二次跑时 A/B 反转，所以 r2='A' 实际是原 B 赢
      const r2flip: 'A' | 'B' | 'TIE' = r2 === 'A' ? 'B' : r2 === 'B' ? 'A' : 'TIE';
      if (r1 === r2flip) {
        winner = r1;
      } else {
        winner = 'TIE';
      }
    }
    // A 是 state（被评测对象），赢 → C；B 赢 → I；tie → P
    const value: Score['value'] = winner === 'A' ? 'C' : winner === 'B' ? 'I' : 'P';
    return {
      value,
      scorer: 'pairwise_judge',
      metadata: { winner, biasReduced: reduceBias },
    };
  };
  scorer.scorerName = 'pairwise_judge';
  return scorer;
}
