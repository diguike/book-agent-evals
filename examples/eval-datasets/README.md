# eval-datasets

ShopAgent 评测集，全部 JSONL 格式。**这套数据是合成的**——所有手机号、地址、姓名都不是真实 PII。

| 数据集 | 版本 | 条数 | 用途 |
|---|---|---|---|
| `l1/v2.0.0.jsonl` | v2.0.0 | 200 | L1 单轮评测，覆盖 8 工具 |
| `l2/v2.0.0.jsonl` | v2.0.0 | 100 | L2 多轮评测，3-6 轮 |
| `l3/v1.0.0.jsonl` | v1.0.0 | 40 | L3 对抗集 / Red team |
| `rag/v1.0.0.jsonl` | v1.0.0 | 50 | RAG 评测，FAQ 问答 |

## 重新生成

```bash
# 先确保 ShopAgent DB 已 seed
cd ../shopagent && npm run seed && cd ../eval-datasets

# 跑生成器（用同样的 seed=42，结果可复现）
npm run generate
```

生成器源码在 `src/generate.ts`。每条样本的 `id` 形如 `L1-001` / `L2-001` / `L3-001` / `RAG-001`。

## 字段约定

```jsonc
{
  "id": "L1-001",
  "input": "查一下 o_50000 到哪了",              // 用户输入（多轮时是数组）
  "target": {
    "expectedToolCalls": [...],                  // ch03 toolCallMatch 用
    "expectedResponseContains": [...],            // ch03 includes 用
    "expectedTrajectory": [...],                  // ch11 trajectory_match 用
    "expectedFinalState": {...},                  // ch10 session_completion 用
    "expectedDbDelta": {...},                     // ch11 db_state_delta 用
    "forbiddenTools": [...]                       // ch11 trajectory_match 用
  },
  "metadata": {
    "category": "query_order",                    // 给错误分析分类用（ch05）
    "difficulty": "easy" | "medium" | "hard",
    "persona": "中年女性、新手卖家",                 // ch09 user_simulator 用
    "turns": [...]                                // ch10 multiTurn 用
  }
}
```
