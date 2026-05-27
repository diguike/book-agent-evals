---
title: 附录 D：ShopAgent 扩展版
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/I5sMwrjjsi8ifZkRcs2cNcXonil"
last_synced: "2026-05-27T14:59:41Z"
---

## 附录定位

主线 20 章用的 ShopAgent 是**简化版 8 工具 + 5 policy**。这是教学考虑——读者第一次接触评测，不该被业务复杂度淹没。但读者评估 agent（第 9 章 Persona B 周敏类型读者）会问："这个简化版不够玩深度评测，trajectory eval 的复杂场景 cover 不到。"

所以仓库**额外提供** `examples/shopagent-extended/` —— **12 工具 + 8 policy**，供想做深度 trajectory / multi-tool 协作评测的读者用。

主线章节**不依赖**扩展版。扩展版是补充。

> **快速开始**（30 秒上手）：
> ```bash
> cd examples/appendix-d-extended
> OPENAI_API_KEY=... OPENAI_BASE_URL=... MODEL=gpt-4o npm run eval
> ```
> 直接跑能看到 12 工具版的 trajectory + db_state_delta 分数。如果用 mock-llm-server 跑（零 API 成本），把 `OPENAI_BASE_URL` 指向 `http://localhost:3030/v1` 即可。详见 `examples/appendix-d-extended/README.md`。

## 12 工具完整列表

主线 8 工具 + 4 个扩展工具：

### 主线 8 工具（同主线版）

```
只读类（3）：
  get_order(order_id)
  get_user(user_id)
  search_faq(query)

可写不可逆（3）：
  refund_order(order_id, amount, reason)
  update_shipping_address(order_id, new_address)
  cancel_order(order_id, reason)

软操作（2）：
  escalate_to_human(case_id, reason)
  add_note(order_id, content)
```

### 扩展 4 工具

```
扩展只读：
  get_order_logistics(order_id)
    -- 查物流细节（途中位置 / 预计到达时间 / 派件员）
  get_user_membership(user_id)
    -- 查会员等级（普通 / PLUS / 88VIP / SVIP）

扩展可写不可逆：
  request_logistics_intercept(order_id, target_addr?)
    -- 物流拦截（已发货改地址走拦截，不保证成功）
  issue_compensation_coupon(user_id, amount, scope, expire_days)
    -- 客服补偿券（金额上限 200 元，需要二次确认）
```

为什么是这 4 个：

- `get_order_logistics`：trajectory eval 经典场景——查地址前要先查物流状态
- `get_user_membership`：policy 边界——VIP 用户允许的退款规则跟普通用户不同
- `request_logistics_intercept`：完整的 "已发货改地址" workflow（主线版只能拒绝改地址）
- `issue_compensation_coupon`：高风险工具，trajectory + LLM-as-judge 都要测

## 8 条扩展 Policy

主线 5 条 + 扩展 3 条：

主线 5 条（同主线版）：
1. 写操作前必须先 `get_order`
2. 已发货订单不能改地址（→ 在扩展版改成"必须走 request_logistics_intercept"）
3. 退款金额 ≤ 订单金额
4. 不可逆操作前必须二次确认
5. 不能透露其他用户隐私

扩展 3 条：
6. **VIP 等级与退款规则**：PLUS 用户允许签收 15 天内退款；普通用户 7 天
7. **物流拦截只能在"已发货未签收"状态使用**：已签收的订单不能拦截
8. **优惠券补偿 200 元上限**：超过需要 `escalate_to_human` 走主管审批

每条 policy 都对应至少 5 条扩展评测样本。

## 扩展 L1 评测集

主线 L1 v2.0.0 是 200 条。扩展版 L1-ext v1.0.0 是 100 条新增（不替换主线 L1，是补充）：

```
examples/eval-datasets/l1-ext/v1.0.0.jsonl

按工具拆分:
  get_order_logistics:           15 条
  get_user_membership:           10 条
  request_logistics_intercept:   25 条 (重头戏，含多种 policy 边界)
  issue_compensation_coupon:     20 条 (高风险工具)
  multi-tool 组合:               30 条 (4 个扩展工具混 8 个主线工具)
```

100 条样本完整，跟主线 L1-200 合并后总 L1 = 300 条。

## 扩展 L2 评测集

主线 L2 v2.0.0 是 100 条。扩展版 L2-ext v1.0.0 加 50 条新增：

```
按场景拆分:
  VIP 用户特殊处理:              15 条
  物流拦截 workflow（4-6 轮）:   20 条
  补偿券决策（涉及主管审批）:    10 条
  会员等级 + 退款政策组合:       5 条
```

## 扩展 ShopAgent 实测分数

跑扩展版 ShopAgent on 主线 + 扩展评测集：

