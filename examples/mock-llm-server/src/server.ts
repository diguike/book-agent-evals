#!/usr/bin/env node
// Mock LLM Server —— OpenAI 兼容 API，后端用 Claude Code CLI 跑（Max 配额）
//
// 启动：
//   npm run start                          # 默认 port 3030
//   PORT=4000 npm run start
//
// 评测脚本配置：
//   .env:
//     OPENAI_BASE_URL=http://localhost:3030/v1
//     OPENAI_API_KEY=mock-any-key            # 任意非空字符串
//     MODEL=gpt-4o                            # 内部自动映射到 sonnet
//
// 限制：
//   1. 不支持 streaming（评测里不用）
//   2. tool 调用走 <tool_call> 文本协议，可能偶发解析失败（重试可救）
//   3. 每次 spawn 进程，启动+model 调用慢于真实 API（3-15s/req），建议低并发
//   4. 当前会消耗 Max 配额，不要在生产上跑大规模评测
//
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { callClaude, normalizeModel } from './claude_bridge.js';
import { openAiToClaudePrompt, parseClaudeResponse } from './protocol.js';
import type { OAIChatRequest, OAIChatResponse } from './types.js';

const PORT = parseInt(process.env.PORT ?? '3030', 10);
const VERBOSE = process.env.VERBOSE === '1';

interface RequestLog {
  ts: number;
  model: string;
  msgCount: number;
  toolCount: number;
  durationMs: number;
  outputLen: number;
  ok: boolean;
  error?: string;
}
const requestLog: RequestLog[] = [];

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function jsonResponse(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function genId(): string {
  return 'chatcmpl-' + Math.random().toString(36).slice(2, 14);
}

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsed: OAIChatRequest;
  try {
    parsed = JSON.parse(body) as OAIChatRequest;
  } catch (err) {
    jsonResponse(res, 400, { error: { message: 'invalid JSON: ' + (err as Error).message, type: 'invalid_request_error' } });
    return;
  }

  if (parsed.stream) {
    jsonResponse(res, 400, { error: { message: 'mock server 暂不支持 stream=true', type: 'invalid_request_error' } });
    return;
  }

  const logEntry: RequestLog = {
    ts: Date.now(),
    model: parsed.model ?? 'unknown',
    msgCount: parsed.messages?.length ?? 0,
    toolCount: parsed.tools?.length ?? 0,
    durationMs: 0,
    outputLen: 0,
    ok: false,
  };

  try {
    const { system, userText } = openAiToClaudePrompt(parsed.messages ?? [], parsed.tools);
    const model = normalizeModel(parsed.model ?? 'gpt-4o');

    if (VERBOSE) {
      console.log(`[mock] req: model=${parsed.model} → ${model}, msgs=${parsed.messages?.length} tools=${parsed.tools?.length ?? 0}`);
      console.log(`[mock]   system head: ${system.slice(0, 120).replace(/\n/g, ' ')}...`);
      console.log(`[mock]   user head:   ${userText.slice(0, 120).replace(/\n/g, ' ')}...`);
    }

    const t0 = Date.now();
    const claudeResp = await callClaude({
      model,
      systemPrompt: system,
      userMessage: userText,
      timeoutMs: 180_000,
    });
    logEntry.durationMs = Date.now() - t0;
    logEntry.outputLen = claudeResp.text.length;

    const { content, tool_calls } = parseClaudeResponse(claudeResp.text);
    if (VERBOSE) {
      console.log(`[mock]   resp ${logEntry.durationMs}ms: ${tool_calls ? tool_calls.length : 0} tool_calls, content_len=${content?.length ?? 0}`);
    }

    const usage = claudeResp.raw.usage;
    const oaiResp: OAIChatResponse = {
      id: genId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: parsed.model ?? model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
            ...(tool_calls && tool_calls.length > 0 ? { tool_calls } : {}),
          },
          finish_reason: tool_calls && tool_calls.length > 0 ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: usage?.input_tokens ?? 0,
        completion_tokens: usage?.output_tokens ?? 0,
        total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
      },
    };

    logEntry.ok = true;
    jsonResponse(res, 200, oaiResp);
  } catch (err) {
    logEntry.error = (err as Error).message;
    if (VERBOSE) console.error(`[mock] err:`, err);
    jsonResponse(res, 500, {
      error: { message: (err as Error).message, type: 'mock_server_error' },
    });
  } finally {
    requestLog.push(logEntry);
    // 保留最近 100 条
    if (requestLog.length > 100) requestLog.splice(0, requestLog.length - 100);
  }
}

function handleStats(_req: IncomingMessage, res: ServerResponse): void {
  const recent = requestLog.slice(-20);
  const total = requestLog.length;
  const ok = requestLog.filter((r) => r.ok).length;
  const avgMs =
    requestLog.length === 0
      ? 0
      : Math.round(requestLog.reduce((a, b) => a + b.durationMs, 0) / requestLog.length);
  jsonResponse(res, 200, { total, ok, avgMs, recent });
}

function handleModels(_req: IncomingMessage, res: ServerResponse): void {
  // 让 OpenAI 客户端 listModels 之类不报错；返回我们认识的几个名字
  jsonResponse(res, 200, {
    object: 'list',
    data: [
      { id: 'gpt-4o', object: 'model', created: 0, owned_by: 'mock-via-claude-sonnet' },
      { id: 'gpt-4o-mini', object: 'model', created: 0, owned_by: 'mock-via-claude-haiku' },
      { id: 'sonnet', object: 'model', created: 0, owned_by: 'claude' },
      { id: 'haiku', object: 'model', created: 0, owned_by: 'claude' },
      { id: 'opus', object: 'model', created: 0, owned_by: 'claude' },
    ],
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
    void handleChatCompletions(req, res);
    return;
  }
  if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
    handleModels(req, res);
    return;
  }
  if (req.method === 'GET' && path === '/stats') {
    handleStats(req, res);
    return;
  }
  if (req.method === 'GET' && path === '/') {
    jsonResponse(res, 200, {
      service: 'mock-llm-server',
      backend: 'claude-code-cli (Max plan via OAuth)',
      endpoints: ['POST /v1/chat/completions', 'GET /v1/models', 'GET /stats'],
      hint: '评测脚本设 OPENAI_BASE_URL=http://localhost:' + PORT + '/v1 + OPENAI_API_KEY=anything',
    });
    return;
  }
  jsonResponse(res, 404, { error: { message: 'not found: ' + path } });
});

server.listen(PORT, () => {
  console.log(`[mock-llm-server] listening on http://localhost:${PORT}`);
  console.log(`[mock-llm-server] backend: claude -p (OAuth, Max plan)`);
  console.log(`[mock-llm-server] 评测脚本：OPENAI_BASE_URL=http://localhost:${PORT}/v1`);
  console.log(`[mock-llm-server] verbose 日志：VERBOSE=1 npm run start`);
});
