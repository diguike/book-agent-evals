---
title: 第 20 章　Dashboard 与生产部署
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/UmEbwokc5iwnlvkN5CJc0zahnMc"
last_synced: "2026-06-03T04:15:15Z"
---

## 本章你会拿到什么

CLI 评测够日常，但**多人协作 + 长期趋势可视化**需要 dashboard。这一章你会：

1. **拿到 EvalKit Dashboard 教学 demo**：[Node.js 原生 http](https://nodejs.org/api/http.html) + JSONL 直读，约 80 行 TS，本地启动即用，浏览器看 run 列表 + 单 run 详情
2. **看到一个最小可上线 dashboard 该有的东西**：run 列表 / 单 run 详情 / failure case 抽查
3. **学会什么时候该从 EvalKit demo 迁移到 langfuse / Arize Phoenix / 自研 Next.js 版本**——迁移路径明确
4. **理解 EvalKit 的局限**：它不是一切，知道什么时候放下它

代码：`examples/ch20-dashboard/src/eval.ts`（80 行 node:http 服务，读 ch04 / ch11 / ch17 跑出的 jsonl 日志渲染 HTML 表格）。**这章故意保持极简**：教学场景验证"dashboard 长什么样、能解决什么问题"够用；生产部署直接上 langfuse 或自己写 Next.js + SQLite 重做（章节后半段给出迁移指引）。

## 为什么本地 SQLite 而不是云平台

第 7 章我们决定用 JSONL 作为日志格式。Dashboard 怎么实现？两个选择：

A. **直接读 JSONL**：每次刷新页面扫所有 run 目录
B. **SQLite 索引**：把 JSONL 元数据 sync 到 SQLite，dashboard 查 SQLite

10 个 run 时 A 够用，100 个 run 时 A 卡，1000 个 run 时 A 直接挂。

**本章 demo 选 A**（教学场景 < 50 个 run，直接读 JSONL 最简单，零依赖）；**生产场景应该上 B**（SQLite 索引）或者直接接 langfuse。两条路径在章节后半段都会讲。

```
runs/                              # 各章节产生的 JSONL 日志（source of truth）
├── ch04-dataset-seed/runs/<ts>_<task>_<model>.jsonl
├── ch11-trajectory/runs/<ts>_<task>_<model>.jsonl
└── ch17-dataset-v2/runs/<ts>_<task>_<model>.jsonl

# 本章 demo 直接扫这些目录，零索引零数据库。
# 演进到生产时引入：
.evalkit-dashboard/                # 本地 dashboard 存储（gitignored）
├── index.db                       # SQLite 索引（演进方向，本章 demo 没用）
└── cache/
```

SQLite schema 简单：

```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY,             -- run 目录名
  task_name TEXT,
  model TEXT,
  dataset_name TEXT,
  dataset_version TEXT,
  total_samples INTEGER,
  pass_rate REAL,
  total_cost_usd REAL,
  duration_ms INTEGER,
  started_at TEXT,
  completed_at TEXT,
  metadata JSON
);

CREATE TABLE sample_results (
  run_id TEXT,
  sample_id TEXT,
  passed INTEGER,                  -- boolean
  scores JSON,                     -- 多 scorer 结果
  failure_mode TEXT,                -- 如果挂，归类
  PRIMARY KEY (run_id, sample_id),
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE INDEX idx_runs_task_started ON runs(task_name, started_at);
CREATE INDEX idx_samples_pass ON sample_results(run_id, passed);
```

每次新 run 完成后 EvalKit CLI 自动 sync 到 SQLite：

```ts
// examples/evalkit/src/dashboard/sync.ts
export async function syncRunToDb(runDir: string, db: Database) {
  const meta = JSON.parse(readFileSync(`${runDir}/meta.json`, 'utf-8'));
  db.prepare(`
    INSERT OR REPLACE INTO runs (id, task_name, model, ...)
    VALUES (?, ?, ?, ...)
  `).run(meta.eval.taskName, ...);

  const samples = readFileSync(`${runDir}/samples.jsonl`, 'utf-8')
    .trim().split('\n')
    .map((l) => JSON.parse(l));

  const insertSample = db.prepare(`INSERT OR REPLACE INTO sample_results VALUES (?, ?, ?, ?, ?)`);
  for (const sample of samples) {
    insertSample.run(
      meta.id, sample.sampleId,
      sample.scores.every((s) => s.value === 'C') ? 1 : 0,
      JSON.stringify(sample.scores),
      classifyFailureMode(sample),
    );
  }
}
```

dashboard 启动时跑一次全量 sync，之后增量 sync（监听 runs/ 目录变化）。

## Dashboard 页面设计

```
/                    Runs 列表（按时间 / task 排序）
/run/[id]            单 run 详情：metrics 卡片 + 200 条 samples 表格
/run/[id]/sample/[sid]  单 sample 详情：trace 完整渲染
/diff/[a]/[b]        两个 run 对比（improved / regressed 列表）
/trends/[task]       特定 task 的历史趋势：pass^1 曲线 / cost / failure mode 分布演化
/datasets            评测集列表 + 版本对比
```

这 6 个页面是**完整生产 dashboard 的目标蓝图**。本章 demo 故意做了极致简化——只实现"/"（run 列表）和 "/log?path=..."（单 run 详情），两条路径 + 几十行 HTML 字符串模板就能验证 dashboard 这个动作能解决什么问题。剩下的 trends / diff / datasets 等页面是**生产化时的演进方向**：直接用 [Next.js 14 App Router](https://nextjs.org/docs/app) + [shadcn/ui](https://ui.shadcn.com)（基于 Radix + Tailwind 的 React 组件库，组件代码直接复制到项目里而不是 npm install）按这个蓝图扩展即可。

## Runs 列表页

```tsx
// examples/evalkit/src/dashboard/app/page.tsx
export default async function RunsPage() {
  const runs = db.prepare(`
    SELECT * FROM runs
    ORDER BY started_at DESC
    LIMIT 50
  `).all();

  return (
    <div className="container mx-auto py-6">
      <h1 className="text-2xl font-semibold mb-6">Evaluation Runs</h1>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Started</TableHead>
            <TableHead>Task</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Samples</TableHead>
            <TableHead>Pass^1</TableHead>
            <TableHead>Cost</TableHead>
            <TableHead>Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow key={run.id}>
              <TableCell>{formatDate(run.started_at)}</TableCell>
              <TableCell>
                <Link href={`/run/${run.id}`} className="text-blue-600 hover:underline">
                  {run.task_name}
                </Link>
              </TableCell>
              <TableCell><Badge>{run.model}</Badge></TableCell>
              <TableCell>{run.total_samples}</TableCell>
              <TableCell>
                <PassRateBadge value={run.pass_rate} />
              </TableCell>
              <TableCell>${run.total_cost_usd.toFixed(2)}</TableCell>
              <TableCell>{(run.duration_ms / 1000).toFixed(0)}s</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

100 行内的列表页。**PassRateBadge** 是个简单组件：> 90% 绿、80-90% 黄、< 80% 红。

## Trends 页（最有价值的一页）

历史趋势——一个 task 在过去 30 天 / 90 天 / 1 年的 pass^1 演化：

```tsx
// examples/evalkit/src/dashboard/app/trends/[task]/page.tsx
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';

export default function TrendsPage({ params }: { params: { task: string } }) {
  const runs = db.prepare(`
    SELECT started_at, model, pass_rate, total_cost_usd
    FROM runs
    WHERE task_name = ? AND started_at > date('now', '-90 days')
    ORDER BY started_at
  `).all(params.task);

  // 按 model 分组（每个 model 一条线）
  const byModel = groupBy(runs, (r) => r.model);

  return (
    <div className="container mx-auto py-6">
      <h1>{params.task} Trend (last 90 days)</h1>

      <LineChart width={900} height={400} data={runs}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="started_at" tickFormatter={formatDate} />
        <YAxis domain={[0, 1]} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
        <Tooltip />
        <Legend />
        {Object.entries(byModel).map(([model, modelRuns]) => (
          <Line key={model} dataKey="pass_rate" data={modelRuns} stroke={modelColor(model)} name={model} />
        ))}
      </LineChart>

      <FailureModeEvolutionChart task={params.task} />
      <CostTrendChart task={params.task} />
    </div>
  );
}
```

3 张图叠加：

1. **pass^1 趋势** —— 看长期是涨还是跌（model drift / 评测集变化的视觉体现）
2. **Failure mode 分布演化** —— 哪个 FM 在增多哪个在减少
3. **Cost 趋势** —— 单次评测 cost 历史，看模型涨价或加 trial 数的影响

这套图是**评测平台的真正价值**——没有它工程师永远不知道 agent 长期质量趋势。

## Diff 页

```
/diff/<run-a-id>/<run-b-id>
```

跟 CLI 的 `evalkit diff` 一样，但 Web 渲染。多了一个**双栏 trace 对比**：左右两栏并排展示 baseline / current 的同一 sample trajectory，按行 diff 显示。

```tsx
// examples/evalkit/src/dashboard/app/diff/[a]/[b]/page.tsx
const { improved, regressed, stillFailing, unchanged } = diffRuns(runA, runB);

return (
  <div>
    <SummaryCard {...stats} />

    <Tabs defaultValue="regressed">
      <TabsList>
        <TabsTrigger value="regressed">Regressed ({regressed.length})</TabsTrigger>
        <TabsTrigger value="improved">Improved ({improved.length})</TabsTrigger>
        <TabsTrigger value="still">Still Failing ({stillFailing.length})</TabsTrigger>
      </TabsList>
      <TabsContent value="regressed">
        {regressed.map((id) => <SampleDiffRow sampleId={id} runA={runA} runB={runB} />)}
      </TabsContent>
      ...
    </Tabs>
  </div>
);
```

打开"Regressed"标签，看每个回归样本的双栏 diff——baseline 的 trace 在左、current 的在右，工具调用对照，回复对照。**5 分钟看完所有回归样本，比 grep JSONL 高效 10 倍**。

## 启动 Dashboard

```bash
cd examples/ch20-dashboard
npm run dashboard
# 等价命令：npm run eval（同一个入口，名字双写为了让书里命令更直白）
```

启动 node:http 服务，默认监听 `:3091`，浏览器打开 `http://localhost:3091`。每次请求实时扫 `ch04 / ch11 / ch17` 的 `runs/` 目录读 jsonl 渲染表格——没有缓存层，10-50 个 run 量级毫秒级，更多就该上 SQLite 索引（演进方向，本章不写）。

部署上生产：

```bash
cd examples/evalkit/src/dashboard
npm run build
npm run start
# 或者 export 成静态 site:
# npm run export → out/ 部署到任意静态 hosting
```

**SQLite + JSONL 都在本地文件**，不需要任何云服务依赖。中小团队完全可以放在内网服务器上，几十个 agent 工程师共享访问。

## 提醒：EvalKit 是教学代号不是产品名

最后特别澄清——**EvalKit 在本书里是教学代号，不是 npm 上可搜索的产品**。GitHub 已有 [evalkit/evalkit](https://github.com/evalkit/evalkit) 是别人的 TS LLM eval 库，跟本书无关。你 git clone 本书仓库 (`diguike/book-agent-evals`) 拿到的"EvalKit"就是 `examples/evalkit/` 这 2500 行 TS，永远不会发布成独立 npm 包。

如果你想在自家公司的 agent 项目里复用这套代码，**建议起一个自己的名字**（比如你公司内部的 codename），改包名和 CLI 命令即可。本书的 EvalKit 是脚手架，不是产品。

## EvalKit Dashboard 的局限

EvalKit Dashboard 设计为"中小规模"——预期场景：

- < 50 工程师并发使用
- < 100 万条 sample（runs × samples）
- 单台服务器 64GB RAM / 1TB SSD 够用

超出这个规模需要迁移：

| 痛点 | 触发条件 | 迁移目标 |
|---|---|---|
| Sample 数太多，SQLite 查询慢 | > 100 万条 | [PostgreSQL](https://www.postgresql.org)（业界事实标准的开源关系数据库）+ [ClickHouse](https://clickhouse.com)（Yandex 开源的列式 OLAP 数据库，分析查询极快） |
| 多团队并发标注 | > 5 个 annotators | argilla / Label Studio |
| 跟 production tracing 系统打通 | 需要 trace 关联 | langfuse / [Arize Phoenix](https://github.com/Arize-ai/phoenix)（Arize AI 出品的开源 LLM observability + 评测平台，本地可起） |
| 需要权限控制 / 审计 | 受合规要求 | 自研平台 |

## 从 EvalKit 迁移到 langfuse

[langfuse](https://github.com/langfuse/langfuse) 是 28k stars 的开源 LLM observability + eval 平台。比 EvalKit 重得多（10 万行 TS + ClickHouse 后端），但**功能完整 + 生产级**。

迁移路径：

### Step 1: 自托管 langfuse

```bash
git clone https://github.com/langfuse/langfuse
cd langfuse
docker-compose up -d
```

5 分钟起一个 langfuse 服务（含 ClickHouse + Postgres + Worker）。

### Step 2: ShopAgent 接 langfuse tracing

```ts
import { observeOpenAI } from 'langfuse';

const tracedClient = observeOpenAI(openaiClient);
// 所有 ShopAgent 的 LLM 调用自动 trace 到 langfuse
```

10 行集成。线上所有对话 trace 进 langfuse。

### Step 3: 把 EvalKit run 导入 langfuse

EvalKit 提供导出脚本：

```bash
evalkit export-langfuse runs/<run-id> --base-url http://localhost:3000 --api-key xxx
```

把 EvalKit JSONL 转换成 langfuse traces + datasets + scores。**EvalKit 的 schema 设计就是为了能无缝映射到 langfuse 的 [OpenTelemetry](https://opentelemetry.io)（CNCF 开源的可观测性标准，定义了 traces/metrics/logs 的统一数据格式和 SDK，业内主流 observability 后端都兼容）格式**（第 7 章 EvalLog schema 在这一点做了对齐）。

**数据格式映射表**（EvalKit → langfuse）：

| EvalKit 字段 | langfuse 字段 | 备注 |
|---|---|---|
| `header.taskName` | `dataset.name` | 一个 task 对应一个 langfuse dataset |
| `header.startedAt` | `trace.timestamp` | 起 trace 的时间 |
| `sample.sampleId` | `trace.metadata.sample_id` + `dataset_item.id` | trace 跟 dataset item 双向引用 |
| `sample.messages[]` | `trace.spans[].input/output` | 每条 message 一个 generation span |
| `sample.toolCalls[]` | `trace.spans[].name='tool_call'` | tool span，name=工具名 |
| `sample.scores[]` | `score[]`（每个 scorer 一个 score 实体） | score.value 直接传 |
| `sample.timingMs` | `trace.latency` | 毫秒数 |
| `sample.output.completion` | `trace.output` | agent 最终回复 |
| `sample.output.usage` | `trace.usage` | tokens 统计 |
| `footer.metrics.accuracy` | `dataset_run.metrics['accuracy']` | run 级聚合指标 |

`evalkit export-langfuse` 命令做这套 schema 转换，并按 langfuse OpenTelemetry POST 接口推上去。迁移完后 langfuse 上能看到完整的 trace 树（含工具调用、score、用量），跟之前在 EvalKit JSONL 里一样的信息密度。

### Step 4: 在 langfuse 上跑评测

langfuse 自带 eval engine：

```ts
import { Langfuse } from 'langfuse';

const lf = new Langfuse({ ... });

await lf.evaluation.create({
  name: 'shopagent-l1-v2',
  dataset: 'l1-v2.0.0',
  evaluator: (sample) => {
    // 你的 scorer，可以从 EvalKit 拷过来
  },
});
```

EvalKit 的 scorer 大多数能直接拷过去（接口签名相似）。migration 的痛点不是代码，是**心智模型**——从"本地 CLI + SQLite"转到"中心化平台"。

### Step 5: 关掉 EvalKit Dashboard

EvalKit CLI 仍然能用（继续在 PR CI 里跑），但 dashboard 切换到 langfuse。

## 什么时候迁移到 langfuse（决策触发条件）

迁移到 langfuse / Arize / Braintrust 有成本——基础设施维护、团队学习曲线、自托管 ops。**触发迁移的三个明确信号**：

1. **团队 > 5 人共享 dashboard**：5 人以下 SQLite + 静态 HTML 就够，每个工程师本地翻 jsonl 也 OK。超过 5 人开始有"我跑过的 run 你看不到"的问题，迁
2. **需要把生产 tracing 跟评测对齐**：production agent 跑出的 trace 要跟历史评测 run 在同一个面板上对比时，必须迁（langfuse 同时支持两者）
3. **PM / QA 想看 dashboard**：他们不会装 npm 跑 CLI，需要 web UI

**保持 EvalKit 不迁的明确信号**：

- **< 5 工程师**：协作压力还在 git diff + PR comment 能解决的范围
- **没有跨团队 review 评测结果的需求**：只有 evaluator/工程师团队看评测
- **没接 production tracing**：评测和生产是两条线
- **本地 PR CI 走 EvalKit CI 足够**：成本 < $200/月可控

**保留 EvalKit 是更好的选择**。本书的 ShopAgent 评测体系完全可以**永远不上 langfuse**。一个折中：先保 EvalKit 跑评测 + 同时往 langfuse 推 traces，等团队大了再做完整迁移。

## 三层评测体系的最终形态

回顾 20 章一路演进，ShopAgent 评测体系长成这样：

```
┌──────────────────────────────────────────────────┐
│ Production tracing (可选)                          │
│   - langfuse / Arize / 自研                        │
│   - 给数据飞轮提供 hard case 输入                    │
└──────────────────────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────┐
│ Data Flywheel                                     │
│   - 4 类信号挖 hard case                           │
│   - LLM 预标 + 人工抽检                             │
│   - PII 清洗 + 入集                                │
└──────────────────────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────┐
│ Eval Datasets (versioned)                         │
│   - L1 v2.x (200 条单轮)                           │
│   - L2 v2.x (100 条多轮)                           │
│   - L3 v1.x (40 条对抗)                            │
│   - RAG v1.x (50 条)                              │
└──────────────────────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────┐
│ EvalKit Framework (2500 行 TS)                    │
│   - Task / Dataset / Solver / Scorer 四件套        │
│   - 11 个内置 scorer                               │
│   - Provider 路由 + 缓存 + 重试 + 并发              │
│   - JSONL EvalLog                                 │
│   - CLI: run / view / diff / list / ci            │
└──────────────────────────────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────┐
│ Dashboard + CI                                    │
│   - 本章 demo: 80 行 node:http（演进方向：Next.js + SQLite）│
│   - GitHub Actions 守门                            │
│   - Slack/飞书通知                                  │
└──────────────────────────────────────────────────┘
```

5 层架构。每一层都能独立工作 + 也能跟上下层组合。这是工程师向 agent 评测体系的合理形态。

## 跟一开始那个周一相比

回到前言的故事——那个 2026 年 1 月某周一，我盯着监控大屏胃里发紧的早晨。如果当时已经有这套评测体系：

1. **退款工具签名改动会触发 CI 评测**——L1 v2 的 200 条样本里至少 5 条覆盖 `refund_order` 参数变化的场景
2. **CI 会显著回归 fail**——two-proportion z-test 给出 p-value < 0.05
3. **PR 不能 merge**——周一上午 11 起异常工单不会发生
4. **Diff 报告直接指出问题**——`L1-synth-013: 工具 refund_order 参数不匹配：amount 期望 199 实际 0`
5. **数据飞轮一周后会从线上日志挖出类似 case** 入下一版评测集，防止其他工程师以后犯同样错误

这套体系不能保证 100% 零事故。但它能把那个胃里发紧的早晨变成"几个回归 CI 提醒、改 PR 继续工作"的平凡半小时。

读完这本书你拿到的不是"完美 agent"——agent 不可能完美。你拿到的是"**让 agent 持续可控演化**的工程基础设施"。

## 最后几条建议

写到最后这 20 章，我想给读者留几条不在章节内的、更接近"经验"的话：

1. **评测先于优化**：在你"觉得 agent 不够好"时，不要先改 prompt。先建评测集（哪怕只有 30 条手写）。没有评测集的优化是赌博。

2. **手写种子的价值被严重低估**：90% 团队跳过手写直接 LLM 合成。结果是评测集同质化，看不出真问题。**前 20 条样本一定要自己一字一字写**。

3. **拥抱不完美的 judge**：LLM-as-Judge 永远不会完美。但配上 Rogan-Gladen 校正 + Cohen's Kappa，它能给你**比规则匹配多 5 倍**的覆盖度。

4. **CI 守门比 dashboard 重要**：很多团队做了花哨 dashboard 但没有 CI 守门，结果还是有人改了 prompt 上线。CI 比 dashboard 重要 10 倍。

5. **持续比一次性重要**：第一版评测集做完只是开始。**数据飞轮跑半年，评测集才真正长成你公司的"agent 标尺"**。

## 对照 langfuse / inspect_ai

| 维度 | EvalKit (本书) | langfuse | inspect_ai |
|---|---|---|---|
| 代码量 | ~2500 行 TS | 10 万行 TS | 15 万行 Python |
| 数据存储 | JSONL + SQLite | ClickHouse + Postgres | 自定义 .eval 格式 |
| 部署难度 | npm install | docker-compose | pip install |
| 学习曲线 | 平缓 | 中等 | 较陡 |
| 适合规模 | < 50 工程师 | 任意 | 任意 |
| 适合场景 | 教学 + 中小团队 | 中大型生产 | safety eval / 学术 |

EvalKit **不是替代品**——读完这本书，你既能直接用 EvalKit 应对中小团队场景，也能看懂 langfuse / inspect_ai 等主流平台的源码，按需迁移。

## 本章要点回顾

- **Dashboard 教学 demo**：node:http 80 行 TS，直读 ch04 / ch11 / ch17 的 jsonl，最小验证"dashboard 长什么样、能解决什么问题"；生产化方向是 Next.js + SQLite + langfuse 三选一
- **从 EvalKit 迁移到 langfuse**：5 步路径 + 数据格式 1:1 映射表（trace / spans / scores / dataset_items），无感切换
- **生产 dashboard 必有 4 个视图**：跑历史列表 / 单 run 详情 / 跨 run diff / 跨时间趋势
- **保留 EvalKit 不迁移的场景**：团队规模 < 10、还在评测体系建设期、想完全掌控 cost & 数据。规模大了再迁
- **附录怎么选读**：每个附录回答一个具体场景，主线读完按需翻

## 第 20 章总结

到这一步，全书 20 章正文 + 5 附录覆盖的 agent 评测体系完整成型：

- 评测金字塔三层定位（Layer 2 占 80%）
- 4 件套抽象（Task / Dataset / Solver / Scorer）
- 11 个内置 scorer 覆盖所有评测维度
- 200+100+40+50 条评测集
- 用户模拟器 + Multi-turn
- LLM-as-Judge + judgy 校正 + Bradley-Terry / Elo
- pass^k + Cohen's Kappa
- 数据飞轮 + CI 守门
- Dashboard 可视化 + 生产部署路径

ShopAgent 在这套体系下从最初基线（sonnet via mock-server 综合 L1+L2+L3 加权约 65%）推到加固后 80%+（作者本地）：单维度看 L1 v2 77.5% → 85%、L3 45% → 60%、L2 ≈42% → 47%。可控演化、可观测、可回归。

读者读完直接拿 fork ShopAgent 替换成自家 agent，整套体系 1 周内就能搬到自己公司。这是这本书的终点。

## 接下来：5 个附录怎么选读

主线 20 章读完不需要再读附录。下面是按"什么场景读哪个附录"的导读：

| 附录 | 什么时候读 | 跳过的代价 |
|---|---|---|
| A 模型评测 | 你要做 GPT-4o vs Claude vs Qwen 模型选型时 | 选模型只能拍脑袋 |
| B 多 Agent | 你的系统有路由 agent / 多 agent 协作时 | 单 agent 评测套路用不到多 agent 场景 |
| C 业务指标 | 你要给老板汇报 ROI 时 | Agent 评测数字翻译不成业务语言 |
| D ShopAgent 扩展版 | 你觉得 8 工具 / 5 policy 不够用时 | 复杂 trajectory eval 没素材 |
| E 业务知识 | 你的业务是国内电商，要设计 L3 对抗集时 | L3 灵感来源不足、policy 设计照搬美国语境 |

主线读者建议先做完一轮自家 agent 评测（用本书前 20 章方法论），再回头按需翻附录。**附录不是"扩展阅读"，是"你卡在哪个 gap 就读哪一篇"**。

---

> 本章来自《AI Agent 评测工程实战》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev) · 反馈与勘误：[GitHub Issues](https://github.com/diguike/book-agent-evals/issues)
