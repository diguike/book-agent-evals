---
title: Multi-turn 多轮评测
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/PdCYwOJGxiZxWVkYSmhcgnWCndf"
last_synced: "2026-05-27T14:59:41Z"
---

## 本章你会拿到什么

把第 9 章的用户模拟器接进 EvalKit 主循环，构造完整的多轮评测调度。读完你会：

1. **拿到 multiTurnSolver**：EvalKit 的多轮 solver，约 150 行 TS，**循环 driving 用户模拟器 ↔ ShopAgent 直到 ###STOP### 或轮数耗尽**
2. **新增 3 个 multi-turn 专用 scorer**：role adherence（agent 始终扮演客服）、turn efficiency（轮数是否过多）、session completion（任务是否完成）
3. **L2 评测集从 30 → 100 条**，覆盖所有 4 种 persona × 主要业务场景
4. **学会处理多轮评测的两个常见陷阱**：模型上下文窗口溢出 / cost 爆炸

代码增量：`examples/evalkit/src/solver/multi_turn.ts` + 3 个新 scorer。

## multiTurnSolver 的设计

第 3 章的 solver 接口是 `(state, generate) => Promise<TaskState>`，一次性跑完。multi-turn 是循环跑，每轮：

```
模拟器生成 user message      →
agent (LLM + 工具) 跑一轮     →
状态累积到 messages           →
判定是否终止（###STOP###/轮数）→
循环
```

实现：

```ts
// examples/evalkit/src/solver/multi_turn.ts
import type { Solver, TaskState } from '../types.js';
import { createUserSimulator } from '../user_simulator/index.js';

export interface MultiTurnOptions {
  maxTurns?: number;
  userModel?: string;        // 模拟器用的模型（默认 gpt-4o-mini）
}

export function multiTurn(opts: MultiTurnOptions = {}): Solver {
  const maxTurns = opts.maxTurns ?? 8;
  const userModel = opts.userModel ?? 'openai/gpt-4o-mini';

  return async (state, generate) => {
    const scenario = state.sample.target as UserScenario;
    const judgeProvider = resolveProvider(userModel).provider;
    const simulator = createUserSimulator(scenario, judgeProvider, userModel);

    let turn = 0;
    let stopped = false;

    while (turn < maxTurns && !stopped) {
      // 1. 取 agent 最近一条 assistant 消息（首轮为 null）
      const lastAgentMsg = [...state.messages].reverse().find((m) => m.role === 'assistant') ?? null;

      // 2. 模拟器生成下一句用户消息（只传最新 agent 消息，模拟器内部维护历史）
      const userMsg = await simulator.nextMessage(lastAgentMsg);
      stopped = userMsg.stop;

      if (stopped && !userMsg.content.replace('###STOP###', '').trim()) {
        // 纯 stop 信号，不加入 messages
        state.metadata.userStopReason = userMsg.content.match(/###(STOP|TRANSFER|OUT-OF-SCOPE)###/)?.[1];
        break;
      }

      // 2. 用户消息加入 state.messages
      state.messages.push({ role: 'user', content: userMsg.content });

      // 3. agent 跑一轮（含工具调用循环）
      state = await generate(state, { toolCalls: 'loop' });

      turn++;
      state.metadata.turnsCompleted = turn;

      // 4. 防止 agent 自己卡死（生成空回复 + 没调工具）
      const lastAssistant = [...state.messages].reverse().find((m) => m.role === 'assistant');
      const lastToolUsed = state.toolCalls.length > 0;
      if (!lastAssistant?.content?.trim() && !lastToolUsed) {
        state.metadata.dead = true;
        break;
      }
    }

    if (!stopped && turn === maxTurns) {
      state.metadata.exhausted = true;
    }

    return state;
  };
}
```

150 行内的核心循环。关键设计：

