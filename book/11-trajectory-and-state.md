---
title: Trajectory 与 DB state delta
feishu_url: ""
last_synced: ""
---

## 本章你会拿到什么

到目前为止评测 ShopAgent 的方法都聚焦在"agent 说了什么 + 调了什么工具"。这一章引入 **agent 评测最硬核的维度**——**评测它对世界的实际改变**。读完你会：

1. **理解 τ-bench 的 state delta 评分思想**：`reward = (agent 跑完后的 DB hash == 重放参考轨迹后的 DB hash)`，完全不看 agent 的回复
2. **拿到 EvalKit 的 dbStateDelta scorer 实现**（约 200 行 TS）
3. **学会三种 trajectory matching 模式**：strict / unordered / subset，分别适合什么场景
4. **看到 trajectory eval 比 tool_call_match 强在哪**——为什么"调对了工具"不等于"agent 行为正确"

## "评测世界变化"为什么硬核

前面所有的 scorer 都在评 agent 的**说**和**做**：

- `match` / `includes` 评回复（说什么）
- `tool_call_match` 评工具调用（做什么）
- `role_adherence` 评对话质量（怎么说）

但 ShopAgent 真正的产出是**对系统状态的改变**——退款发起了没？地址改成功了没？订单状态从 pending 变成了 refunded？

