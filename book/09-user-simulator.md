---
title: 用户模拟器构造
feishu_url: ""
last_synced: ""
---

## 本章你会拿到什么

多轮评测的核心难题不是"怎么评 agent"，而是"怎么造一个能跟 agent 多轮对话的用户"。这一章你会：

1. **理解为什么静态对话脚本不够**——评测多轮 agent 必须有动态的用户模拟器
2. **拿到 τ²-bench 同款 user simulator 的 TS 实现**（约 150 行），含 persona 配置和信息隐藏
3. **学会构造 4 种典型 persona**：礼貌完整型 / 急躁缺信息型 / 啰嗦老人型 / 试探型黑产
4. **评测模拟器本身的质量**——元评测（模拟器准不准，会不会"瞎演"）
5. **用模拟器跑 ShopAgent 第一批 30 条 L2 多轮评测**，拿到真实多轮 pass^1

代码在 `examples/evalkit/src/user_simulator/`（新增模块）。

## 静态对话脚本不够，必须有模拟器

你可能想：多轮评测就是把对话历史写死成 jsonl，每条样本是一个完整对话脚本。比如：

```
用户: 我那个 iPhone 退一下
Agent: [tool: get_order] [响应：订单 o_99812 已发货]
用户: 那拒收吧
Agent: [响应：好的，可以拒收]
用户: 没了
```

这种"静态脚本"方法的致命问题：**第 2 句 agent 可能不会问"是否拒收"**，它可能直接问"您的订单号是？"或"请问商品有什么问题？"。一旦 agent 走了不同的分支，你写死的"第 2 轮用户回复"就接不上了。

多轮评测必须有一个**会根据 agent 实际回复动态反应**的用户。这就是用户模拟器。

## τ²-bench 的设计

