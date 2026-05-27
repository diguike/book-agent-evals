# ch07-evallog

第 7 章配套 demo —— EvalLog Zod schema + view/diff CLI。

```bash
# 列日志 + 看失败样本
npm run eval

# 用 evalkit CLI
npx evalkit list runs
npx evalkit view runs/<file>.jsonl --failed-only --trajectory
npx evalkit diff old.jsonl new.jsonl --trajectory
```
