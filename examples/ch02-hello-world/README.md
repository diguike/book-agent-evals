# ch02-hello-world：EvalKit minimal 的第一个评测

配套书章节：[book/02-hello-world-eval.md](../../book/02-hello-world-eval.md)

## 跑起来

```bash
# 第一次：在仓库根装依赖
cd ../..
npm install
npm run doctor

# 跑评测（默认 GPT-4o）
cd examples/ch02-hello-world
npm run eval

# 换模型
MODEL=gpt-4o-mini npm run eval
```

## 输出

```
[evalkit-minimal] 评测开始：10 条样本，模型 gpt-4o
✓ L1-001 (1284ms)
✓ L1-002 (1142ms)
...
[evalkit-minimal] pass^1 = 0.800 (8/10)
[evalkit-minimal] 日志已写入：runs/2026-05-27T05-12-34-xyz_gpt-4o.jsonl
```

## 文件清单

```
ch02-hello-world/
├── README.md                       # 本文件
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts                    # 100 行 minimal 评测循环
├── datasets/
│   └── l1-seed-10.jsonl            # 10 条 L1 评测样本
└── runs/                           # 评测结果（gitignored）
    └── <timestamp>_<model>.jsonl
```

## 前置依赖

- `@inferloop/shopagent`：被评测对象，仓库内 `examples/shopagent/` 提供
- `OPENAI_API_KEY` 环境变量（在仓库根 `.env` 配置）
- Node ≥ 20

## 已知限制（下一章会改善）

- 同步串行跑，10 条要约 15 秒
- 只有简单 match scorer，没有 LLM-as-Judge
- 没有 trajectory 顺序检查
- 只看 pass^1，看不到一致性

详见 [book/02-hello-world-eval.md](../../book/02-hello-world-eval.md) 末尾"缺陷清单"小节。
