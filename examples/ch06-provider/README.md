# ch06-provider

第 6 章配套 demo —— Provider 抽象：并发 + cache + retry 的实战。

```bash
# 默认并发=4，cache 开
npm run eval

# 关 cache 对比耗时
NO_CACHE=1 npm run eval

# 高并发
CONCURRENCY=8 npm run eval

# 换 provider
MODEL=deepseek-chat npm run eval
MODEL=qwen-plus npm run eval
```
