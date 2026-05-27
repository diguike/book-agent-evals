// claude_bridge —— spawn `claude -p` 跑一次推理
// 重要：靠 OAuth 凭证（Claude Max 配额）走，不传 ANTHROPIC_API_KEY
// 通过 stdin 喂 prompt，避免命令行长度上限
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeCliResult } from './types.js';

// 用一个干净的临时目录跑 claude，避免它读到 book-agent-evals 的 CLAUDE.md
// 进程级缓存（每次 spawn 都在同一个隔离目录里）
let isolatedCwd: string | null = null;
function getIsolatedCwd(): string {
  if (!isolatedCwd) {
    isolatedCwd = mkdtempSync(join(tmpdir(), 'mock-llm-claude-'));
  }
  return isolatedCwd;
}

export interface ClaudeBridgeOpts {
  /** sonnet / opus / haiku / 全名 */
  model: string;
  /** 完整 system prompt（覆盖默认 CC system，显著减少 token） */
  systemPrompt: string;
  /** 用户消息（多轮时把整个对话历史平铺成 text） */
  userMessage: string;
  /** 单次 claude 调用超时（默认 120 秒） */
  timeoutMs?: number;
}

export async function callClaude(opts: ClaudeBridgeOpts): Promise<{
  text: string;
  raw: ClaudeCliResult;
  durationMs: number;
}> {
  const t0 = Date.now();
  const args = [
    '-p',
    '--output-format',
    'json',
    '--model',
    opts.model,
    '--system-prompt',
    opts.systemPrompt,
    '--dangerously-skip-permissions',
    // --exclude-dynamic-system-prompt-sections 把 cwd/git/env info 从 system 里去掉
    '--exclude-dynamic-system-prompt-sections',
    // 把所有 Claude Code 内置工具禁掉，避免它"以为自己能直接用"
    '--disallowedTools',
    'Bash,Edit,Read,Write,Glob,Grep,Agent,WebFetch,WebSearch,NotebookEdit,SlashCommand,TodoWrite',
    // 关掉 skill 自动发现
    '--disable-slash-commands',
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: getIsolatedCwd(), // 隔离 cwd，避免读到 book 的 CLAUDE.md
      env: {
        ...process.env,
        // 让 claude 不自动发现项目上下文
        CLAUDE_CODE_DISABLE_PROJECT_MEMORY: '1',
        CLAUDE_PROJECT_DIR: getIsolatedCwd(),
      },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    const timeout = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, opts.timeoutMs ?? 120_000);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`spawn claude 失败：${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (killed) {
        reject(new Error(`claude 超时被 kill（${opts.timeoutMs ?? 120_000}ms）`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`claude exit ${code}\nstderr:\n${stderr}\nstdout:\n${stdout.slice(0, 500)}`));
        return;
      }
      let parsed: ClaudeCliResult;
      try {
        parsed = JSON.parse(stdout.trim()) as ClaudeCliResult;
      } catch (err) {
        reject(new Error(`解析 claude JSON 输出失败：${(err as Error).message}\n原始输出：${stdout.slice(0, 500)}`));
        return;
      }
      if (parsed.is_error) {
        reject(new Error(`claude 报错：${parsed.result}`));
        return;
      }
      resolve({
        text: parsed.result,
        raw: parsed,
        durationMs: Date.now() - t0,
      });
    });

    // 通过 stdin 写入 user message，避免 args 太长
    proc.stdin.write(opts.userMessage);
    proc.stdin.end();
  });
}

/** model 名字归一化：把 OpenAI 名字映射到 Claude 名字 */
export function normalizeModel(input: string): string {
  const lower = input.toLowerCase();
  // OpenAI 名 → Claude 名 的猜测映射（教学场景用，不严谨）
  if (lower.startsWith('gpt-4o-mini') || lower.includes('mini')) return 'haiku';
  if (lower.startsWith('gpt-4o') || lower.startsWith('gpt-4')) return 'sonnet';
  if (lower.startsWith('o1') || lower.startsWith('o3')) return 'opus';
  if (lower.startsWith('claude-')) return input; // 直接用
  if (['haiku', 'sonnet', 'opus'].includes(lower)) return lower;
  // deepseek / qwen / glm 等 → 用 sonnet 兜底
  return 'sonnet';
}
