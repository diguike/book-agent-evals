// 指数回退重试 —— LLM provider 偶发 429 / 5xx / network 错误时常见
// 默认 5 次：1s / 2s / 4s / 8s / 16s + jitter

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** 哪些错误算可重试 */
  isRetryable?: (err: unknown) => boolean;
}

const DEFAULT_RETRYABLE = (err: unknown): boolean => {
  const e = err as { status?: number; code?: string; message?: string };
  if (typeof e?.status === 'number') {
    return e.status === 429 || (e.status >= 500 && e.status < 600);
  }
  const code = e?.code ?? '';
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)) return true;
  const msg = e?.message ?? '';
  return /rate.?limit|timeout|temporar/i.test(msg);
};

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const initial = opts.initialDelayMs ?? 1000;
  const cap = opts.maxDelayMs ?? 30_000;
  const isRetryable = opts.isRetryable ?? DEFAULT_RETRYABLE;

  let attempt = 0;
  let lastErr: unknown;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      attempt += 1;
      if (attempt >= maxAttempts || !isRetryable(err)) break;
      const base = Math.min(cap, initial * 2 ** (attempt - 1));
      const jitter = Math.random() * base * 0.3;
      const wait = base + jitter;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
