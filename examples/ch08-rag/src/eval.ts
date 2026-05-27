// ch08 demo —— RAG 评测 (context_precision / recall / faithfulness / answer_relevancy)
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defineTask,
  jsonlDataset,
  chain,
  contextPrecision,
  contextRecall,
  runTask,
  getDefaultRouter,
  type Solver,
} from '@inferloop/evalkit';
import { searchFaq } from '@inferloop/shopagent';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ragSolver: Solver = async (state) => {
  const query = typeof state.sample.input === 'string' ? state.sample.input : '';
  // 1. 检索
  const ctxs = searchFaq(query, 3).map((f) => f.answer);
  state.metadata.retrievedContexts = ctxs;
  // 2. 生成（用 LLM 拿 context 回答）
  const router = getDefaultRouter();
  const resp = await router.complete({
    model: process.env.MODEL ?? 'gpt-4o-mini',
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: '基于以下 FAQ 上下文回答用户问题。如果上下文不相关，直接说不知道。',
      },
      {
        role: 'user',
        content: `问题：${query}\n\n参考资料：\n${ctxs.map((c, i) => `[${i + 1}] ${c}`).join('\n')}`,
      },
    ],
  });
  state.output = { completion: resp.content };
  state.messages.push({ role: 'user', content: query });
  state.messages.push({ role: 'assistant', content: resp.content });
  return state;
};

// 修正 target 字段名（rag dataset 里是 expectedContexts，sample.target 已经是对象）
const task = defineTask({
  name: 'ch08-rag-faq',
  dataset: jsonlDataset(resolve(__dirname, '../../eval-datasets/rag/v1.0.0.jsonl'), { limit: 20 }),
  solver: chain(ragSolver),
  scorer: [contextPrecision(), contextRecall()],
});

await runTask(task, {
  model: process.env.MODEL ?? 'gpt-4o-mini',
  outputDir: resolve(__dirname, '../runs'),
  concurrency: 4,
});
