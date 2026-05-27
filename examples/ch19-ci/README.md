# ch19-ci

第 19 章配套 demo —— CI 守门：用 `evalkit ci` 对比两次评测，超阈值或显著退化时 exit 1。

```bash
# 推荐直接用 CLI
npx evalkit ci baseline.jsonl candidate.jsonl --regression-threshold 0

# 或通过本 demo（同样效果）
npx tsx src/eval.ts baseline.jsonl candidate.jsonl
```

## GitHub Actions 示例

```yaml
- name: eval baseline
  run: cd examples/ch17-dataset-v2 && npm run eval && cp runs/*.jsonl /tmp/baseline.jsonl
- name: eval candidate (after change)
  run: cd examples/ch17-dataset-v2 && npm run eval && cp runs/*.jsonl /tmp/candidate.jsonl
- name: CI gate
  run: npx evalkit ci /tmp/baseline.jsonl /tmp/candidate.jsonl --regression-threshold 0
```