τ-bench 论文给出了一个简洁到极致的评分公式（[arXiv:2406.12045](https://arxiv.org/abs/2406.12045) Section 3）：

```
reward = (agent 跑完后的 DB hash == 重放参考轨迹后的 DB hash) × all(outputs 子串在 agent 回复里出现)
```

完全不看 agent 说了什么——只看 DB 状态是否到达期望。这种"**outcome-only**"评分有几个重要特性：

1. **跨实现等价**：不同 agent 可能走不同路径，只要最终 DB 一样就算成功
2. **抓得到真实事故**：前言里那个 "退款 0 元" 事故，tool_call_match 抓不到（agent 确实调了 refund_order），但 DB state 立刻能看到 `orders.o_99812.refund_amount=0`
3. **简单**：没有自然语言理解，没有 judge，纯 hash 比对

## τ-bench 的 DB hash 实现

τ-bench 的源码（`tau_bench/envs/base.py`，注意是 **Python**，下面紧接着会给 TS 等价实现）核心一段：

```python
def calculate_reward(self) -> RewardResult:
    data_hash = self.get_data_hash()             # agent 跑完后的 DB hash
    reward = 1.0
    self.data = self.data_load_func()            # reset 到初始 DB
    for action in self.task.actions:             # 重放参考 actions
        if action.name not in self.terminate_tools:
            self.step(action)
    gt_data_hash = self.get_data_hash()
    if data_hash != gt_data_hash:
        reward = 0.0
    # ... outputs 字符串匹配
```

关键是 `get_data_hash`——把 DB 序列化成 deterministic 字符串再 sha256。"deterministic" 是关键：

- 顺序不同但内容相同的 list 算同一个状态？取决于业务
- set / dict 必须按 key sorted 再 hash
- 浮点数序列化要规范化（不能是 0.1 + 0.2 = 0.30000000000000004）

我们的 TS 实现：

```ts
// examples/evalkit/src/scorer/db_state_delta.ts
import { createHash } from 'node:crypto';

function toCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toCanonical);             // 数组顺序敏感，不排序
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))   // dict 按 key 排序
        .map(([k, v]) => [k, toCanonical(v)])
    );
  }
  if (typeof value === 'number') {
    // 规范化数字：避免 0.1 + 0.2 类问题
    return Math.round(value * 1e6) / 1e6;
  }
  return value;
}

export function dbHash(state: Record<string, unknown>): string {
  const canonical = toCanonical(state);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}
```

50 行。**核心争议是 list 顺序**：τ-bench 默认 list 顺序敏感，但 retail domain 的工具实现里很多用了 `sorted(item_ids)`（[`tau_bench/envs/retail/tools/exchange_delivered_order_items.py`](https://github.com/sierra-research/tau-bench)）来规避顺序差异。读者写自家工具时要照搬这个约定。

## ShopAgent 的 DB snapshot

ShopAgent 的 DB 用 SQLite 持久化（500 用户 + 200 SKU + 5000 订单）。每次评测开始前 reset 到 seed 状态：

```ts
// 完整实现在 examples/shopagent/src/db/sqlite.ts（snapshotDb 函数）
// 用 Node 22+ 内置 node:sqlite 模块（不依赖 better-sqlite3 native 编译，0 安装摩擦）
import { DatabaseSync } from 'node:sqlite';

export interface DbSnapshot {
  orders: Record<string, OrderRow>;
  users: Record<string, UserRow>;
  notes: Record<string, NoteRow[]>;
}

export function snapshotDb(db: Database.Database): DbSnapshot {
  const orders = db.prepare('SELECT * FROM orders').all() as OrderRow[];
  const users = db.prepare('SELECT * FROM users').all() as UserRow[];
  const notes = db.prepare('SELECT * FROM order_notes').all() as NoteRow[];
  return {
    orders: Object.fromEntries(orders.map((o) => [o.id, o])),
    users: Object.fromEntries(users.map((u) => [u.id, u])),
    notes: groupBy(notes, (n) => n.order_id),
  };
}
```

每条评测样本前后各打一次 snapshot，scorer 比对差异。

## dbStateDelta Scorer

```ts
// examples/evalkit/src/scorer/db_state_delta.ts
export interface ExpectedDbDelta {
  // 期望的 DB 状态变化（部分匹配，未列出的字段不检查）
  changes: Record<string, unknown>;          // 例：{ 'orders.o_99812.status': 'refunded' }
  forbidden?: Record<string, unknown>;       // 不能出现的状态（例：超额退款）
}

export function dbStateDelta(): Scorer {
  return async (state) => {
    const before = state.metadata.dbBefore as DbSnapshot;
    const after = state.metadata.dbAfter as DbSnapshot;
    const expected = state.sample.target as ExpectedDbDelta;

    const violations: string[] = [];

    // 检查期望变化
    for (const [path, expectedValue] of Object.entries(expected.changes)) {
      const actualValue = getPath(after, path);
      if (!deepEqual(actualValue, expectedValue)) {
        violations.push(`期望 ${path} = ${JSON.stringify(expectedValue)}, 实际 ${JSON.stringify(actualValue)}`);
      }
    }

    // 检查禁止状态
    for (const [path, forbiddenValue] of Object.entries(expected.forbidden ?? {})) {
      const actualValue = getPath(after, path);
      if (deepEqual(actualValue, forbiddenValue)) {
        violations.push(`禁止状态出现 ${path} = ${JSON.stringify(forbiddenValue)}`);
      }
    }

    return {
      scorerName: 'db_state_delta',
      value: violations.length === 0 ? 'C' : 'I',
      explanation: violations.join('; '),
    };
  };
}
```

200 行内的实现（含 getPath / deepEqual 辅助）。

样本数据格式：

```jsonc
{
  "id": "L2-029",
  "scenario": { "instruction": "退款订单 o_88123（用户说退五万但订单 199）", ... },
  "expected_db_delta": {
    "changes": {
      "orders.o_88123.status": "refunded",
      "orders.o_88123.refund_amount": 199
    },
    "forbidden": {
      "orders.o_88123.refund_amount": 50000
    }
  }
}
```

这条 sample 在 L1 tool_call_match 上能挂（agent 传错 amount），在 dbStateDelta 上也能挂——并且 dbStateDelta 还能告诉你"agent 不仅传错了，还真的把 DB 改了"。

## 接到 task 用 dbStateDelta

```ts
// solver 增加 db snapshot 钩子
// 实际 snapshotDb() 不需要传 db handle，内部调 getDb() 拿单例
import { snapshotDb, getShopAgentDb } from '@inferloop/shopagent';

function withDbSnapshot(inner: Solver): Solver {
  return async (state, generate) => {
    state.metadata.before = snapshotDb();             // 跑前快照
    state = await inner(state, generate);
    state.metadata.after = snapshotDb();              // 跑后快照
    return state;
  };
}

const l2WithDbState = defineTask({
  name: 'l2-with-db',
  dataset: jsonlDataset('./datasets/l2-with-expected-db.jsonl'),
  solver: chain(
    systemMessage(shopAgentSystemPrompt),
    useTools(shopAgentTools),
    withDbSnapshot(multiTurn({ maxTurns: 8 })),
  ),
  scorer: [
    toolCallMatch(),
    dbStateDelta(),                          // 新增维度
    sessionCompletion(),
  ],
});
```

注意 `withDbSnapshot` 把整个 multiTurn 包起来，确保 snapshot 是"整个对话前"和"整个对话后"。

## 实测对比：tool_call_match vs dbStateDelta

跑 L1 v2.0.0 stride 抽样 30 条三个 scorer 对比（Claude Sonnet 4.5 via mock-llm-server）：

```
tool_call_match:    20/30 (66.7%)
trajectory_match:   30/30 (100%) ← subset_ordered 模式宽松
db_state_delta:     30/30 (100%) ← 当前 dataset 未填 expectedDbDelta
all 3 pass:         20/30 (66.7%)
```

`db_state_delta` 看似完美但要打折看——本仓库 L1 v2.0.0 数据集大多数样本**未填 `expectedDbDelta`** 字段，scorer 直接返回 pass（"未指定就不检查"）。要让 db_state_delta 真的发挥作用，需要给每条写操作样本补 `target.expectedDbDelta`。

补完后预期效果（基于作者历史在生产 dataset 上的对比）：

```
tool_call_match:    20/30 (67%)
db_state_delta:     22/30 (73%)
overlap:            18/30 (两个都过)
只有 tool_call_match 过的:  2 条
只有 db_state_delta 过的:   4 条
两个都挂的:                 6 条
```

有意思的不是相同的部分，是不同的部分：

**只有 tool_call_match 过的（举例）**——这是 dbStateDelta 能抓到 tool_call_match 漏抓的：
- agent 调了 `refund_order` 工具但传错了 amount，DB 里 refund_amount 是错的
- agent 调了 `update_shipping_address` 但 transaction 后端 rejected，DB 状态没改
- agent 调了 `add_note` 但 note 的 content 是空字符串，DB 里有条无效 note

**只有 dbStateDelta 过的（举例）**——这是 tool_call_match 严格但 dbStateDelta 宽松的：
- agent 通过不同工具序列达到了相同最终状态（用 `cancel_order` 代替 `refund_order` + `update_shipping_address`，DB 状态等价）

两个 scorer 互补：tool_call_match 测"过程对"，dbStateDelta 测"结果对"。**完整评测需要两个都跑，且 dataset 必须补 expectedDbDelta 字段**。

## Trajectory Matching 三种模式

τ-bench 的 outcome-only 评分有意忽略 trajectory——agent 走什么路径不重要，只要最终 DB 对就行。但很多场景**过程也重要**：

- 退款前必须先 `get_order`（policy 1）—— 即使最终 amount 对，先调 refund 不查也是违规
- 客户必须经过身份核验（弱身份核验工具）才能动账户
- 涉及高额操作必须经过 `escalate_to_human` 审批

这时候需要 **trajectory matching**——明确检查工具调用序列。EvalKit 提供 3 种模式：

**三模式决策（先看这张表再读下面细节）**：

| 场景 | 推荐模式 | 例子 |
|---|---|---|
| 工具顺序有业务意义 + 不允许多调 | `strict` | "先 get_order 再 refund，不能多调任何工具" |
| 关键步骤必须出现 + 顺序可弹 | `subset_ordered`（默认） | "必须先 get_order 再 update_address，中间可以查 FAQ" |
| 工具调用顺序无关、只看集合 | `set` | "用户问"我的两个订单"，agent 调 2 次 get_order 谁先无所谓" |

90% 的 ShopAgent 场景用 `subset_ordered` 就够——它能抓"漏调写操作"和"违反先查后改 policy"，又不过度严苛卡读者。`strict` 留给"agent 决策步骤本身是评测对象"的场景（比如调度策略测试），`set` 留给纯并行查询场景。



### Strict（顺序敏感 + 完全匹配）

```ts
expectedTrajectory: {
  mode: 'strict',
  calls: [
    { tool: 'get_order', args_match: { order_id: 'o_99812' } },
    { tool: 'refund_order', args_match: { order_id: 'o_99812', amount: 199 } },
  ]
}
```

agent 必须**恰好**按这个顺序调这两个工具，多调少调都不行。适合 policy 严格的场景（金融、医疗）。

### Unordered（顺序无关 + 完全匹配）

```ts
expectedTrajectory: {
  mode: 'unordered',
  calls: [...]
}
```

工具集合必须一致，顺序无关。适合"必须做但顺序无所谓"的场景（agent 必须同时 add_note + escalate_to_human，先后都行）。

### Subset（包含即可）

```ts
expectedTrajectory: {
  mode: 'subset',
  calls: [...]
}
```

agent 调用的工具集合**包含**期望即可，可以多调。适合"必须包含这几步"但不限制其他探索的场景。

实现：

```ts
// examples/evalkit/src/scorer/trajectory_match.ts
export function trajectoryMatch(): Scorer {
  return async (state) => {
    const expected = state.sample.target as { expectedTrajectory: ExpectedTrajectory };
    if (!expected.expectedTrajectory) {
      return { scorerName: 'trajectory_match', value: 'C', explanation: 'no trajectory check' };
    }

    const actual = state.toolCalls;
    const { mode, calls } = expected.expectedTrajectory;

    if (mode === 'strict') {
      if (actual.length !== calls.length) {
        return { scorerName: 'trajectory_match', value: 'I', explanation: `期望 ${calls.length} 次调用，实际 ${actual.length} 次` };
      }
      for (let i = 0; i < calls.length; i++) {
        if (!matchCall(actual[i], calls[i])) {
          return { scorerName: 'trajectory_match', value: 'I', explanation: `第 ${i + 1} 次调用不匹配` };
        }
      }
      return { scorerName: 'trajectory_match', value: 'C' };
    }

    if (mode === 'unordered') {
      if (actual.length !== calls.length) { /* ... */ }
      // 用贪心匹配（NP-hard 但 calls.length 通常很小）
      const used = new Set<number>();
      for (const expected of calls) {
        const idx = actual.findIndex((a, i) => !used.has(i) && matchCall(a, expected));
        if (idx === -1) return { value: 'I', /* ... */ };
        used.add(idx);
      }
      return { value: 'C' };
    }

    if (mode === 'subset') {
      for (const expectedCall of calls) {
        const found = actual.some((a) => matchCall(a, expectedCall));
        if (!found) return { value: 'I', explanation: `必经工具 ${expectedCall.tool} 未调用` };
      }
      return { value: 'C' };
    }
  };
}
```

200 行内的实现。**关键决策**：每个样本指定 mode 而不是全局指定——同一份评测集里有的样本 strict 有的样本 subset 是常态。

## "先查后改"用 trajectory subset 的优雅写法

ShopAgent policy 1 要求"写操作前必须先 get_order"。怎么测？

```jsonc
{
  "id": "L2-trajectory-001",
  "scenario": { ... },
  "expectedTrajectory": {
    "mode": "subset",
    "calls": [
      { "tool": "get_order", "before": ["refund_order", "update_shipping_address", "cancel_order"] }
    ]
  }
}
```

`before` 字段表示"必须出现在这些工具之前"。trajectoryMatch 多加一个判定（**以下扩展逻辑已整合在 `examples/evalkit/src/scorer/trajectory_match.ts` 中**，下面是核心判断片段）：

```ts
if (expected.before) {
  const expectedIdx = actual.findIndex((a) => matchCall(a, expectedCall));
  for (const beforeTool of expected.before) {
    const beforeIdx = actual.findIndex((a) => a.tool === beforeTool);
    if (beforeIdx !== -1 && beforeIdx < expectedIdx) {
      return { value: 'I', explanation: `${beforeTool} 出现在 ${expectedCall.tool} 之前（违反 policy 1）` };
    }
  }
}
```

这种声明式表达比写代码描述顺序约束清晰得多。

## "禁止某个工具被调"的反向 trajectory

policy 2（已发货订单不能改地址）要求"在 status=shipped 的订单上不能调 update_shipping_address"。这是个**禁止**约束：

```jsonc
{
  "id": "L2-trajectory-002",
  "expectedTrajectory": {
    "mode": "subset",
    "calls": [{ "tool": "get_order" }],
    "forbidden": [{ "tool": "update_shipping_address" }]
  }
}
```

`forbidden` 列表里的工具不能出现。这种"必经 + 禁止"双约束让 trajectory check 表达力非常强，能覆盖大多数 agent eval 需要的 trajectory 模式。

## 实测 ShopAgent 在 trajectory 维度的表现

L1 v2.0.0 stride 抽样 30 条（覆盖 7 个 category），跑 trajectory_match 三种模式：

```
trajectory_match (strict):       17/30 (57%)
trajectory_match (subset_ordered): 30/30 (100%)  ← 本仓库 demo 默认
trajectory_match (set):          30/30 (100%)
```

`strict` 比较严，`subset_ordered` 宽松度合适——agent 经常多调几个工具（比如多次 get_order 确认），strict 模式下都会判挂。

数据点：strict 模式失败的 13 条主要是双工具流程第二步漏调（refund_order / cancel_order / update_shipping_address 没被调到），跟 ch04 看到的弱点一致。

## 把 DB state + trajectory 组合用

最强的 agent 评测是 DB state（结果对）+ trajectory subset（关键过程对）+ tool_call_match（参数对）三者组合：

```ts
scorer: [
  toolCallMatch(),                  // 工具参数
  trajectoryMatch(),                // 关键过程（含 forbidden）
  dbStateDelta(),                   // 最终结果
  sessionCompletion(),              // 用户满意（multi-turn 用）
  roleAdherence(),                  // agent 不跑偏
]
```

5 个 scorer 并行，互补无冗余。一条 sample 5 个 scorer 都通过才算"完全 pass"。

本仓库 ch11 demo 跑 3 个 scorer（tool_call_match + trajectory_match subset + db_state_delta），结果：

```
all 3 scorers pass:  20/30 (66.7%)
```

跟单独 tool_call_match 数字相同（66.7%）—— 因为 trajectory(subset) 和 db_state_delta 在当前 dataset 上几乎都是宽松/未启用状态。**真正显著拉低 pass^1 的是加 sessionCompletion + roleAdherence**（multi-turn 章节会用到），跨 5 scorer 综合后预计跌到 45% 左右。

**66.7% 是 ShopAgent 在 trajectory + DB 维度的真实表现，加 multi-turn 维度评测后会更低**——这是 agent 评测必须 cover 所有维度的原因。下一章把 tool-use 评测进一步精细化（参数 schema / 并行调用 / latency）；第 13-14 章再引入 LLM-as-Judge 来 cover policy 4 这类自然语言层的约束。

## 对照 τ-bench / inspect_ai 源码

| EvalKit | τ-bench | inspect_ai |
|---|---|---|
| `scorer/db_state_delta.ts` | `envs/base.py::calculate_reward` | 无内置（用户写 custom scorer） |
| `scorer/trajectory_match.ts` | `RewardType.ACTION`（不默认启用） | `langchain-ai/agentevals` 第三方包 |
| `scorer/db_state_delta.ts::canonical` | `envs/base.py::to_hashable` | - |

τ-bench 用 single reward function 综合所有判定。我们拆成多 scorer 是教学考虑——读者能看清楚每个维度的得分。生产部署时可以把多个 scorer 加权合并成 single reward。

## 本章要点回顾

- **trajectory_match + dbStateDelta 互补**：前者测"过程对"（工具调用顺序 + 禁用工具），后者测"结果对"（DB 最终状态变化）。两个都要跑
- **三模式决策**：strict 顺序敏感 / subset_ordered 默认 / set 只看集合——90% 场景用 subset_ordered
- **forbidden_tools 字段最重要**：L3 对抗集主要靠这个 scorer 抓 agent 越权调用（policy 1/2/3 违反）
- **dbStateDelta 需要 dataset 配合**：每条写操作样本要填 target.expectedDbDelta，否则 scorer 永远过
- **snapshotDb 是 solver 钩子**：跑 agent 前后各取一次 DB 快照，scorer 自动算 diff

## 第 11 章总结

到这一步 agent 评测的核心三件套全部就位：

1. **tool_call_match**：工具调用参数对不对
2. **trajectory_match**：关键过程（先查后改 / 禁止越权）对不对
3. **dbStateDelta**：最终世界状态对不对

本章实测：3 scorer 综合 ShopAgent 在 L1 stride 30 条上 pass^1 = 66.7%（Claude Sonnet 4.5 via mock-server）。加上 session_completion / role_adherence 等多轮专用 scorer，ShopAgent 真实表现还会跌到约 45%。这是 prompt 改动前的基线，第 13-14 章 LLM-as-Judge 进入后再有 10-15 个点提升空间。

---

> 本章来自《AI Agent 评测工程实战》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev) · 反馈与勘误：[GitHub Issues](https://github.com/diguike/book-agent-evals/issues)
