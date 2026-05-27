# @inferloop/shopagent

全书贯穿的被评测样本。**这不是一本 Agent 开发书，ShopAgent 是已经写好的"被评测对象"**——内部实现不在书中展开，仅作为评测目标。

## 工具集（主线 8 工具）

| 类别 | 工具 | 说明 |
|---|---|---|
| 只读 | `get_order` | 查订单详情 |
| 只读 | `get_user` | 查用户资料 |
| 只读 | `search_faq` | 在 FAQ 知识库里搜 |
| 不可逆 | `refund_order` | 给订单退款 |
| 不可逆 | `update_shipping_address` | 改收货地址 |
| 不可逆 | `cancel_order` | 取消订单 |
| 软操作 | `escalate_to_human` | 升级到人工 |
| 软操作 | `add_note` | 给订单加备注 |

## 5 条 policy

1. 写操作前必须先 `get_order`
2. 已发货订单不能改地址
3. 退款金额 ≤ 订单金额
4. 不可逆操作前必须二次确认
5. 不能透露其他用户隐私

## 跑

```bash
# 启 CLI 跟 agent 对话
cd examples/shopagent
npm run dev

# 重建 mock DB
npm run seed
```

需要 `OPENAI_API_KEY`（在仓库根的 `.env`）。

## 扩展版

12 工具 + 8 policy 的进阶版在 `examples/shopagent-extended/`，仅供附录 D 引用，主线章节不使用。
