# ch18-data-flywheel

第 18 章配套 demo —— 招牌菜 2：数据飞轮。从 ch17 的评测日志里挖出"边界 case"作为新评测集候选。

```bash
# 先跑 ch17 生成日志
cd ../ch17-dataset-v2 && npm run eval && cd -

# 飞轮反挖
npm run eval
```
