# @inferloop/shopagent-extended

ShopAgent 扩展版（12 工具 + 8 policy），仅供附录 D 使用，主线章节不依赖。

## 比主线多的 4 个工具

| 工具 | 用途 |
|---|---|
| `list_orders` | 列用户订单列表（带状态过滤） |
| `track_shipment` | 物流轨迹查询 |
| `apply_coupon` | 应用优惠券 |
| `check_inventory` | 查 SKU 库存 |

## 比主线多的 3 条 policy

6. `apply_coupon` 仅能用于 status=paid 的订单
7. `check_inventory` 前要先 `get_order` 拿 SKU
8. `list_orders` 默认 limit=10，超过 10 条要主动告知

## 跑

依赖主线 `@inferloop/shopagent`：

```bash
cd /home/ubuntu/workspace/book-agent-evals
npm run build -w @inferloop/shopagent
npm run build -w @inferloop/shopagent-extended
```
