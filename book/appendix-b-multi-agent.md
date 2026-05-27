---
title: 附录 B：多 Agent 评测
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/HkLswsOVoi1QnDkCA7dcwjbVnDd"
last_synced: "2026-05-27T14:59:41Z"
---

## 附录定位

主线 20 章用的 ShopAgent 是**单 agent**——一个 LLM + 8 工具 + 5 policy。生产里很多 agent 系统采用**多 agent 架构**：路由 agent + 多个专员 agent，handoff 工作给合适的专员。例如：

```
用户消息
    ↓
路由 agent（意图识别）
    ↓
┌──────────┬──────────┬──────────┐
退款专员   物流专员   推荐专员
```

多 agent 系统的评测**比单 agent 多 3 个维度**。这个附录给一个简化的多 agent 版本 ShopAgent 和评测方法。

## 多 Agent 架构特殊评测维度

### 维度 1：路由正确性

路由 agent 是否把对话交给了正确的专员？

```jsonc
{
  "id": "MULTI-001",
  "user_input": "我那个订单 o_99812 想退款",
  "expected_route": "refund_specialist",
  "forbidden_route": ["logistics_specialist", "recommendation_specialist"]
}
```

简单 scorer：

```ts
export function routingAccuracy(): Scorer {
  return async (state) => {
    const expected = state.sample.target.expected_route;
    const actualRoute = state.metadata.routedTo;
    return {
      scorerName: 'routing_accuracy',
      value: actualRoute === expected ? 'C' : 'I',
      explanation: `期望路由 ${expected}, 实际 ${actualRoute}`,
    };
  };
}
```

### 维度 2：Handoff 完整性

路由 agent 把上下文交给专员时，关键信息是否传递？

```
路由 agent 收到: "我订单 o_99812 想退款"
路由 agent 拆出: { intent: "refund", order_id: "o_99812", emotion: "neutral" }
传给退款专员: { intent: "refund", order_id: "o_99812", emotion: "neutral" }
```

如果路由 agent 没传 `order_id`（关键信息丢失），退款专员要重新问用户——影响 turn_efficiency。

Handoff 完整性 scorer：

```ts
export function handoffCompleteness(requiredFields: string[]): Scorer {
  return async (state) => {
    const handoff = state.metadata.handoff;
    const missing = requiredFields.filter((f) => !handoff?.[f]);
    return {
      scorerName: 'handoff_completeness',
      value: missing.length === 0 ? 'C' : 'I',
      explanation: missing.length ? `Handoff 缺字段: ${missing.join(', ')}` : '',
    };
  };
}
```

### 维度 3：协作效率（多 specialist 协作）

复杂场景需要多个专员协作（先物流专员查物流，再退款专员处理退款）。**评测 inter-agent handoff 次数**：

```
任务: 复杂退换货
最少需要 specialists 数: 2（物流 + 退换货）
实际经过 specialists 数: 4（多绕了一次推荐专员，又转到客户经理）
→ efficiency = 2/4 = 50%
```

## 多 Agent 版本 ShopAgent（仓库提供）

`examples/shopagent-extended/multi-agent/` 提供一个简化多 agent ShopAgent。3 个专员：

| Specialist | 职责 | 用什么工具 |
|---|---|---|
| `refund_specialist` | 退款 / 取消 | get_order, refund_order, cancel_order |
| `address_specialist` | 改地址 / 物流 | get_order, update_shipping_address |
| `general_specialist` | FAQ / 备注 / 升级 | search_faq, add_note, escalate_to_human, get_user |

路由 agent 用一个轻量 LLM 调用判定 intent，然后把对话上下文交给对应专员。

```ts
// examples/shopagent-extended/multi-agent/router.ts
const ROUTER_PROMPT = `你是路由 agent。判断下面用户消息属于哪类客服请求：

- refund: 退款 / 取消
- address: 改地址 / 拦截 / 物流
- general: 商品咨询 / 备注 / 升级

用户消息: {input}
对话历史: {history}

输出 JSON: {"route": "refund"|"address"|"general", "confidence": 0-1, "extracted_info": {...}}`;
```

## 多 Agent 评测集

设计 30 条 multi-agent 评测样本，覆盖：

- 单 specialist 任务（10 条，正常路由 + 任务完成）
- 模糊路由（5 条，意图不明显，看 routing 是否合理）
- 跨 specialist 协作（10 条，1 个任务需要 2 个 specialist 协作）
- 错误路由恢复（5 条，路由 agent 一开始路由错了，第二轮纠正）

跑出来（GPT-4o multi-agent 版本）：

