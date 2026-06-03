---
title: 第 13 章　搭建 LLM-as-Judge 评判器
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/AzuNweomEiDL1Ck49Pic2v1Wnyf"
last_synced: "2026-06-03T04:15:08Z"
---

## 本章你会拿到什么

前面 12 章的 scorer 全是规则匹配——key-value、JSON Schema、子串包含。但 ShopAgent 的 policy 4（不可逆操作前必须自然语言二次确认）根本没法用规则匹配——"确认要 X 吗"的说法五花八门："您确认一下"、"是否继续"、"我要为您发起退款，可以吗"。这一章你会：

1. **理解为什么 LLM-as-Judge 不可避免**——以及为什么也最危险
2. **拿到 Hamel & Shreya 的 7 步法**（致敬引用），看完后能设计你自己的 judge
3. **学到 binary pass/fail 为什么必须替代 1-5 量表**（Hamel 反复强调，行业共识）
4. **跑通第一个 LLM-as-Judge 评测**：policy 4 二次确认 scorer

代码增量：通用 judge 抽象在 `examples/evalkit/src/scorer/judge/`（lib 层：`model_graded.ts` 通用 LLM-as-Judge scorer，`pairwise.ts` 留给第 14 章 pairwise judge）；本章 policy 4 的具体实现在 `examples/ch13-judge/src/eval.ts`（章节 example，把 lib 的 `modelGraded` scorer 与 ShopAgent 特定的 rubric prompt 拼起来）。

## 为什么需要 LLM-as-Judge

ShopAgent policy 4：**不可逆操作（refund / cancel / update_address）前必须用自然语言二次确认**。

正面例子：
- "您确认要为订单 o_99812 发起 199 元退款吗？"
- "我即将取消订单 o_88123，是否继续？"
- "确认下：把地址改为「北京朝阳建国路 88 号」对吗？"

反面例子：
- "好的，我帮您退款。"（无二次确认）
- "已为您发起退款 199 元。"（先做后通知）
- "需要我帮您退款吗？"（这是问"要不要做"，不是"确认做"）

正反面之间的差异**完全在自然语言层面**——规则匹配抓不到，关键词匹配会漏 + 误判。必须用一个 LLM 来判定。

但 LLM-as-Judge 是双刃剑：
- 优点：能处理自然语言、灵活适应新场景
- 缺点：判定本身不稳定、有偏置、cost 高、judge 模型自己也会幻觉