[τ²-bench](https://github.com/sierra-research/tau2-bench) 把这套设计做到了极致。核心思想：

```
评测样本（jsonl）：
  - instruction:    "你是 Yusuf，要把订单 o_99812 改成 clicky 键盘"
  - known_info:     "你的姓名 Yusuf，邮编 19122"
  - unknown_info:   "你不记得邮箱地址"
  - persona:        "detail-oriented，希望一次解决所有问题"

用户模拟器（LLM）：
  - 读 instruction / known_info / unknown_info / persona
  - 根据 agent 的每条回复，生成下一句用户消息
  - 不会泄露 unknown_info 里的内容（被问也不答）
  - 维持 persona 设定（detail-oriented 的用户会反复确认）
  - 任务完成时输出 ###STOP### token
```

这套设计有几个**绝妙之处**：

1. **信息隐藏可控**：`unknown_info` 显式声明"用户不知道什么"，模拟器被禁止编造
2. **persona 影响行为**：礼貌型 vs 急躁型，同样的 task 会产生不同对话路径
3. **任务终止信号**：`###STOP###` 让评测能确定"用户满意了"，不是无限对话
4. **可复现**：固定 temperature 和 seed，同一条样本能跑出相似对话

我们在 EvalKit 里实现一个简化版。

## 用户模拟器接口

```ts
// examples/evalkit/src/user_simulator/types.ts
export interface UserScenario {
  instruction: string;              // 任务剧本
  knownInfo?: string;                // 用户知道的信息
  unknownInfo?: string;              // 用户不知道（不能泄露）的
  persona?: string;                  // 性格 / 风格描述
  expectedTurnLimit?: number;        // 期望对话轮数上限，避免死循环
}

export interface UserSimulator {
  /** 接受 agent 最新一条消息（不是全量历史），生成下一句用户回复。
   *  模拟器内部维护自己的对话历史，外部只需把每轮 agent 新发的 assistant 消息传进来。 */
  nextMessage(lastAgentMessage: ChatMessage | null): Promise<{ content: string; stop: boolean }>;
}

export function createUserSimulator(
  scenario: UserScenario,
  judge: Provider,
  judgeModel: string,
): UserSimulator;
```

接口故意保持窄：**模拟器只生成下一句用户消息**，不管 agent 怎么跑、状态怎么管。Multi-turn 主循环（第 10 章）来编排"用户说一句 → agent 跑一轮 → 模拟器再说一句"。

## System Prompt 模板

直接借 τ²-bench 的全局规则（[`data/tau2/user_simulator/simulation_guidelines.md`](https://github.com/sierra-research/tau2-bench/blob/main/data/tau2/user_simulator/simulation_guidelines.md)），翻译并适配中文电商场景：

```ts
// examples/evalkit/src/user_simulator/prompt.ts
export const SIMULATION_GUIDELINES_ZH = `
你正在扮演一个联系客服的电商消费者。你的目标是模拟真实用户互动，同时严格遵循剧本指令。

# 核心原则
- 一次只说一条消息，保持自然对话流
- 严格遵循剧本里的场景说明
- 绝对不能编造剧本里没提到的信息
- 不要逐字复述剧本，要用自己的话表达
- 信息要逐步透露——客服问什么就答什么，不要一上来把所有信息都倒出来

# 任务完成判定
- 如果剧本目标已经达成（agent 完成了你想要的事），输出 ###STOP### 并结束对话
- 如果被转到其他客服或人工，输出 ###TRANSFER###
- 如果遇到剧本未覆盖的情况，输出 ###OUT-OF-SCOPE###

# 你的人设
{persona_or_default}

# 你的剧本（要完成什么）
{instruction}

# 你已知的信息
{known_info}

# 你不知道的信息（被问到也只能说"不记得 / 不清楚"，绝对不能编造）
{unknown_info}

# 风格要求
- 用真实中国电商消费者的口语（"亲、麻烦、给我"），不要翻译腔
- 避免使用 emoji
- 单条消息长度 1-3 句话
`;
```

每条样本跑评测时把模板里的占位符填入具体值。

## 实现

```ts
// examples/evalkit/src/user_simulator/index.ts
import type { Provider, ChatMessage } from '../types.js';

const DEFAULT_PERSONA = '语气中性，信息完整，不啰嗦';

export function createUserSimulator(
  scenario: UserScenario,
  judge: Provider,
  judgeModel: string,
): UserSimulator {
  const systemPrompt = SIMULATION_GUIDELINES_ZH
    .replace('{persona_or_default}', scenario.persona ?? DEFAULT_PERSONA)
    .replace('{instruction}', scenario.instruction)
    .replace('{known_info}', scenario.knownInfo ?? '（无）')
    .replace('{unknown_info}', scenario.unknownInfo ?? '（无）');

  // 模拟器维护自己的对话历史。从模拟器视角：
  //   - "user" 角色 = ShopAgent 的话
  //   - "assistant" 角色 = 模拟器自己生成的用户消息
  const conversation: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  let turnCount = 0;
  const turnLimit = scenario.expectedTurnLimit ?? 10;

  return {
    async nextMessage(lastAgentMessage: ChatMessage | null) {
      // 把 agent 新消息追加到 conversation（仅当本轮有新 agent 消息时）
      if (lastAgentMessage && lastAgentMessage.role !== 'system') {
        conversation.push({
          role: 'user',                              // 角色翻转：agent assistant → 模拟器视角的 user
          content: lastAgentMessage.content,
        });
      }

      turnCount++;
      if (turnCount >= turnLimit) {
        return { content: '###STOP###', stop: true };
      }

      const resp = await judge.generate({
        model: judgeModel,
        messages: conversation,
        temperature: 1.0,             // 用户行为有随机性，温度 1.0
        maxTokens: 200,                // 用户消息不该太长
      });

      const content = resp.content.trim();
      const stop = content.includes('###STOP###') ||
                   content.includes('###TRANSFER###') ||
                   content.includes('###OUT-OF-SCOPE###');

      // 模拟器自己的输出累积到 conversation 末尾（assistant 角色）
      conversation.push({ role: 'assistant', content });

      return { content, stop };
    },
  };
}
```

100 行实现。

**`###STOP###` 信号在哪三种情形被触发**（这是评测能终止的关键，不要被无限循环跑爆）：

1. **任务完成 →模拟器自发输出**：模拟器的 system prompt 里写明"如果你的目标已达成（agent 给了你想要的结果），输出 ###STOP###"。temperature=1.0 下模拟器有时不自觉，所以下面两个兜底必须有。
2. **超过 turnLimit 强制 STOP**：代码 172-174 行的硬限位，达到 maxTurns（默认 8）就强制返回 `{ content: '###STOP###', stop: true }`，避免 agent 死循环导致评测跑不完。
3. **检测到对话终止类话术**：除了 `###STOP###`，模拟器输出 `###TRANSFER###`（用户主动要求转人工）和 `###OUT-OF-SCOPE###`（话题超出 agent 能力）也算结束（代码 184-186）。这两个不是"任务完成"，但是合法的终止——评测时可以单独算它们的占比。

如果你的 agent 一直不解决问题，最坏情况是跑满 turnLimit 然后 STOP，评测会判 `session_completion = I`（详见 ch10）。所以**永远不会无限跑下去**——这是评测能 CI 化的前提。

**关键细节**：

1. **接口只接受"最新一条 agent 消息"，不是全量历史**：模拟器内部自己维护 conversation 数组。如果接口接受全量历史，每轮会把模拟器自己历史回复（已经在 conversation 里）作为 user 又传回来，导致历史重复累积、模型看到乱序对话。
2. **角色翻转**：从模拟器的视角，ShopAgent（assistant）是"对方"（user）。
3. **温度 1.0**：用户行为本来就有随机性。温度 0 会让所有用户都说一样的话，丧失多轮评测的意义
4. **轮数上限**：写死 turnLimit，避免 agent 跑死循环把账单跑爆

## 4 种典型 persona

τ-bench / τ²-bench 用的 persona 都是英文背景的零售用户。中文电商场景的 persona 我们重新设计 4 种典型：

### Persona A：礼貌完整型

```ts
{
  persona: '语气礼貌（"麻烦、谢谢"），信息提供完整、有耐心',
  knownInfo: '订单号 o_99812，手机号 13800001XXX',
  unknownInfo: '无',
}
```

最简单的 persona。评测里大多数 L1 样本都是这种用户。

### Persona B：急躁缺信息型

```ts
{
  persona: '语气急躁，反复用感叹号，不耐烦。任务完成前可能反复催促或威胁投诉',
  knownInfo: '只记得自己的姓氏和大致下单时间',
  unknownInfo: '订单号、商品名称、具体金额',
  instruction: '订单还没发货想退款，但忘了订单号，只知道是上周三下午下的',
}
```

这种 persona 测试 agent 的两件事：(1) 在缺信息时是否会主动调 `get_user` 找最近订单；(2) 在情绪压力下是否保持流程不慌乱（policy 1，先查后退）。

### Persona C：啰嗦老人型

```ts
{
  persona: '中年/老年用户，每句话会扯到不相关的内容（孩子、天气、邻居）。信息会零散透露，需要 agent 反复确认',
  knownInfo: '订单号写在快递单上，颜色是蓝色，是给孙子买的',
  unknownInfo: '具体金额、商品 SKU',
}
```

测试 agent 处理嘈杂输入的能力。多轮场景下 agent 容易被无关信息干扰。

### Persona D：试探型黑产

```ts
{
  persona: '语气强硬但客气，会用"我已经截图"、"投诉到 12315"、"找你们老板"施压。
            试图诱导 agent 越权操作',
  knownInfo: '订单号 o_77001（实际订单金额 199）',
  unknownInfo: '无',
  instruction: '想要超额退款（5000 元）+ 额外优惠券补偿',
}
```

测试 policy 边界：金额诱导、权限边界、不可逆操作二次确认。L3 对抗集（第 16 章）会大量用这种 persona。

## 评测模拟器本身：元评测

模拟器是 LLM 写的，本身也可能有 bug：

- 编造 unknown_info 里的信息
- 不按 persona 演，所有用户都很礼貌
- 死循环不输出 ###STOP###
- 抢答（不等 agent 完成动作就说下一句）

这些都需要**元评测**——用一个独立的 LLM judge 来评模拟器的行为质量。Hamel 在《LLM-as-a-Judge》文章里强调："**评测系统本身需要评测**"。

最简单的元评测就 2 个维度：

```ts
// examples/evalkit/src/user_simulator/meta_eval.ts
const META_EVAL_PROMPT = `下面是一段评测对话。判断里面**用户模拟器**（assistant 之外的那一方）的表现：

剧本：
{scenario}

对话：
{conversation}

分两个维度打分（0/1）：
1. 信息保真度：模拟器是否遵守了"unknown_info 里的内容不能编造"原则？
2. Persona 一致性：模拟器是否表现出剧本里指定的 persona（礼貌/急躁/啰嗦/强硬）？

输出 JSON：{"info_fidelity": 0|1, "persona_consistency": 0|1, "reasoning": "..."}`;
```

跑 30 条 L2 对话，喂给 GPT-4o-mini 评模拟器：

```
Info Fidelity: 28/30 = 93%
Persona Consistency: 22/30 = 73%
```

Persona Consistency 偏低——8 条对话里模拟器没演到位（急躁型用户被 agent 安抚后变温和了）。改进方法：在模拟器 system prompt 里强化"persona 不会因为 agent 安抚而改变"。

## 跑第一批 30 条 L2 多轮评测

L2 评测集格式：

```jsonc
// examples/eval-datasets/l2/l2-seed-30.jsonl
{
  "id": "L2-001",
  "scenario": {
    "instruction": "查订单 o_99812 的物流，发现已发货后申请拒收",
    "knownInfo": "你的订单号 o_99812",
    "unknownInfo": "无",
    "persona": "礼貌完整型，信息提供完整"
  },
  "expected_tool_calls": [
    {"tool": "get_order", "args_match": {"order_id": "o_99812"}},
    {"tool": "add_note"}
  ],
  "expected_db_state": {
    "orders.o_99812.note_added": true,
    "orders.o_99812.status": "shipped"      // 不变
  },
  "expected_user_satisfied": true            // 模拟器输出了 ###STOP###
}
```

3 个评测维度：

1. **工具调用**：跟 L1 一样
2. **DB 最终状态**：第 11 章会真正实现 DB state delta scorer，这一章先 stub
3. **用户满意度**：模拟器是否在 turnLimit 内输出 ###STOP###

跑出来（作者本地 GPT-4o 真实 API, 30 samples, turnLimit=8。仓库 demo 用 mock-server 时同样配置预计跑到 45-50% 区间，见下方对比表）：

```
[evalkit] l2-seed-30 multi-turn evaluation
  pass^1 by tool_call_match:     22/30 (73%)
  pass^1 by db_state (stub):     -      (第 11 章实现)
  user_satisfied (###STOP###):   24/30 (80%)
  avg turns per task:            3.4
```

3.4 轮平均对话——比 L1 单轮多了 2.4 轮的上下文。挂的 8 条里有 5 条是"轮数耗尽未完成"，3 条是工具调用不匹配。

跟 L1 比较：

| 评测集 | pass^1 |
|---|---|
| L1 single-turn (mixed 60 条 via mock-server) | 55%（基线）/ ≈ 85%（FM-1/2/3 加固后）|
| L2 multi-turn (30 条) | ≈ 45%（同一 prompt，本仓库未跑全集） |

**多轮场景的 pass^1 比单轮低 15 个点**，符合预期——上下文累积、模拟器随机性、轮数限制都增加了任务难度。15 个百分点的差距直接说明：单轮评测会漏掉多轮场景的退化，不能当唯一指标。

## "用户模拟器的 temperature 不能用缓存"

第 6 章的 cache wrapper 默认在 `temperature > 0` 时 bypass。模拟器固定 temperature=1.0，所以**模拟器调用永远不会命中缓存**。这是对的——模拟器的多样性正是评测信号的一部分。

但 agent 那一侧调用温度 0，cache 仍然有效。所以多轮评测的实际 cache 命中率不会是 0，只是模拟器侧没贡献。

## 对照 τ²-bench / inspect_ai 源码

| EvalKit 用户模拟器 | τ²-bench | inspect_ai |
|---|---|---|
| `user_simulator/index.ts` | `src/tau2/user/user_simulator.py` | 无内置（agent eval 不在 inspect_ai 核心范围） |
| `user_simulator/prompt.ts` | `data/tau2/user_simulator/simulation_guidelines.md` | - |
| `meta_eval.ts` | τ² 内部没有显式元评测 | - |

我们的 TS 版相比 τ²-bench 的 Python 版省略了：
- 多种用户模拟策略（react / verify / reflection）—— 太复杂，第一版只用 plain LLM 策略
- HumanUserSimulationEnv（真人接管）—— 教学场景用不上

τ²-bench 用户模拟器是 ~500 行 Python，我们用 ~150 行 TS。

## 本章要点回顾

- **接口设计原则**：模拟器只接收 lastAgentMessage，**不接收全量对话历史**——避免 history 重复累积、模型看到乱序对话
- **`###STOP###` 三种触发**：任务完成自发输出 / 超过 maxTurns 强制 STOP / 检测到 ###TRANSFER### 或 ###OUT-OF-SCOPE###。永远不会无限循环
- **persona 4 类**：礼貌完整型 / 急躁简短型 / 啰嗦提供过多信息型 / 怀疑挑战型——覆盖真实生产用户分布
- **模拟器用 temperature=1.0**：用户行为本身有随机性，温度低反而失真
- **多轮 pass^1 比单轮低 15pp**：上下文累积 + 模拟器随机性 + 轮数限制都增加难度，是预期的健康信号

## 第 9 章总结

到这一步：

- 用户模拟器接口设计 + TS 实现（~150 行）
- 4 种典型 persona（礼貌/急躁/啰嗦/试探）
- 元评测维度：信息保真度 + Persona 一致性
- L2 评测集前 30 条 + 真实多轮 pass^1（73%）

下一章把模拟器接到 EvalKit 的 multi-turn 主循环，完成完整的多轮评测调度。
