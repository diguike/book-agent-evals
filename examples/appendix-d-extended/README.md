# appendix-d-extended

附录 D 配套 demo —— 跑 ShopAgent 扩展版（12 工具 + 8 policy）。

```bash
cd ../shopagent && npm run seed && cd -
npm run eval
```

跟主线对比：扩展版 trajectory 更长（list_orders + track_shipment 等多步），适合演示更复杂的 trajectory eval。