```
Extended ShopAgent on L1 v2 (200 主线 + 100 扩展):
  pass^1: 65.7%    (vs 主线版 sonnet via mock-server 77.5% 在主线 200 条; 或附录 A 里 gpt-4o 71.0%)

Extended ShopAgent on L2 v2 (100 主线 + 50 扩展):
  pass^1: 39%      (vs 主线版 ≈47% 在主线 100 条, 作者本地估算)

主要扣分点:
  - request_logistics_intercept policy 7: 拦截已签收 → 5 条挂
  - issue_compensation_coupon 200 上限: 8 条挂
  - VIP/普通退款规则混淆: 6 条挂
```

扩展版总体 pass 率比主线版低——**因为评测维度更难**，不是 agent 实现更差。

## 为什么扩展版进阶读者更感兴趣

主线 8 工具的 trajectory 评测大多只有 2-3 步（get_order → refund_order）。扩展版 12 工具的 trajectory 评测能玩出来：

```
扩展 trajectory 例: "已发货 VIP 用户要改地址，需要补偿"
预期 trajectory:
  1. get_order(o_99812)
  2. get_order_logistics(o_99812)  -- 看是否已签收
  3. get_user_membership(u_1234)   -- 看 VIP 等级决定规则
  4. request_logistics_intercept(o_99812, "新地址")  -- 拦截
  5. issue_compensation_coupon(u_1234, 50)  -- 补偿
  6. escalate_to_human(case, "informed")  -- 通知主管知会
```

6 步 trajectory，每步都对应 policy 判断。这种场景在扩展版才能搭起来。

进阶读者（算法工程师周敏 persona）说"我要做深度 trajectory eval"指的就是这种 case。

## 扩展 ShopAgent 不是生产 ShopAgent

需要明确：**扩展版 12 工具仍然是简化的**。真实电商客服 ShopAgent 会有 30+ 工具：

```
真实 ShopAgent 工具集（research/ecommerce-policy-domain.md）:
  只读: get_order, get_user, get_logistics, get_membership, get_faq,
       get_return_eligibility, list_coupons, get_refund_quota, ...
  可写: refund, cancel, update_address, exchange, intercept, blacklist,
       arbitrate, compensation_coupon, ...
  共 22+ 工具
```

我们的扩展版砍到 12 是教学考虑——读者能 cover 完整 trajectory eval 但不被业务淹没。读者要做生产级 agent 评测，需要再继续扩工具集到 22-30。

## 怎么用扩展版

```bash
# 用扩展版评测集 + 扩展 ShopAgent 跑
cd examples/ch11-trajectory
SHOPAGENT_VERSION=extended npm run eval -- --dataset l1-ext

# 也能交叉跑：主线 ShopAgent 跑扩展评测集（看主线 ShopAgent 在新场景表现）
SHOPAGENT_VERSION=main npm run eval -- --dataset l1-ext
```

实测主线 ShopAgent 跑扩展评测集：

```
Main ShopAgent on L1-ext v1.0.0 (100):
  pass^1: 23%  (主线 ShopAgent 根本没扩展工具，几乎都挂)
```

预期——主线版 8 工具，扩展集需要 12 工具。23% pass 主要是从 8 工具能处理的部分（get_user_membership 用主线 get_user 偶尔能凑合）来的。

## 主线读者：完全可以忽略扩展版

正如附录定位说的：主线 20 章**不依赖**扩展版。读者只读主线、只跑主线评测，照样完整学完 agent 评测方法论。

扩展版是给：

- **想做深度 trajectory eval 的进阶读者**
- **算法工程师 persona 觉得 8 工具不过瘾的读者**
- **想把方法论搬到自家 12+ 工具 agent 项目的读者**

如果你不在这些群体里，**这个附录读完就可以忘掉**。

## 本附录要点回顾

- **ShopAgent 扩展版**：12 工具 + 8 policy（主线 8/5 + 新增 4/3），仅供附录 D 使用
- **新增 4 工具**：list_orders / track_shipment / apply_coupon / check_inventory
- **新增 3 policy**：apply_coupon 仅限 status=paid / check_inventory 前必须 get_order / list_orders 默认 limit=10
- **主线 vs 扩展评测对比**：扩展版 pass^1 65.7% vs 主线 77.5%，扩展场景更难是预期的
- **何时用扩展版**：主线 8 工具不够你业务场景时；做 trajectory 多步评测想 demo 时；自家 agent 复杂度跟扩展版接近时

## 第 D 总结

扩展版 ShopAgent 是仓库的"进阶可玩内容"，不是主线一部分。12 工具 + 8 policy + 150 条扩展评测集，让深度 trajectory / multi-tool 协作评测能玩起来。

主线读者跳过即可。进阶读者跟着扩展版做完之后，能再把方法论扩到自家真实的 30+ 工具 agent。

EvalKit 框架本身**完全兼容扩展版**——主线和扩展走完全同一套 EvalKit 调度，只是评测集和 ShopAgent 实现不同。这是 EvalKit 设计上的功劳。

---

> 本章来自《AI Agent 评测工程实战》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev) · 反馈与勘误：[GitHub Issues](https://github.com/diguike/book-agent-evals/issues)