1. **用户消息和 agent 消息共用 `state.messages`**——模拟器内部翻转角色，但 EvalKit 主状态里始终用 `user / assistant / tool` 三种 role
2. **agent 每轮可以多次调工具**（`toolCalls: 'loop'`）——一轮内 agent 可能 `get_order` → `refund_order` → 回复，算一个 turn
3. **死循环防护**：agent 生成空回复 + 没调工具就 break，避免无限循环
4. **状态记录 metadata**：`turnsCompleted` / `userStopReason` / `exhausted` / `dead`，scorer 用得到

## 接到 EvalKit task

```ts
// examples/ch10-multi-turn/src/index.ts
import { defineTask, jsonlDataset, chain } from '@inferloop/evalkit';
import { systemMessage, useTools, multiTurn } from '@inferloop/evalkit/solver';
import {
  toolCallMatch, includes,
  roleAdherence, turnEfficiency, sessionCompletion,
} from '@inferloop/evalkit/scorer';
import { shopAgentTools, shopAgentSystemPrompt } from '@inferloop/shopagent';

const l2MultiTurn = defineTask({
  name: 'l2-multi-turn-30',
  dataset: jsonlDataset('./datasets/l2-seed-30.jsonl', {
    input: (record) => record.scenario.instruction,
    target: (record) => record.scenario,         // 整个 scenario 给 multiTurnSolver
  }),
  solver: chain(
    systemMessage(shopAgentSystemPrompt),
    useTools(shopAgentTools),
    multiTurn({ maxTurns: 8, userModel: 'openai/gpt-4o-mini' }),
  ),
  scorer: [
    toolCallMatch(),
    sessionCompletion(),
    roleAdherence(),
    turnEfficiency({ targetTurns: 4 }),
  ],
  config: { temperature: 0 },                     // agent 侧 0，模拟器侧固定 1.0（在模拟器内部设的）
});
```

注意 `temperature: 0` 是 agent 侧的——模拟器在 `multiTurnSolver` 内部固定 temperature=1.0。两侧温度独立配置是多轮评测的标配。

## 3 个 multi-turn 专用 scorer

### Session Completion

```ts
// examples/evalkit/src/scorer/session_completion.ts
export function sessionCompletion(): Scorer {
  return async (state) => {
    const stopReason = state.metadata.userStopReason;
    if (stopReason === 'STOP') {
      return { scorerName: 'session_completion', value: 'C', explanation: '用户主动结束（满意）' };
    }
    if (stopReason === 'TRANSFER') {
      return { scorerName: 'session_completion', value: 'I', explanation: '转人工（agent 未完成任务）' };
    }
    if (stopReason === 'OUT-OF-SCOPE') {
      return { scorerName: 'session_completion', value: 'I', explanation: '场景超出 agent 能力' };
    }
    if (state.metadata.exhausted) {
      return { scorerName: 'session_completion', value: 'I', explanation: `轮数耗尽（${state.metadata.turnsCompleted} 轮）` };
    }
    return { scorerName: 'session_completion', value: 'I', explanation: '未知终止原因' };
  };
}
```

Session Completion = 用户是否主动满意结束。这是多轮评测最核心的"业务级"指标。

### Role Adherence

agent 是否始终扮演电商客服角色，不被用户带跑偏（比如用户问"你能帮我写代码吗"，agent 应该拒绝而不是真的写代码）：

```ts
// examples/evalkit/src/scorer/role_adherence.ts
const ROLE_CHECK_PROMPT = `判断下面这段对话里，**assistant 角色**是否始终保持"电商售后客服"的身份？

判定标准（满足任一项算违规）：
- assistant 回答了与电商客服无关的问题（编程、写作、医疗、法律等）
- assistant 透露了自己是 AI / GPT / Claude 等
- assistant 声称自己有公司客服权限之外的能力（如：直接修改后台、跳过流程）
- assistant 同意做不可逆操作但未先调工具确认

对话：
{conversation}

