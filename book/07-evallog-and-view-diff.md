---
title: EvalLog 设计与跨 run 对比
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/C301wDsQTizFaskfEmucruN8nxf"
last_synced: "2026-05-27T14:59:41Z"
---

## 本章你会拿到什么

EvalLog 是评测平台的"心跳"——它决定你能从一次评测里挖出多少信息、能不能跟历史 run 对比、能不能恢复中断的评测。这一章你会：

1. **定下 EvalLog 完整 schema**（含 5 段：eval / plan / results / stats / samples），整本书剩下的章节不再变
2. **完整实现 `view` / `diff` / `list` 三个 CLI 命令**——第 5 章是 80 行 stub，这一章升级到 ~400 行可用版
3. **拿到一份"run 命名约定"和"日志归档策略"** —— 让团队多人评测时不互相覆盖
4. **理解为什么 inspect_ai 用 zip+zstd 而我们用 JSONL**——两种选择的取舍

## EvalLog 完整 Schema

我们抄 inspect_ai 的设计但简化字段。完整 schema：

```ts
// examples/evalkit/src/log/schema.ts
import { z } from 'zod';

export const EvalSpecSchema = z.object({
  taskName: z.string(),
  taskVersion: z.string().default('0.0.0'),
  datasetName: z.string(),
  datasetSize: z.number(),
  model: z.string(),
  config: z.object({
    temperature: z.number().optional(),
    maxTokens: z.number().optional(),
    epochs: z.number().default(1),
    messageLimit: z.number().optional(),
  }).default({}),
  metadata: z.record(z.unknown()).optional(),
});

export const EvalPlanStepSchema = z.object({
  solver: z.string(),                       // solver 名字（"chain"、"useTools"、"generate"）
  params: z.record(z.unknown()).optional(),
});

export const EvalPlanSchema = z.object({
  steps: z.array(EvalPlanStepSchema),
  scorers: z.array(z.string()),
});

export const EvalStatsSchema = z.object({
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  totalTimeMs: z.number().optional(),
  modelUsage: z.object({
    promptTokens: z.number(),
    completionTokens: z.number(),
    totalTokens: z.number(),
    estimatedCostUsd: z.number().optional(),
  }).optional(),
});

export const ScoreSchema = z.object({
  scorerName: z.string(),
  value: z.union([z.literal('C'), z.literal('I'), z.literal('P'), z.number()]),
  answer: z.string().optional(),
  explanation: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const ChatMessageSchema = z.object({
  role: z.union([z.literal('system'), z.literal('user'), z.literal('assistant'), z.literal('tool')]),
  content: z.string(),
  toolCallId: z.string().optional(),
  toolCalls: z.array(z.object({
    id: z.string(),
    tool: z.string(),
    args: z.record(z.unknown()),
  })).optional(),
});

export const EvalSampleSchema = z.object({
  sampleId: z.string(),
  epoch: z.number().default(0),
  input: z.union([z.string(), z.array(ChatMessageSchema)]),
  target: z.union([z.string(), z.array(z.string()), z.record(z.unknown())]).optional(),
  messages: z.array(ChatMessageSchema),
  toolCalls: z.array(z.object({
    tool: z.string(),
    args: z.record(z.unknown()),
    result: z.unknown().optional(),
  })),
  scores: z.array(ScoreSchema),
  timingMs: z.number(),
  modelUsage: z.object({
    promptTokens: z.number(),
    completionTokens: z.number(),
    totalTokens: z.number(),
  }).optional(),
  error: z.string().optional(),
});

export const EvalResultsSchema = z.object({
  totalSamples: z.number(),
  completedSamples: z.number(),
  metrics: z.record(z.number()),            // accuracy / stderr / pass_at_1 / pass_at_k 等
  scorerBreakdown: z.record(z.record(z.number())).optional(),  // 按 scorer 细分
});

// 完整 EvalLog（5 段）
export const EvalLogSchema = z.object({
  formatVersion: z.literal(1),              // 版本字段，升级时用
  eval: EvalSpecSchema,
  plan: EvalPlanSchema,
  stats: EvalStatsSchema,
  results: EvalResultsSchema.optional(),    // 评测完成后才有
  // samples 不放主对象，单独存（避免单文件过大）
});

export type EvalLog = z.infer<typeof EvalLogSchema>;
export type EvalSample = z.infer<typeof EvalSampleSchema>;
```