```
ShopAgent multi-agent on multi-agent-30:
  routing_accuracy:        24/30 (80%)
  handoff_completeness:    22/30 (73%)
  task_completion:         19/30 (63%)
  cross_specialist_efficiency: P (Partial) = 0.55

vs ShopAgent single-agent on same 30 samples:
  tool_call_match:         27/30 (90%)
  task_completion:         24/30 (80%)
```

**单 agent 在简单 30 条上反而比 multi-agent 强**。这是真实工程现象——multi-agent 引入 handoff 损耗。

## 什么时候 Multi-Agent 才胜出

```
单任务复杂度 < 阈值: 单 agent 完爆 multi-agent（handoff 是负担）
单任务复杂度 > 阈值: multi-agent 胜出（单 agent 上下文管理不过来）

阈值在哪？经验：
- ShopAgent 这种规模（8 工具 + 5 policy）：单 agent 够用
- 真实电商客服（30+ 工具 + 20+ policy + 子领域）：multi-agent 收益明显
- ShopAgent 扩展版（12 工具）+ 富业务：边界场景，需 A/B
```

## 多 Agent 的反模式

### 反模式 1：硬拆专员粒度太细

把"退款"和"取消"硬拆成两个专员——两者业务高度重叠（取消未发货订单 = 退款）。结果是路由 agent 经常在两个之间摇摆，handoff 损耗 > 专员专精收益。

正确：相关功能聚到一个专员里。

### 反模式 2：路由 agent 自己跑业务逻辑

路由 agent 设计本意是"判 intent + 转交"，但工程师常常给路由 agent 也加工具调用、policy 检查。**结果是路由 agent 变成大型 monolith，跟单 agent 没区别但多了 handoff 开销**。

正确：路由 agent 严格只做 intent 判定，业务逻辑全部在专员里。

### 反模式 3：评测脚本只跑 happy path

模糊路由 / 错误路由恢复的 case 没在评测集，结果 routing_accuracy 看着 95% 但生产里挂得鸡犬不宁。

正确：评测集必须有"模糊 intent" "intent 切换" "纠错" 三类场景。

## 多 Agent 评测的 Frameworks

业界做多 agent 评测的工具：

- [AutoGen Studio](https://microsoft.github.io/autogen/) eval：Microsoft 出的多 agent 框架自带 eval 模块
- [CrewAI eval](https://docs.crewai.com/concepts/evaluation)：CrewAI 出的多 agent 框架
- [τ²-bench dual-control](https://github.com/sierra-research/tau2-bench)：用户和 agent 都能调工具的对偶评测

EvalKit 不内置 multi-agent eval——主线场景是单 agent。但 EvalKit 的 scorer 接口能直接接住 multi-agent 评测，加几个 scorer 即可（routing_accuracy / handoff_completeness 等）。

## 本附录要点回顾

- **单 agent vs 多 agent 评测的差异**：多 agent 需要评测路由准确率、跨 agent 上下文传递、整体 task completion
- **路由 scorer**：评测"用户请求应该路由到哪个 agent"是否正确，独立于子 agent 性能
- **多 agent 系统的反直觉发现**：单 agent + 工具丰富 通常优于 多 agent + 工具拆分。多 agent 引入路由噪声和上下文丢失
- **何时真的需要多 agent**：业务领域差异大（客服 vs 销售 vs 技术支持）+ 不同 agent 需要不同 prompt/工具/数据时
- **生产建议**：默认从单 agent 起步，路由准确率 < 80% 时再考虑多 agent；多 agent 上线后必须监控端到端 task completion

## 第 B 总结

多 agent 评测多 3 个维度：路由正确性 / handoff 完整性 / 协作效率。简单 30 条评测集 + 3 个新 scorer 能 cover 大多数 case。

**重要心智**：multi-agent 不是越复杂越好。ShopAgent 主线用单 agent 是有意的——大多数应用层场景单 agent + 良好 prompt 就够。multi-agent 是当业务复杂度真正撑不住单 agent 时再上的。

读者真要做 multi-agent 评测：在 ShopAgent 规模下，单 agent 够用；真正上 multi-agent 前先把本附录三个 scorer（routing_accuracy / handoff_completeness / overall_task_completion）跑通，看数据再决定。**单 agent 80% vs multi-agent 90% 这种数字差距，如果不配套的评测维度跑过，是看不出来的**——先建评测，再决定架构。

---

> 本章来自《AI Agent 评测工程实战》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev) · 反馈与勘误：[GitHub Issues](https://github.com/diguike/book-agent-evals/issues)
