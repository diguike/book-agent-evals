---
title: 第 3 章　搭建 EvalKit 评测框架
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/KQddwK6IFiHAgVkmbfMc1Kssnab"
last_synced: "2026-05-27T14:59:41Z"
---

## 本章你会拿到什么

把第 2 章的 100 行 minimal 升级成有完整抽象的 EvalKit 框架（约 600 行 TS），引入 inspect_ai 同款的四件套：**Task / Dataset / Solver / Scorer**。读完这一章你能：

1. 理解为什么"100 行 minimal"必须变成"600 行框架"——抽象的成本和收益分别是什么
2. 看懂 Task / Dataset / Solver / Scorer 各自的职责和接口签名
3. 用 EvalKit 跑同样 10 条评测，输出格式更标准，新增 dataset / scorer 不再改主循环
4. 拥有一个能接住后续 18 章功能扩展的框架

代码在 `examples/evalkit/`（这是贯穿全书演进的框架本身，不是某一章的 demo）。本章 commit 是它的第一个有意义的版本。

## 为什么 100 行 minimal 不够用

第 2 章的代码长这样：

```ts
function score(sample: Sample, run: AgentRun): Score { ... }
async function runAgent(sample: Sample, model: string): Promise<AgentRun> { ... }
async function main() {
  const dataset = loadDataset('...');
  for (const sample of dataset) {
    const run = await runAgent(sample, model);
    const s = score(sample, run);
    // ...
  }
}
```

读起来简单，跑起来也跑得起来。但只要你想做下面任何一件事，它就崩了：

| 你想做的事 | minimal 版本会怎样 |
|---|---|
| 换一种打分方法（比如加 LLM-as-Judge） | 改 `score` 函数，所有其他评测都受影响 |
| 加一种新数据集格式（CSV / HF datasets） | 改 `loadDataset`，加一堆 if-else |
| 同一个 dataset 跑两个不同的 scorer | 主循环要复制粘贴 |
| 在调 agent 前做 prompt 预处理 | 改 `runAgent`，没法复用 |
| 跑多个 epoch（同一 task 跑 8 次算 pass^8） | 主循环再嵌一层 for |
| 把日志格式换成别的 schema | 改 `main` 末尾的写盘逻辑 |
| 给评测加超时 / 重试 / 限额 | 各处插入 try-catch |

所有"扩展"都要改主循环。这就是没抽象的代价——**功能是叠加的，复杂度却是乘法增长**。

升级到框架后，每个动作变成独立的可插拔零件：

```
原来:  loadDataset → runAgent → score → write    （4 个动作硬编码在主循环里）
现在:  Dataset    → Solver   → Scorer → EvalLog  （4 个抽象，主循环不知道具体实现）
```

新增 scorer 只写一个新 Scorer，主循环不动；换日志格式只换 EvalLog 实现，scorer 不动。这是评测框架存在的全部理由。

## 四件套：从 inspect_ai 拿来的词汇表