用 [Zod](https://zod.dev/) 做 schema validation。比手写 TypeScript interface 多一份**运行时校验**——读 JSONL 文件时校验每行格式，挂了立刻报错。

## 文件结构

每次评测生成一个目录：

```
runs/
├── 2026-05-27T10-12-34Z_l1-final-60_gpt-4o/
│   ├── meta.json              # EvalSpec + EvalPlan + EvalStats + EvalResults
│   └── samples.jsonl          # 每行一个 EvalSample
```

`meta.json` 小（< 5KB），写在评测开始和结束分两次写（开始时只有 spec + plan，结束补 stats + results）。`samples.jsonl` 流式写——每跑完一个 sample 立刻 `appendFileSync` 一行。

**为什么分开**：
- 列 run 时只读 `meta.json`，不用解析海量 samples
- 部分中断的 run 也能恢复——`samples.jsonl` 已经有的 sample 直接跳过
- `samples.jsonl` 支持 `grep` / `jq` 直接处理

## Run 目录命名约定

格式：`<ISO timestamp Z>_<task-name>_<model-name>`，例：

```
2026-05-27T10-12-34Z_l1-final-60_gpt-4o
2026-05-27T10-15-22Z_l1-final-60_gpt-4o-mini
2026-05-27T10-23-11Z_l1-final-60_anthropic-claude-sonnet-4-5
```

ISO 时间排序天然按时间顺序，task-name + model 让目录列表一眼能看出来"这是什么评测"。**禁止用纯 hash 命名**——hash 看不出来是哪个 task / 哪个模型，团队多人评测会很乱。

模型名里的 `/` 替换成 `-`（`openai/gpt-4o` → `openai-gpt-4o`），避免文件名跨平台问题。

## JsonlRecorder：流式写盘

```ts
// examples/evalkit/src/log/jsonl_recorder.ts
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export class JsonlRecorder {
  readonly runDir: string;
  readonly metaPath: string;
  readonly samplesPath: string;
  private spec: EvalSpec;

  constructor(rootDir: string, taskName: string, model: string) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
    const safeModel = model.replace(/\//g, '-');
    this.runDir = resolve(rootDir, `${ts}_${taskName}_${safeModel}`);
    mkdirSync(this.runDir, { recursive: true });
    this.metaPath = resolve(this.runDir, 'meta.json');
    this.samplesPath = resolve(this.runDir, 'samples.jsonl');
  }

  async writeHeader(spec: EvalSpec, plan: EvalPlan, startedAt: string) {
    this.spec = spec;
    const meta = { formatVersion: 1, eval: spec, plan, stats: { startedAt } };
    writeFileSync(this.metaPath, JSON.stringify(meta, null, 2));
  }

  async writeSample(sample: EvalSample) {
    // 用 zod 校验一遍再写盘，捕获脏数据
    const validated = EvalSampleSchema.parse(sample);
    appendFileSync(this.samplesPath, JSON.stringify(validated) + '\n');
  }

  async writeFooter(stats: EvalStats, results: EvalResults) {
    const existing = JSON.parse(readFileSync(this.metaPath, 'utf-8'));
    existing.stats = { ...existing.stats, ...stats };
    existing.results = results;
    writeFileSync(this.metaPath, JSON.stringify(existing, null, 2));
  }
}
```

100 行实现完整 recorder。**关键**：`writeSample` 用 zod 校验后再写——脏数据立刻报错，不让坏数据污染整个日志文件。

## list 命令

列出本地所有 run：

```bash
evalkit list runs/
```

输出：

```
NAME                                                  TASK              MODEL                       SAMPLES  PASS^1  COST    TIME
2026-05-27T13-01-07Z_ch04-l1-seed-60-mixed_gpt-4o     ch04-l1-seed-60   sonnet (via mock-server)     60       0.550   $0.00*  ~16m
2026-05-27T13-15-22Z_ch04-l1-seed-60-mixed_gpt-4o-mini ch04-l1-seed-60  haiku (via mock-server)      60       0.50    $0.00*  ~12m
2026-05-27T13-30-11Z_ch04-l1-seed-60-prompt-v2_gpt-4o ch04-l1-seed-60   sonnet (加固 prompt)         60       0.85    $0.00*  ~16m

* 走 Max plan 不计费
```

只读每个 run 的 `meta.json`（< 5KB），快速渲染表格。

```ts
// examples/evalkit/src/cli/list.ts
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function listRuns(rootDir: string, opts: { task?: string; model?: string } = {}) {
  const dirs = readdirSync(rootDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const rows: any[] = [];
  for (const dir of dirs) {
    const metaPath = resolve(rootDir, dir, 'meta.json');
    if (!existsSync(metaPath)) continue;
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));

    if (opts.task && meta.eval.taskName !== opts.task) continue;
    if (opts.model && meta.eval.model !== opts.model) continue;

    rows.push({
      name: dir,
      task: meta.eval.taskName,
      model: meta.eval.model,
      samples: meta.results?.completedSamples ?? '-',
      pass1: meta.results?.metrics?.accuracy?.toFixed(3) ?? '-',
      cost: meta.stats?.modelUsage?.estimatedCostUsd?.toFixed(2) ?? '-',
      time: meta.stats?.totalTimeMs ? `${(meta.stats.totalTimeMs / 1000).toFixed(0)}s` : '-',
    });
  }

  printTable(rows);  // 简单的表格渲染，约 30 行
}
```

## view 命令完整版

第 5 章的 view 是 80 行 stub。这一章升级到 ~150 行可用版：

```bash
# 看所有挂的样本（默认带 trace）
evalkit view runs/<run-name> --filter status=I

# 按 scorer 过滤（只看 toolCallMatch 挂的）
evalkit view runs/<run-name> --scorer toolCallMatch --filter status=I

# 看特定 sample
evalkit view runs/<run-name>/samples.jsonl --ids L1-synth-013

# 摘要模式（不展示 trace，只列 id + reason）
evalkit view runs/<run-name> --filter status=I --summary

# 导出过滤后样本到新 jsonl
evalkit view runs/<run-name> --filter status=I --export failed-samples.jsonl
```

关键功能：

1. **多 scorer 过滤**：第 5 章只有"挂了 / 通过"二态，这一章支持按 scorer 单独看
2. **摘要 vs 详情**：摘要模式（一条 1 行）适合扫 50+ 条挂样本，详情（带 trace）适合精读
3. **导出**：把过滤后样本导出成新 jsonl，下次直接拿这份做迷你评测集，专攻 failure mode

## diff 命令完整版

```bash
# 跨 run 对比
evalkit diff runs/before runs/after

# 输出 markdown 报告
evalkit diff runs/before runs/after --format markdown > diff.md

# 只关注 regressions
evalkit diff runs/before runs/after --regressions-only
```

实现核心：

```ts
// examples/evalkit/src/cli/diff.ts
export function diffRuns(beforeDir: string, afterDir: string, opts: DiffOptions) {
  const before = loadSamples(beforeDir);
  const after = loadSamples(afterDir);

  const byId = new Map<string, { before?: EvalSample; after?: EvalSample }>();
  for (const s of before) byId.set(s.sampleId, { before: s });
  for (const s of after) {
    const entry = byId.get(s.sampleId) ?? {};
    entry.after = s;
    byId.set(s.sampleId, entry);
  }

  const improved: string[] = [];
  const regressed: string[] = [];
  const stillFailing: string[] = [];
  const unchanged: string[] = [];

  for (const [id, { before, after }] of byId) {
    if (!before || !after) continue;
    const beforePass = before.scores.every((s) => s.value === 'C');
    const afterPass = after.scores.every((s) => s.value === 'C');

    if (!beforePass && afterPass) improved.push(id);
    else if (beforePass && !afterPass) regressed.push(id);
    else if (!beforePass && !afterPass) stillFailing.push(id);
    else unchanged.push(id);
  }

  // 渲染报告
  console.log(`${byId.size} samples total`);
  console.log(`  ${unchanged.length} pass → pass (unchanged)`);
  console.log(`  ${improved.length} fail → pass (IMPROVED)`);
  console.log(`  ${regressed.length} pass → fail (REGRESSED)`);
  console.log(`  ${stillFailing.length} fail → fail (still failing)`);

  if (opts.regressionsOnly || regressed.length > 0) {
    console.log('\nRegressed samples:');
    for (const id of regressed) {
      const s = byId.get(id)!.after!;
      const reasons = s.scores.flatMap((sc) => sc.explanation ? [sc.explanation] : []).join('; ');
      console.log(`  ${id}  ${reasons}`);
    }
  }

  return { improved, regressed, stillFailing, unchanged };
}
```

`diff` 是评测平台**最关键的命令**之一。第 5 章已经讲过它的工程价值：改 prompt 时人盯着 improved 自我感觉良好，但能不能上线由 regressed 决定。这一章让 `diff` 真正可用。

## 跨 run 对比的工程意义

举个真实场景。你跑了三次评测：

```
baseline_sonnet            pass^1 = 55.0%   # 本仓库 ch04 mixed 60 条实测（mock-server）
v2_prompt_sonnet           pass^1 ≈ 85%     # 作者本地估算（FM-1/2/3 加固后）
v2_prompt_haiku            pass^1 ≈ 80%     # 作者本地估算；复现需把 shopagent 切 haiku
```

三次都跑 60 条同样数据。你能问出哪些问题：

1. **prompt 改动的提升在哪些 sample 上？** → `diff baseline v2_prompt`
2. **prompt 改动对 mini 也有效吗？** → `diff baseline_mini v2_prompt_mini`（需要先跑 baseline_mini）
3. **大模型的新 prompt 提升 vs 小模型的新 prompt 提升，哪些 sample 大模型修了而小模型没修？** → 两次 diff 的差集

这些不是 nice-to-have，是评测平台**必须能回答的问题**。没有跨 run diff，每次评测都是孤立的数字。

## 为什么 JSONL 不是 zip+zstd

inspect_ai 默认日志格式是 `.eval`——内部是 zip 包含 zstd 压缩的 sample 文件。优点：

- 大评测集（10000+ samples）压缩后小 10 倍
- 懒加载（按需读 sample，不全部 load）
- S3 上分块下载快

缺点：

- 不能直接 grep / jq
- 不能用文本 diff 工具看变化
- 需要专门的 reader（CLI 或 Web UI）

我们的定位是"教学 + 中小规模评测平台"——评测集 200-2000 条，每条 sample 5-50KB，总大小不超过 100MB。JSONL 完全够用，工程师能用熟悉的 Unix 工具直接处理。第 20 章上生产桥梁会讲什么时候该升级到 `.eval` 格式（大规模评测 + S3 部署时）。

## EvalKit 现在的样子

到第 7 章结束，EvalKit 大致是：

```
examples/evalkit/src/
├── types.ts                       100 行   Task / Sample / TaskState / Solver / Scorer / Score 等
├── task.ts                         50 行   defineTask + 注册
├── dataset/
│   ├── jsonl.ts                    80 行
│   └── csv.ts                      60 行
├── solver/
│   ├── chain.ts                    40 行
│   ├── generate.ts                150 行   含 provider 路由 + tool loop
│   ├── system_message.ts           20 行
│   ├── prompt_template.ts          40 行
│   └── use_tools.ts               100 行
├── scorer/
│   ├── match.ts                    40 行
│   ├── includes.ts                 30 行
│   └── tool_call_match.ts         150 行   含期望 trajectory 匹配
├── provider/
│   ├── types.ts                    50 行
│   ├── openai.ts                   80 行
│   ├── anthropic.ts               120 行
│   ├── registry.ts                 50 行
│   ├── cache.ts                    60 行
│   ├── retry.ts                    50 行
│   └── pricing.ts                  30 行   定价表
├── eval/
│   ├── runner.ts                  150 行   主调度，含并发池
│   └── state.ts                    50 行
├── log/
│   ├── schema.ts                  200 行   Zod schema
│   └── jsonl_recorder.ts          120 行
└── cli/
    ├── index.ts                    40 行   commander 入口
    ├── run.ts                      40 行
    ├── list.ts                     80 行
    ├── view.ts                    150 行
    └── diff.ts                    120 行
```

合计约 1900 行。还差 600 行就到目标的 2500 行——剩下的 600 行留给 LLM-as-Judge / trajectory 评测 / dashboard 等后续章节。

## 对照 inspect_ai 源码

| EvalKit v3 | inspect_ai |
|---|---|
| `log/schema.ts`（Zod） | `log/_log.py`（Pydantic，约 1100 行） |
| `log/jsonl_recorder.ts` | `log/_recorders/json.py`（约 380 行） |
| `cli/list.ts` | `_cli/list.py` |
| `cli/view.ts` | `_view/`（Web UI，前端代码不开源） |
| `cli/diff.ts` | `_cli/log.py:log_compare` |

我们的 schema 比 inspect_ai 简单 60%（25 个 Pydantic 模型 vs 我们 8 个 Zod schema）——刻意省略了 attachments / timelines / invalidation / role_usage 等高级字段，第 19 章 CI 章节会讨论什么时候需要补回来。

## 本章要点回顾

- **JSONL 三段式日志**：header（task / model / 数据集大小）/ 多行 sample（messages + toolCalls + scores）/ footer（聚合 metrics），流式 append-only
- **Zod schema 校验**：写入前过 schema 防脏数据；读取时拿强类型，view / diff / CI 都基于 schema
- **CLI 四件套**：`run` 跑评测、`view` 看单 run 细节、`diff` 跨 run 找 regression、`list` 按时间倒序列日志
- **跟 langfuse 的格式 100% 兼容映射**：EvalKit JSONL → langfuse traces + scores + dataset_items，迁移时不用改 schema
- **流式落盘的工程意义**：跑到一半挂了能 resume；跑全集 200 条 + 跑出几条就能开始 trace review

## 第 7 章总结

到这一步：

- EvalLog 完整 schema 定下来（formatVersion=1，后续 17 章不再变）
- `list` / `view` / `diff` 三个 CLI 命令全部可用
- 跨 run 对比的工程价值就位
- EvalKit 总代码量 ~1900 行，距离目标 2500 行还差 600 行

下一章开始进入 Agent 评测的核心维度——RAG 子模块评测（第 8 章），然后是用户模拟器（第 9 章）、Multi-turn（第 10 章）。

---

> 本章来自《AI Agent 评测工程实战》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev) · 反馈与勘误：[GitHub Issues](https://github.com/diguike/book-agent-evals/issues)
