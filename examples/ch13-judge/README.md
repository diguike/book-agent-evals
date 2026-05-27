# ch13-judge

第 13 章配套 demo —— LLM-as-Judge：用 GPT-4o 给被测 agent 的回复打分。

```bash
npm run eval                    # 默认 judge=gpt-4o，agent=gpt-4o-mini
JUDGE_MODEL=gpt-4o-mini npm run eval   # 同模型自评（一致性会差）
```