我们的命名直接抄 inspect_ai（[UKGovernmentBEIS/inspect_ai](https://github.com/UKGovernmentBEIS/inspect_ai)），不是因为懒，是因为这套词汇表已经是行业事实标准——你读懂这四个名词，去看 Hamel 的 Maven 课、langfuse 的文档、agentevals 的代码都不会迷路。

### Task

一次评测的入口。把 Dataset / Solver / Scorer 三件事打包到一起，是给 CLI / 调度器看的东西。

```ts
interface Task {
  name: string;
  dataset: Dataset;
  solver: Solver | Solver[];       // 单个或链式
  scorer: Scorer | Scorer[];
  config?: {
    temperature?: number;
    maxTokens?: number;
    epochs?: number;              // 同一 sample 跑几次
    messageLimit?: number;
  };
}
```

Task 是**纯数据**——没有方法、没有状态。inspect_ai 同样是这么设计的（`_eval/task/task.py:61` 的 Task 类持有 30+ 字段但没有运行时状态）。所有调度逻辑在 runner 里。

### Dataset 和 Sample

Sample 是一条评测样本，Dataset 是 Sample 的集合：

```ts
interface Sample {
  id: string;
  input: string | ChatMessage[];     // 用户输入：单条文本或对话
  target?: string | string[];        // 期望答案，scorer 用
  metadata?: Record<string, unknown>;
  // 章节后续会加：choices / files / setup 等字段
}

interface Dataset {
  name?: string;
  samples: Sample[];                 // 或 AsyncIterable<Sample>，第 6 章会用
  size: number;
}

// loader 函数：JSONL / CSV / 自定义
function jsonlDataset(path: string, fieldMap?: FieldMap): Dataset;
function csvDataset(path: string, fieldMap?: FieldMap): Dataset;
```

`fieldMap` 解决"数据集列名 ≠ Sample 字段名"的问题。比如某个数据集叫 `query` 而不是 `input`，你给 `{input: 'query'}` 一映射就行，不用改数据。

### Solver

跑被测对象的那一步。从 inspect_ai 拿过来的设计：solver 是一个 **async 函数**，输入 `TaskState`，输出 `TaskState`：

```ts
type Solver = (state: TaskState, generate: GenerateFn) => Promise<TaskState>;

interface TaskState {
  sample: Sample;
  messages: ChatMessage[];           // 对话历史
  output?: ModelOutput;              // 最近一次模型输出
  toolCalls: ToolCall[];             // 累积的工具调用
  metadata: Record<string, unknown>;
  completed: boolean;                // solver 设为 true 提前结束
}

type GenerateFn = (state: TaskState, opts?: { toolCalls?: 'loop' | 'single' | 'none' }) => Promise<TaskState>;
```

`generate` 是另一个 protocol，把"调模型"这一步从 solver 中分离——solver 是"怎么用模型"，generate 是"怎么调模型"。第 6 章会展开 generate 的实现（含 provider 抽象 + 并发 + 缓存）。

Solver 可以链式组合，类似中间件：

```ts
function chain(...solvers: Solver[]): Solver {
  return async (state, generate) => {
    for (const solver of solvers) {
      state = await solver(state, generate);
      if (state.completed) break;
    }
    return state;
  };
}

// 用法：
const mySolver = chain(
  systemMessage('You are a helpful shopping assistant'),
  useTools(shopAgentTools),
  generate({ toolCalls: 'loop' })
);
```

这套设计 inspect_ai 用了几年，证明很灵活——后面我们会用 chain 表达 trajectory eval、multi-turn、self-critique 各种模式。

### Scorer

打分函数。输入是 solver 跑完的 TaskState 和样本的 target，输出是 Score：

```ts
type Scorer = (state: TaskState, target: Target) => Promise<Score>;

interface Score {
  value: 'C' | 'I' | 'P' | number;   // Correct / Incorrect / Partial / 数值
  answer?: string;                    // 提取出来的答案
  explanation?: string;               // 挂在哪里
  metadata?: Record<string, unknown>;
}

type Target = string | string[] | {
  expectedToolCalls?: ExpectedToolCall[];
  expectedResponseContains?: string[];
  // 后续章节会加：expectedTrajectory / expectedDbState 等
};
```

内置 scorer 这一章只写 3 个最常用的：

```ts
const match: Scorer;                 // 完全匹配 target 字符串
const includes: Scorer;              // target 是否出现在回复里
const toolCallMatch: Scorer;         // 工具调用匹配（第 2 章的 score 函数升级版）
```

后续章节会加更复杂的：`model_graded` (第 13 章 LLM-as-judge)、`trajectory_match` (第 11 章)、`db_state_delta` (第 11 章)、`rag_faithfulness` (第 8 章) 等。

## EvalKit 目录结构

```
examples/evalkit/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                     # 公开导出
│   ├── types.ts                     # 所有 interface
│   ├── task.ts                      # Task 类型 + task() 装饰器
│   ├── dataset/
│   │   ├── index.ts
│   │   ├── jsonl.ts                 # JSONL loader
│   │   └── csv.ts                   # CSV loader
│   ├── solver/
│   │   ├── index.ts
│   │   ├── chain.ts                 # solver 链式组合
│   │   ├── generate.ts              # generate solver（这一章 stub）
│   │   ├── system_message.ts
│   │   ├── prompt_template.ts
│   │   └── use_tools.ts             # 工具调用 solver
│   ├── scorer/
│   │   ├── index.ts
│   │   ├── match.ts
│   │   ├── includes.ts
│   │   └── tool_call_match.ts
│   ├── eval/
│   │   ├── runner.ts                # 主调度
│   │   └── state.ts                 # TaskState 创建 / 流转
│   ├── log/
│   │   ├── index.ts
│   │   └── jsonl_recorder.ts        # JSONL 日志写入
│   └── cli/
│       ├── index.ts
│       └── run.ts                   # `evalkit run xxx.task.ts`
```

约 600 行 TS。比 inspect_ai 的对应模块少 80%（inspect_ai 这部分约 5000 行），剩下 20% 留给后续章节增量加。

## 核心调度：runner.ts 长什么样

主调度逻辑约 80 行：

```ts
// examples/evalkit/src/eval/runner.ts
import { JsonlRecorder } from '../log/jsonl_recorder.js';
import type { Task, Sample, TaskState, Score } from '../types.js';
import { createTaskState } from './state.js';
import { defaultGenerate } from '../solver/generate.js';

export interface RunOptions {
  model: string;
  outputDir?: string;
  concurrency?: number;             // 第 6 章会用，这一章先串行
}

export interface RunResult {
  taskName: string;
  model: string;
  samples: SampleRunResult[];
  metrics: { accuracy: number; total: number; correct: number };
  startedAt: string;
  completedAt: string;
}

export interface SampleRunResult {
  sampleId: string;
  state: TaskState;
  scores: Score[];
  timingMs: number;
}

export async function runTask(task: Task, opts: RunOptions): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const solvers = Array.isArray(task.solver) ? task.solver : [task.solver];
  const scorers = Array.isArray(task.scorer) ? task.scorer : [task.scorer];
  const generate = defaultGenerate(opts.model, task.config);
  const recorder = new JsonlRecorder(opts.outputDir ?? 'runs', task.name, opts.model);

  await recorder.writeHeader({
    taskName: task.name,
    model: opts.model,
    datasetSize: task.dataset.size,
    startedAt,
  });

  const sampleResults: SampleRunResult[] = [];

  for (const sample of task.dataset.samples) {
    const t0 = Date.now();
    let state = createTaskState(sample, task.config);

    // 跑 solver 链
    for (const solver of solvers) {
      state = await solver(state, generate);
      if (state.completed) break;
    }

    // 跑 scorer 链
    const scores: Score[] = [];
    for (const scorer of scorers) {
      scores.push(await scorer(state, sample.target ?? ''));
    }

    const result: SampleRunResult = {
      sampleId: sample.id,
      state,
      scores,
      timingMs: Date.now() - t0,
    };

    sampleResults.push(result);
    await recorder.writeSample(result);

    const allPass = scores.every((s) => s.value === 'C');
    const mark = allPass ? '✓' : '✗';
    const reasons = scores.flatMap((s) => (s.explanation ? [s.explanation] : []));
    console.log(`${mark} ${sample.id} (${result.timingMs}ms) ${reasons.join('; ')}`);
  }

  // 计算汇总
  const correct = sampleResults.filter((r) => r.scores.every((s) => s.value === 'C')).length;
  const metrics = { accuracy: correct / sampleResults.length, total: sampleResults.length, correct };
  const completedAt = new Date().toISOString();

  await recorder.writeFooter({ metrics, completedAt });

  console.log(`\n[evalkit] ${task.name} pass^1 = ${metrics.accuracy.toFixed(3)} (${correct}/${sampleResults.length})`);

  return {
    taskName: task.name,
    model: opts.model,
    samples: sampleResults,
    metrics,
    startedAt,
    completedAt,
  };
}
```

注意几个设计点：

1. **solver 和 scorer 都支持单个或数组**——单个时是最常见情况，数组时是链式组合。约定 `task.solver: Solver | Solver[]` 比强制 `Solver[]` 友好得多
2. **recorder 是流式写入**——每跑完一个 sample 立刻落盘，挂了不丢已跑数据。这一点参考 inspect_ai 的 lazy-write 设计（`log/_recorders/eval.py`）
3. **没有并发**——这一章 for 串行跑。第 6 章 Provider 抽象时会加并发池

## 用 EvalKit 跑同样 10 条样本

把第 2 章的评测改写成 EvalKit 风格：

```ts
// examples/ch02-hello-world/src/index.v2.ts —— 升级到 EvalKit
import { defineTask, jsonlDataset, chain, useTools, generate } from '@inferloop/evalkit';
import { toolCallMatch, includes } from '@inferloop/evalkit/scorer';
import { shopAgentTools } from '@inferloop/shopagent';
import { runTask } from '@inferloop/evalkit/eval';

const l1HelloWorld = defineTask({
  name: 'l1-hello-world',
  dataset: jsonlDataset('./datasets/l1-seed-10.jsonl'),
  solver: chain(
    useTools(shopAgentTools),
    generate({ toolCalls: 'loop' })
  ),
  scorer: [
    toolCallMatch(),
    includes({ field: 'expected_response_contains' }),
  ],
  config: { temperature: 0 },
});

await runTask(l1HelloWorld, {
  model: process.env.MODEL ?? 'gpt-4o',
});
```

跑出来的结果跟第 2 章一致——抽象没改变行为，只改变了组织方式。具体数字取决于后端：GPT-4o / GPT-4o-mini 真实 API 下 pass^1 = 0.800 / 0.600（作者历史数据），mock-llm-server 后端下两个模型都是 0.500（被 prompt 多步调度瓶颈拉平）。

但现在如果你想：

- **加 LLM-as-Judge**：只要 `scorer: [..., modelGraded({ rubric: 'policy_check' })]` 加一项
- **跑 4 个 epoch 算 pass^4**：`config: { ..., epochs: 4 }` 加一行
- **换数据集到 CSV**：`dataset: csvDataset('./eval.csv', {input: 'query', target: 'answer'})` 换一行
- **加 system prompt**：`solver: chain(systemMessage('...'), useTools(...), generate(...))` 链式加一节

**主循环完全不动**。这是抽象的价值。

## CLI 命令

EvalKit 提供一个简单 CLI：

```bash
# 跑评测
evalkit run task.ts --model gpt-4o-mini

# 查看上次 run
evalkit view runs/2026-05-27_l1-hello-world_gpt-4o.jsonl

# 对比两次 run
evalkit diff runs/baseline.jsonl runs/candidate.jsonl
```

`evalkit run` 用 `tsx` 加载 task 文件，调用 `runTask`。`view` 和 `diff` 这一章先 stub，第 7 章会真正实现。

## 接现有 agent 框架进来（LangChain.js / Vercel AI SDK / Mastra）

EvalKit 的 Solver 接口故意做窄，**任何能跑出"消息 + 工具调用 + 最终回复"的 agent 都能包装成 Solver**。

> **前置注意**：本仓库的 ShopAgent 通过 npm workspaces 直接 import 进 evalkit（**不是**起独立 HTTP 服务），评测脚本里 `import { runShopAgent } from '@inferloop/shopagent'` 后直接调函数，它会在同一进程内跑 OpenAI tool-calling 循环 + 操作内存 SQLite DB。第一次跑前需先在仓库根执行 `npm install`、`cd examples/shopagent && npm run seed`（生成 5000 订单 mock 数据）。如果你接的是自家 agent，**两种模式都行**：进程内 import（最简单，本仓库示例都这么做）或 HTTP 服务（生产架构常用，包成 Solver 时只是把 `await runShopAgent(...)` 换成 `await fetch('http://localhost:xxx/run')`）。

下面给三个主流框架的对接思路：

### Vercel AI SDK

ShopAgent 主线版用的就是 Vercel AI SDK。对接方法：

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

const aiSdkSolver: Solver = async (state, _generate) => {
  const result = await generateText({
    model: openai(state.metadata.model ?? 'gpt-4o'),
    messages: state.messages as any,
    tools: shopAgentTools,
    maxSteps: 8,
  });
  // 把 AI SDK 的 result 翻译成 TaskState
  state.messages = result.response.messages as any;
  state.toolCalls = result.toolCalls.map((tc) => ({ tool: tc.toolName, args: tc.args }));
  state.output = { completion: result.text };
  return state;
};
```

EvalKit 自己的 `generate` solver 在这种场景下**不被使用**——AI SDK 内部已经管 LLM 调用 + tool 循环。EvalKit 退化为"scorer + EvalLog 调度器"。

### LangChain.js

LangChain 的 `runnable` / chain 同样能包成 Solver：

```ts
import { AgentExecutor } from 'langchain/agents';

const langchainSolver: Solver = async (state, _generate) => {
  const result = await myAgentExecutor.invoke({
    input: state.sample.input as string,
  });
  // LangChain 的 intermediateSteps 含每一步 tool 调用
  state.toolCalls = result.intermediateSteps.map(([action]) => ({
    tool: action.tool,
    args: typeof action.toolInput === 'string' ? { input: action.toolInput } : action.toolInput,
  }));
  state.output = { completion: result.output };
  return state;
};
```

LangSmith 的 traces 跟 EvalKit EvalLog 不直接兼容，但可以 `langsmithTracer.flush()` 后用脚本把 traces 转成 EvalKit Sample。

### Mastra

Mastra 的 `Agent` 类有 `generate()` 方法，包法跟 AI SDK 类似：

```ts
import { Agent } from '@mastra/core';

const mastraSolver: Solver = async (state, _generate) => {
  const result = await myAgent.generate(state.sample.input as string);
  state.output = { completion: result.text };
  state.toolCalls = (result.toolCalls ?? []).map((tc) => ({ tool: tc.toolName, args: tc.args }));
  return state;
};
```

### 通用原则

无论哪个框架，包装成 Solver 只需做 3 件事：

1. 把 `state.sample.input` 喂给你的 agent
2. agent 跑完后把"消息历史 / 工具调用 / 最终回复"塞回 `state` 对应字段
3. 返回 `state`（Solver 接口要求）

约 30-50 行 TS 包装代码。**剩下的 EvalKit 调度、scorer、EvalLog 完全不用改**——这是为什么 Solver 接口故意做窄。

## 接口稳定性承诺（重要）

这一章定下的接口（Task / Dataset / Sample / TaskState / Solver / Scorer / Score）在全书剩下的 17 章中**不会再做不兼容改动**。后续章节只会**加字段**（比如 Sample 加 `choices`、TaskState 加 `tools`、Score 加 `metadata`），不会改类型签名。

这是个工程承诺，也是教学承诺：**读者写到第 7 章的代码，到第 20 章不需要重写**。如果你后续看到某个章节似乎在修改这些核心接口，请提 issue，那是 bug，不是 feature。

## 对照 inspect_ai 源码

把我们这一章的实现指回 inspect_ai 对应文件：

| EvalKit 文件 | inspect_ai 对应 |
|---|---|
| `src/types.ts` 里的 `Task` | `src/inspect_ai/_eval/task/task.py:61` 的 `Task` 类 |
| `src/types.ts` 里的 `Sample` | `src/inspect_ai/dataset/_dataset.py:Sample`（L29-95） |
| `src/dataset/jsonl.ts` | `src/inspect_ai/dataset/_sources/json.py` |
| `src/solver/chain.ts` | `src/inspect_ai/solver/_chain.py` |
| `src/solver/generate.ts` stub | `src/inspect_ai/solver/_solver.py` 的 `generate` solver |
| `src/solver/use_tools.ts` | `src/inspect_ai/solver/_use_tools.py` |
| `src/scorer/match.ts` | `src/inspect_ai/scorer/_match.py` |
| `src/eval/runner.ts` | `src/inspect_ai/_eval/run.py` + `_eval/eval.py` |
| `src/log/jsonl_recorder.ts` | `src/inspect_ai/log/_recorders/json.py` |
| `src/eval/state.ts` 里的 `TaskState` | `src/inspect_ai/solver/_task_state.py`（约 700 行，我们只用了 50 行） |

当前这套 EvalKit ≈ inspect_ai 早期版本（约 0.3.50 左右）的核心抽象，约占 inspect_ai 当前代码量的 5%——但已经能跑完整的评测闭环。后续章节会按需补齐 inspect_ai 没省略的能力（并发、缓存、TaskState 限额、view 前端、多 metric 聚合等）。

## 本章要点回顾

- **四件套抽象**：Task / Dataset / Solver / Scorer，inspect_ai 同款命名，行业事实标准
- **Solver 接口故意做窄**：任何能跑出"消息 + 工具调用 + 最终回复"的 agent 都能 30-50 行包装成 Solver（Vercel AI SDK / LangChain.js / Mastra 都能接）
- **接现有 agent 的两种方式**：进程内 import（本仓库示例）或 HTTP 服务（生产架构），关键在于把"消息 / 工具调用 / 回复"翻译进 TaskState
- **runner 流式落盘**：每跑完一条 sample 立刻 append 到 JSONL，挂了不丢已跑数据
- **接口稳定承诺**：这一章定下来的接口在后续 17 章只加字段、不改签名

## 第 3 章总结

到这一章你完成了从"100 行 minimal"到"600 行有抽象的评测框架"的升级：

- Task / Dataset / Sample / TaskState / Solver / Scorer / Score 七个核心类型定下来
- 主调度 `runTask` 80 行，所有具体行为通过 solver 链和 scorer 链插入
- JSONL 流式日志，挂了不丢已跑数据
- CLI 三个子命令（run / view / diff，后两个 stub）

下一章开始你会用这个框架做第一件"真正生产级"的事：**从 0 造 60 条 L1 评测集**——直指工程师最真实的痛点：评测集到底从哪里来。

---

> 本章来自《AI Agent 评测工程实战》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev) · 反馈与勘误：[GitHub Issues](https://github.com/diguike/book-agent-evals/issues)
