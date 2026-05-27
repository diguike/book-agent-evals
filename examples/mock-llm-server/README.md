# mock-llm-server

把 Claude Code Max 配额包装成 OpenAI 兼容 API。让评测脚本免 API key 也能跑。

**这是个教学/验证工具，不是生产级 LLM proxy**。它走的是 `claude -p` 子进程，每次调用 3-15 秒延迟，跑 200 条样本评测要十几分钟。

## 工作原理

```
评测脚本 (OPENAI_BASE_URL=http://localhost:3030/v1)
   ↓ POST /v1/chat/completions { messages, tools, ... }
mock-llm-server (Node http)
   ↓ 把 messages + tools 拍成 (system, user) 纯文本
   ↓ 在 system 末尾告诉 Claude："要调工具就输出 <tool_call>{...}</tool_call>"
spawn('claude', ['-p', '--output-format=json', '--model', 'sonnet', '--system-prompt', system])
   ↓ stdin: user
   ↓ stdout: { result: "...", usage: ... }
mock-llm-server
   ↓ 解析 result 中的 <tool_call> 块 → 转成 OpenAI tool_calls
   ↓ 包装成 OpenAI ChatCompletion 响应
评测脚本拿到响应，照常处理 tool_calls
```

## 启动

```bash
cd examples/mock-llm-server
npm install          # 在仓库根装好就行，这步可跳
npm run start        # 默认 :3030
```

输出：

```
[mock-llm-server] listening on http://localhost:3030
[mock-llm-server] backend: claude -p (OAuth, Max plan)
[mock-llm-server] 评测脚本：OPENAI_BASE_URL=http://localhost:3030/v1
```

调试日志开启：

```bash
VERBOSE=1 npm run start
```

换端口：

```bash
PORT=4000 npm run start
```

## 接评测脚本

在仓库根的 `.env`：

```bash
OPENAI_API_KEY=mock-any-key-works
OPENAI_BASE_URL=http://localhost:3030/v1
MODEL=gpt-4o
```

然后任何 ch* demo 都能跑：

```bash
cd examples/ch02-hello-world && npm run eval
```

mock server 内部把模型名映射成 Claude：

| OpenAI 名 | 实际跑的 Claude 模型 |
|---|---|
| `gpt-4o` / `gpt-4*` | sonnet |
| `gpt-4o-mini` / 含 mini | haiku |
| `o1` / `o3` | opus |
| `sonnet` / `haiku` / `opus` | 同名 |
| 其他 (deepseek / qwen / glm 等) | sonnet 兜底 |

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI 兼容主接口 |
| GET | `/v1/models` | 返回支持的模型列表 |
| GET | `/stats` | 看最近请求统计 + 错误 |
| GET | `/` | 服务自描述 |

## 工具调用协议（关键设计）

OpenAI SDK 用 `tool_calls` 字段返回结构化工具调用；Claude `claude -p` 输出纯文本。中间靠这个协议桥接：

**system prompt 里告诉 Claude**：
```
要调工具就这么输出：
<tool_call>
{"name": "工具名", "arguments": {...}}
</tool_call>
```

**mock server 解析回包**：
- 用正则提取所有 `<tool_call>...</tool_call>` 块
- 每块解析 JSON → 转成 OpenAI `tool_calls` 元素
- 剩下的纯文本作为 `content`

约束：
- Claude 偶尔会输出 ` ```json` 代码块包裹 tool_call，protocol.ts 里有兜底
- Claude 偶尔会忘记调工具直接给文字答案，这种情况评测会判负，跟真实模型行为一致
- 多个 tool_call 块串联也支持

## 限制

1. **不支持 streaming**（评测不需要）
2. **延迟高**：每次 spawn 一个 claude 进程，3-15 秒/请求。并发 4-8 比并发 16 实际更稳
3. **token 消耗**：claude -p 即使带 --system-prompt 覆盖，每次仍有 ~3-5K cache creation tokens。跑 200 条 L1 + 100 条 L2 大约消耗 100-200K tokens。Max plan 完全够
4. **不是真实 GPT 行为**：跑出来的 pass^k 是"Claude 在评测集上的表现"，不是 GPT。**正文里写"实测"数字时要注明 "via mock"**

## 健康检查

```bash
# 服务是否起来
curl http://localhost:3030/

# 简单 ping
curl -X POST http://localhost:3030/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"haiku","messages":[{"role":"user","content":"reply exactly PING"}]}'

# 看统计
curl http://localhost:3030/stats | python3 -m json.tool
```

## 限制场景示例

跑一个 ShopAgent ch02 demo：

```bash
# 终端 1
cd examples/mock-llm-server && npm run start

# 终端 2
cd examples/ch02-hello-world
export OPENAI_API_KEY=mock OPENAI_BASE_URL=http://localhost:3030/v1
npm run eval
```

预期：10 条样本约 30-90 秒（取决于 sonnet/haiku），最终输出 `pass^1 = 0.xxx`。