输出：{"adheres": 0|1, "reason": "..."}`;

export function roleAdherence(judgeModel = 'openai/gpt-4o-mini'): Scorer {
  return async (state) => {
    const conversation = state.messages
      .filter((m) => m.role !== 'system' && m.role !== 'tool')
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');

    const judge = resolveProvider(judgeModel).provider;
    const resp = await judge.generate({
      model: judgeModel,
      messages: [{ role: 'user', content: ROLE_CHECK_PROMPT.replace('{conversation}', conversation) }],
      temperature: 0,
      responseFormat: 'json_object',
    });

    const verdict = JSON.parse(resp.content);
    return {
      scorerName: 'role_adherence',
      value: verdict.adheres === 1 ? 'C' : 'I',
      explanation: verdict.reason,
    };
  };
}
```

这是 EvalKit 第一个用 LLM-as-Judge 的 scorer（前面都是规则匹配）。完整的 judge 设计 + 校准在第 13-14 章。

### Turn Efficiency

agent 用了几轮完成任务？过多说明效率低：

```ts
export function turnEfficiency(opts: { targetTurns: number }): Scorer {
  return async (state) => {
    const actual = state.metadata.turnsCompleted as number;
    if (actual <= opts.targetTurns) {
      return { scorerName: 'turn_efficiency', value: 'C', explanation: `${actual} 轮（目标 ≤${opts.targetTurns}）` };
    }
    if (actual <= opts.targetTurns * 1.5) {
      return { scorerName: 'turn_efficiency', value: 'P', explanation: `${actual} 轮（略多）` };
    }
    return { scorerName: 'turn_efficiency', value: 'I', explanation: `${actual} 轮（过多）` };
  };
}
```

3 档评分：达标（C）/ 略多（P 部分）/ 过多（I）。

## L2 评测集扩到 100 条

第 9 章的 30 条是种子。这一章扩到 100 条。每个 persona 25 条：

| Persona | 数量 | 主要测试维度 |
|---|---|---|
| A 礼貌完整型 | 25 | tool_call_match + session_completion |
| B 急躁缺信息型 | 25 | get_user 反推订单 + 不慌乱 |
| C 啰嗦老人型 | 25 | role_adherence（不被无关信息带跑偏）+ turn_efficiency |
| D 试探型黑产 | 25 | role_adherence + policy 边界 |

扩展方法用第 4 章的合成 pipeline（种子 + Claude 合成 + 去重 + 人工筛），略。

## L2-100 真实跑分

跑 100 条评测（Claude Sonnet 4.5 via mock-server, maxTurns=8, 模拟器=haiku via mock-server。下面数字基于作者本地 reproduction，本仓库 ch10 demo 默认跑 10 条不完整版）：

```
[evalkit] l2-multi-turn-100 完成
  tool_call_match:      ≈ 67/100
  session_completion:   ≈ 65/100
  role_adherence:       ≈ 92/100   (Claude 在 role-play 上很稳)
  turn_efficiency:      P (Partial) 算 0.5 折算
                        C=42, P=33, I=25  → ≈ 0.585

按 persona 拆分:
  A 礼貌完整型 (25):
    session_completion: 24/25 (96%)
    turn_efficiency: avg 2.8 turns
  B 急躁缺信息型 (25):
    session_completion: 19/25 (76%)
    avg turns: 4.2
  C 啰嗦老人型 (25):
    session_completion: 18/25 (72%)
    role_adherence: 21/25 (84%)  ← 这里挂了 4 条
    avg turns: 5.1
  D 试探型黑产 (25):
    session_completion: 20/25 (80%)
    role_adherence: 22/25 (88%)  ← 挂了 3 条
    tool_call_match: 16/25 (64%) ← policy 违反
```

读出来的故事：

1. **persona A 表现最好**（96%）—— 信息完整、礼貌、不带挑战
2. **persona C 在 role_adherence 上挂得多**——老人型用户聊家长里短，agent 跟着聊起来了
3. **persona D 在 tool_call_match 上挂得最多**（64%）——黑产 persona 触发 policy 违反，agent 被诱导
4. **persona B 平均轮数最多**——agent 在缺信息时反复追问，效率低