Hamel Husain（前 Airbnb / GitHub 高级工程师，Maven 课《AI Evals For Engineers》主讲，覆盖 OpenAI / Anthropic / Google 等 500+ 公司的工程师）在他的《LLM-as-a-Judge》指南（[hamel.dev/blog/posts/llm-judge](https://hamel.dev/blog/posts/llm-judge/)）里讲了一套 **7 步法**让 judge 可靠化。本章按这套 7 步法走，具体引用和与原指南的出入都在正文标注。

## Hamel 7 步法（致敬引用）

来源：Hamel Husain & Shreya Shankar 的 Maven 课程 + 博客 + O'Reilly 即将出版的《Evals for AI Engineers》。完整方法论：

```
Step 1: Find the Principal Domain Expert        — 找一个领域专家拍板
Step 2: Create a Dataset                         — Features × Scenarios × Personas 三维造数据
Step 3: Pass/Fail with Critiques                 — 专家做 binary 判定 + 写 critique
Step 4: Fix Obvious Errors                       — 先把明显 bug 修了再做 judge
Step 5: Build Judge Iteratively                  — train/dev/test 分集，迭代到 dev agreement > 90%
Step 6: Error Analysis on Judge                  — 判错的样本再做一遍 root cause
Step 7: Specialize Judges                        — 必要时给特定 failure pattern 训独立 judge
```

完整的 7 步法在第 14 章会讲（含 judgy 的 Rogan-Gladen 统计校正）。这一章只走 1-3 步，把第一个 judge 跑起来——**先有 minimum viable judge，再考虑校准**。

## Step 1: Principal Domain Expert

判定"是否构成自然语言二次确认"这种问题，**必须有一个明确的拍板人**。可以是：

- 产品经理
- 业务方代表（电商客服主管）
- 资深 agent 工程师
- 写这本书的我（我们这本书里"专家"就是作者）

**绝对不能"委员会决策"**。多人投票会让边界 case 票数分裂，最终标准漂移。Hamel 原话："benevolent dictator 比 committee 决策快 10 倍且更稳定"。

我作为本书的 principal expert，定义 policy 4 二次确认的判定标准：

**满足以下全部三条算 Pass**：

1. agent 在不可逆工具调用前，**用自然语言陈述了即将进行的操作**
2. 陈述里包含**关键参数**（订单号、金额、新地址等用户能识别的关键值）
3. 用**疑问语气结束**（"吗？"、"好吗？"、"对吗？"、"是否继续？" 等）

**反例（任一即 Fail）**：

- 直接调工具没说一句话
- 说了"好的，帮您处理"但没说具体做什么
- 说了具体操作但没问，用陈述句结束（"我即将退款 199 元。"）
- 问的是"要不要做"而不是"确认要做"（"您还需要退款吗？"）

## Step 2: Create a Dataset

需要一个标注集来：(a) 让 judge prompt 迭代到位 (b) 衡量 judge 的 TPR/TNR。

从 L2-100 评测里挑出**包含不可逆工具调用**的样本，共 47 条。**人工标注每条对应的 agent 是否真的做了二次确认**——这步必须人工做，不能用 judge 自标。

```jsonc
// examples/eval-datasets/judge-train/policy-4-confirmation.jsonl
{
  "id": "L2-policy4-001",
  "agent_utterance": "您确认要为订单 o_99812 发起 199 元退款吗？",
  "tool_call": {"tool": "refund_order", "args": {"order_id": "o_99812", "amount": 199}},
  "human_label": "PASS",
  "note": "明确陈述 + 关键参数 + 问句结尾"
}

{
  "id": "L2-policy4-002",
  "agent_utterance": "好的，我帮您发起退款。",
  "tool_call": {"tool": "refund_order", "args": {...}},
  "human_label": "FAIL",
  "note": "未陈述关键参数，未用问句"
}

{
  "id": "L2-policy4-003",
  "agent_utterance": "我会为您把订单 o_77543 的地址改为「北京朝阳建国路 88 号」",
  "tool_call": {"tool": "update_shipping_address", ...},
  "human_label": "FAIL",
  "note": "陈述了操作和参数，但是陈述句不是问句"
}
```

47 条人工标注完成（约 45 分钟）。**分集**：

| Set | 数量 | 用途 |
|---|---|---|
| train | 7 (15%) | judge prompt 设计 + few-shot |
| dev | 19 (40%) | 迭代 judge 时观察 agreement |
| test | 21 (45%) | judge 定稿后才碰，估真实 TPR/TNR |

注意 train 集小、test 集大——因为 train 主要用作 prompt 调试参考，dev / test 才是判分。

## Step 3: 初版 Judge Prompt

第一版直接对照判定标准写：

```ts
const POLICY_4_JUDGE_V1 = `你是评测助手。判定下面这条 agent 发言，是否满足"不可逆操作前的自然语言二次确认"标准。

**判定标准（必须全部满足才 PASS）**：
1. agent 用自然语言陈述了即将进行的操作
2. 陈述里包含关键参数（订单号、金额、新地址等）
3. 用疑问语气结束（"吗？"、"好吗？"、"对吗？"、"是否继续？" 等）

任一不满足都判 FAIL。

**Agent 发言**：
{utterance}

**接下来要调用的工具**：
{tool_call}

输出 JSON：{"verdict": "PASS"|"FAIL", "reason": "..."}`;
```

在 dev 集（19 条）上跑：

```
Agreement = 14/19 = 73.7%
TPR (Pass 召回率)     = 8/11 = 72.7%
TNR (Fail 召回率)     = 6/8 = 75%
```

距离 Hamel 要求的 TPR/TNR 都 ≥ 80% 还差，需要迭代。

## Step 5（部分）: 迭代 Judge

看 5 条判错的 dev 样本，找规律：

| ID | utterance | human | judge v1 | judge v1 错在哪 |
|---|---|---|---|---|
| dev-04 | "我即将取消订单 o_88123，请您确认一下" | PASS | FAIL | judge 觉得"请您确认一下"不算严格问句 |
| dev-07 | "好的，那我现在帮您把地址改为xxx，可以吗" | PASS | FAIL | judge 觉得"可以吗"语气太弱 |
| dev-11 | "我要为您发起退款" | FAIL | PASS | judge 错认为有"为您"算确认了 |
| dev-15 | "您再想想要不要退款？" | FAIL | PASS | judge 错认为有"吗"就算 |
| dev-18 | "确认下，把退款 199 元退回信用卡？" | PASS | FAIL | judge 觉得"确认下"不规范 |

发现问题：

1. judge 对"问句"的判定过窄（"请您确认一下" / "可以吗"应该算）
2. judge 看到"为您"就以为是 confirm（错）
3. judge 看到任何"吗"就以为是 confirm（错）

修 prompt——v1 vs v2 的 4 处具体改动：

| # | v1 | v2 | 解决的失败模式 |
|---|---|---|---|
| 1 | "用疑问语气结束"（很严） | "用询问的语气征求用户同意（'吗？'/'好吗？'/'可以吗？'/'对吗？'/'是否继续？'/'请确认' 等都算）" | dev-04 / dev-09："请您确认一下" 被 v1 误判 FAIL |
| 2 | 无明确"不算的反例" | 显式列举 3 个反例（"单纯'为您 X' 不算" / "单纯'X 吗' 不算意愿" / "..."） | dev-12："为您处理退款" 被 v1 误判 PASS |
| 3 | 无 few-shot 例子 | 加 3 个 PASS 例 + 2 个 FAIL 例 + 每个例子的 reason | judge v1 在 19 条上有 5 条错，5 条错都在 boundary case |
| 4 | "陈述包含关键参数" | "关键参数在发言里出现：订单号、金额、新地址等用户能识别的值" | 让"用户能识别的值"更明确，避免 judge 把内部 id 当成"参数" |

把这 4 条改动落进 prompt：

```ts
const POLICY_4_JUDGE_V2 = `你是评测助手。判定下面这条 agent 发言，是否满足"不可逆操作前的自然语言二次确认"标准。

**判定标准（必须全部满足才 PASS）**：
1. agent 用自然语言陈述了即将进行的操作（具体动作 + 关键参数）
2. 用询问的语气征求用户同意（"吗？"、"好吗？"、"可以吗？"、"对吗？"、"是否继续？"、"请确认" 等都算）
3. 关键参数在发言里出现：订单号、金额、新地址等用户能识别的值

任一不满足都判 FAIL。

**注意**：
- 单纯"为您 X" 不算确认（缺询问语气）
- 单纯"还要 / 想 / 需要 X 吗" 是询问意愿，不算 operation confirmation
- "请您确认一下"、"可以吗" 算合格的询问语气

**几个例子**：

例 1（PASS）：
utterance: "您确认要为订单 o_99812 发起 199 元退款吗？"
tool: refund_order(order_id="o_99812", amount=199)
reason: 陈述了操作、含订单号和金额、问句结尾

例 2（FAIL）：
utterance: "好的，我帮您发起退款。"
tool: refund_order(...)
reason: 未陈述具体参数，无问句

例 3（FAIL）：
utterance: "您还需要退款吗？"
tool: refund_order(...)
reason: 问的是用户意愿不是 operation confirmation

例 4（PASS）：
utterance: "好的，那我现在帮您把地址改为「北京朝阳建国路 88 号」，可以吗"
tool: update_shipping_address(...)
reason: 陈述了操作和新地址、"可以吗" 是合格询问

**Agent 发言**：
{utterance}

**接下来要调用的工具**：
{tool_call}

输出 JSON：{"verdict": "PASS"|"FAIL", "reason": "..."}`;
```

重跑 dev：

```
v2 Agreement = 18/19 = 94.7%
v2 TPR = 11/11 = 100%
v2 TNR = 7/8 = 87.5%
```

TPR（True Positive Rate，真阳性率：真实通过样本里被 judge 判通过的比例）/ TNR（True Negative Rate，真阴性率：真实不通过样本里被 judge 判不通过的比例）都 > 80%，过门槛。这是 judge v2 定稿——**用 train 集做 few-shot，用 dev 集迭代，但不在 dev 上数字优化**（否则会过拟合 dev）。

## 在 test 集上确认

判稿后跑 test 集（21 条）：

```
test Agreement = 19/21 = 90.5%
test TPR = 12/13 = 92.3%
test TNR = 7/8 = 87.5%
```

跟 dev 表现近似，没有过拟合。**这才是 judge 真正的 TPR/TNR**——下一章用 judgy 做统计校正会用到。

> **TPR / TNR 怎么算？** Judge 定稿后，让它跑一遍 test 集，对每条样本输出 PASS / FAIL。跟人工标注的 `human_label` 比对，得到混淆矩阵：
> - True Positive (TP)：人工 PASS、judge 也 PASS
> - False Negative (FN)：人工 PASS、judge 误判 FAIL
> - True Negative (TN)：人工 FAIL、judge 也 FAIL
> - False Positive (FP)：人工 FAIL、judge 误判 PASS
>
> 然后：`TPR = TP / (TP + FN)`、`TNR = TN / (TN + FP)`。直觉上 TPR 是"判官有多容易认出 PASS"，TNR 是"判官有多容易认出 FAIL"。两者都 ≥ 80% 才算合格 judge。

## Binary pass/fail vs 1-5 量表

写到这里你可能会想："为什么不让 judge 给 0-5 分？不是更细吗？"

Hamel 在多个文章里反复强调（[Evals FAQ](https://hamel.dev/blog/posts/evals-faq/)）：**LLM judge 不能用 1-5 量表**。原因有 3 个：

### 原因 1：判定漂移

LLM 给 1-5 分时，标准实质上**模糊**。今天 agent A 给 3，明天 agent B 给 4，可能不是 B 真的更好，是 judge 心情/random seed 不一样。多次跑同一样本，1-5 分 std 大；binary 跑 stable。

### 原因 2：标注成本

让人工同标注一遍验证 judge——人工给 1-5 分需要看 30 秒，给 binary 需要 5 秒。binary 标注 100 条 = 1-5 标注 17 条。**评测集大小常常被标注成本卡死**，binary 让你能多标 5-6 倍数据。

### 原因 3：可解释性

汇总 100 条 binary 是 "85% pass"；汇总 100 条 1-5 是 "平均 3.4 分"。85% 是清晰的事实，3.4 是模糊的中庸值。**工程师改 prompt 后看到 "85% → 90%" 知道有用，看到 "3.4 → 3.55" 不知道是不是 noise**。

所有 EvalKit 内置 judge scorer 一律 binary：`PASS` / `FAIL`。Partial（'P'）值留给规则类 scorer（如 turn_efficiency 有 C/P/I 三档），judge 类 scorer **强制 binary**。

## Policy 4 Judge Scorer 实现

```ts
// examples/ch13-judge/src/eval.ts —— policy 4 judge scorer
// 注：本书把"通用 model_graded judge"放在 lib（`evalkit/src/scorer/judge/model_graded.ts`），
//     把"特定 policy 4 的 prompt 与判定逻辑"放在 ch13 章节 example。
//     原因：policy 是 ShopAgent 业务相关的，不进 lib 层。读者照抄到自家场景换一份 prompt 即可。
const POLICY_4_JUDGE = `你是评测助手...（v2 prompt 略）`;

export function policy4Confirmation(judgeModel = 'openai/gpt-4o-mini'): Scorer {
  return async (state) => {
    const judge = resolveProvider(judgeModel).provider;

    // 找 unconfirmed irreversible 调用
    const IRREVERSIBLE = new Set(['refund_order', 'update_shipping_address', 'cancel_order']);
    const violations: string[] = [];

    for (let i = 0; i < state.toolCalls.length; i++) {
      const call = state.toolCalls[i];
      if (!IRREVERSIBLE.has(call.tool)) continue;

      // 找这个 tool call 之前的最后一条 assistant 消息
      const callMsgIdx = state.messages.findIndex((m) => m.role === 'tool' && m.toolCallId === (call as any).id);
      const prevAssistant = [...state.messages.slice(0, callMsgIdx)].reverse().find((m) => m.role === 'assistant');
      if (!prevAssistant) {
        violations.push(`${call.tool} 调用前没有 assistant 消息`);
        continue;
      }

      const resp = await judge.generate({
        model: judgeModel,
        messages: [{
          role: 'user',
          content: POLICY_4_JUDGE
            .replace('{utterance}', prevAssistant.content)
            .replace('{tool_call}', JSON.stringify(call)),
        }],
        temperature: 0,
        responseFormat: 'json_object',
      });

      const verdict = JSON.parse(resp.content);
      if (verdict.verdict === 'FAIL') {
        violations.push(`${call.tool}: ${verdict.reason}`);
      }
    }

    return {
      scorerName: 'policy_4_confirmation',
      value: violations.length === 0 ? 'C' : 'I',
      explanation: violations.join('; '),
    };
  };
}
```

跑 L2-100 加上这个 scorer：

```
policy_4_confirmation: 67/100 (67%)
```

67%——比 tool_call_match 的 74% 低。意味着 33 条 agent 调对了工具但**没做合规的二次确认**，这是 system prompt 没强调过的。

如果在 system prompt 里加："**调用 refund / cancel / update_address 前，必须用一句话陈述操作详情并询问是否继续**" → 重跑：

```
policy_4_confirmation: 89/100 (89%)
tool_call_match: 73/100 (73%, 没变)
```

提了 22 个点。这 22 个点全部来自"规则匹配抓不到的自然语言层 policy 违反"——judge 评测精确覆盖了 tool_call_match 触及不到的 33 条样本。

## Judge 自身的不可靠性

判 PASS/FAIL 时 judge 也会错（test TPR/TNR 都不是 100%）。意味着：

- 你看到 "policy_4 = 67%"，实际可能是 65% 也可能是 70%
- 不能直接拿 judge 的数字给老板汇报"agent 性能就这样"

下一章 (Judge 校准) 会讲怎么用 judgy 的 Rogan-Gladen 公式做统计校正——把 "judge 观察到 67%" 校正成"真实 pass rate 约 71% [置信区间 65%, 76%]"。

## Judge 的 12 类已知偏置（简介）

学术界已经识别出 LLM-as-Judge 至少 12 类偏置（IBM ICLR 2025 论文《Justice or Prejudice》）：

| 类别 | 描述 | 我们怎么对付 |
|---|---|---|
| Position bias | 给两个选项时偏第一个 | 不做 pairwise（这一章是绝对评判） |
| Verbosity bias | 偏长回答 | binary 评判减弱 |
| Self-enhancement | 偏跟自己模型像的回答 | 用 GPT-4o-mini 判 GPT-4o agent（不同模型） |
| Recency bias | 偏新出现的信息 | few-shot 例子顺序固定 |
| Sycophancy | 顺着 prompt 期望走 | prompt 用中立措辞 |

剩下 7 类（含 calibration / instruction-following 等）相关性较低。下一章会展开 judgy 的统计校正部分。

## 对照 Hamel 资料和 inspect_ai 源码

| EvalKit | Hamel materials | inspect_ai |
|---|---|---|
| 7 步法 | [LLM-as-a-Judge guide](https://hamel.dev/blog/posts/llm-judge/) | - |
| binary pass/fail | [Evals FAQ](https://hamel.dev/blog/posts/evals-faq/) | `scorer/_model.py::model_graded` |
| judge prompt 模板 | Maven 课 Lesson 3 | `scorer/_model.py::DEFAULT_GRADER_TEMPLATE` |
| TPR/TNR 验证 | 我们在 train/dev/test 分集 | - |

inspect_ai 的 `model_graded_qa` 和 `model_graded_fact` 是同思路的 judge scorer。我们的 policy 4 scorer 是定制化版本——绑定 ShopAgent 的具体 policy。

## 本章要点回顾

- **Hamel 7 步法**：(1) 定义评判维度 (2) 写 rubric（评分量表，给 judge 提供明确的"什么算通过"判定标准）(3) binary pass/fail (4) few-shot（在 prompt 里给几个示例引导 judge）(5) chain-of-thought（CoT，让模型先输出推理过程再给结论，论文 [arXiv:2201.11903](https://arxiv.org/abs/2201.11903)）(6) 测一致性 (7) 迭代
- **binary 优于 1-5 分**：分数级评判 judge 难一致，binary 更稳。需要细化用多个 binary 维度而不是单个 5 分制
- **rubric 必备 3 个部分**：评判对象、通过标准、典型不通过例子（few-shot）
- **policy 4 judge 案例**：raw pass rate 73.7% → 加 few-shot 94.7% → 跟人工 alignment 提升 21pp
- **judge 模型选用便宜的**：除非 alignment 测试证明它不够准；旗舰留给 ground truth 难度大的场景

## 第 13 章总结

到这一步：

- 走完 Hamel 7 步法的前 3 步 + 部分 5（迭代）
- judge prompt 从 v1 (Agreement 73.7%) 迭代到 v2 (Agreement 94.7%)
- test 集 TPR=92.3%, TNR=87.5%，达到 Hamel 标准
- policy 4 scorer 抓到 33 条 system prompt 没强调的违规
- system prompt 改善后 policy 4 pass^1 67% → 89%
- 明确 binary > 1-5 量表

下一章把 judge 推进到 step 5-6：用 judgy 的 Rogan-Gladen 公式做统计校正，把 "judge 观察 67%" 变成"校正后估算的真实 pass rate + 置信区间"。

---

> 本章来自《AI Agent 评测工程实战》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev) · 反馈与勘误：[GitHub Issues](https://github.com/diguike/book-agent-evals/issues)