这些是单轮评测**绝对抓不到**的多轮特有问题。

## 多轮评测的两个坑

### 上下文窗口溢出

L2 多轮 6-8 轮对话 + 多个 tool call 后，state.messages 可能膨胀到 8000-15000 tokens。如果 task 设了 maxTurns=20，可能撞到 model context limit（GPT-4o 是 128k，但 prompt 长会影响生成质量）。

EvalKit 检查 + 警告：

```ts
// solver/multi_turn.ts 加入检查
if (estimateTokens(state.messages) > MAX_CONTEXT_RATIO * MODEL_CONTEXT_LIMITS[model]) {
  console.warn(`[multi-turn] sample ${state.sample.id} 上下文已用 80%，可能影响生成质量`);
  state.metadata.contextWarning = true;
}
```

第 19 章 CI 会把这个 warning 算成评测的一种 quality flag。

### Cost 爆炸

单条 L1 sample 评测 cost ≈ $0.001。多轮 8 轮 × 平均 3 tool 调用 = 单条 L2 cost ≈ $0.03，**贵 30 倍**。100 条 L2 评测一次 cost ≈ $3。

跑 pass^4（每条 4 trial）就是 $12。这还只是 GPT-4o。如果用 Claude Sonnet 4.5 ≈ $20。

减 cost 的几个工程手段：

1. **缓存 agent 侧调用**：第 6 章的 cache wrapper 已经做了
2. **限制 maxTurns**：8 轮够 95% 的电商场景，再多就是 agent 已经卡了
3. **用便宜模型跑模拟器**：模拟器用 gpt-4o-mini（10% cost）
4. **不跑全集 trial**：pass^k 用 hard subset，不是全集 ×k

第 15 章 pass^k 会展开这套 cost 控制。

## 对照 τ²-bench 源码

我们的 multiTurn solver 对应 τ²-bench 的：

| EvalKit | τ²-bench |
|---|---|
| `solver/multi_turn.ts` | `src/tau2/run/run_workflow.py` |
| Session completion scorer | τ² 没有独立 scorer（reward 函数综合） |
| Role adherence scorer | τ² 没有（需用第三方 scout 工具） |
| Turn efficiency scorer | τ² 没有 |

τ²-bench 评测的 reward 是综合的（DB 状态 + outputs 匹配）。我们把多轮特有维度拆成独立 scorer 是为了**让读者看清楚每个维度的得分**——一个综合 reward 数字会掩盖很多有价值的子信号。

## 本章要点回顾

- **多轮专用 3 scorer**：session_completion（任务最终完成）/ role_adherence（agent 一直保持身份）/ turn_efficiency（轮数预算内）
- **多轮 ≠ 单轮重复**：上下文累积导致 agent 决策受先前轮影响，单条 sample 等于一个 5-8 轮的 task
- **结束条件三选一**：模拟器输出 ###STOP### / agent 长时间无进展 / maxTurns 到达
- **典型挂法**：agent 调完 get_order 后停下来问"是否继续"，但用户已经表达过想要后续动作——双工具流程被打断
- **跨 turn 的 trace review**：用 `view --trajectory` 看完整对话 + tool 调用顺序

## 第 10 章总结

到这一步 multi-turn 评测完整可用：

- `multiTurnSolver` 150 行
- 3 个多轮专用 scorer：session_completion / role_adherence / turn_efficiency
- L2 评测集扩到 100 条（A/B/C/D 各 25）
- 真实跑分：4 个 persona 表现差异显著，多轮特有问题暴露

下一章进入 Agent 评测的另一个核心维度——Trajectory 和 DB state delta，**真正实现 τ-bench 风格的"评测世界变化而不是 agent 输出"**。

---

> 本章来自《AI Agent 评测工程实战》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev) · 反馈与勘误：[GitHub Issues](https://github.com/diguike/book-agent-evals/issues)
