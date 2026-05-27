// 信号量并发池 —— 评测时通常想跑 4-16 个 sample 并行，但要遵守 provider rate limit
// ch19 会扩成"自适应"版本（看到 429 自动降并发）

export class Semaphore {
  private permits: number;
  private waitQueue: (() => void)[] = [];

  constructor(initial: number) {
    this.permits = Math.max(1, initial);
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waitQueue.push(resolve));
  }

  release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.permits += 1;
    }
  }

  /** 当前剩余可用信号量数 */
  get available(): number {
    return this.permits;
  }
}

/** 并行跑 items 上的 fn，但同时最多 concurrency 个在跑 */
export async function pmap<I, O>(
  items: I[],
  concurrency: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const sem = new Semaphore(concurrency);
  const results: O[] = new Array(items.length);
  await Promise.all(
    items.map(async (item, i) => {
      await sem.acquire();
      try {
        results[i] = await fn(item, i);
      } finally {
        sem.release();
      }
    }),
  );
  return results;
}

/** 自适应并发池：看到 429 自动降，连续成功自动升（ch19 用） */
export class AdaptiveSemaphore extends Semaphore {
  private current: number;
  private readonly minPermits: number;
  private readonly maxPermits: number;
  private consecutiveSuccess = 0;
  private readonly successThreshold = 20;

  constructor(initial: number, min = 1, max = 32) {
    super(initial);
    this.current = initial;
    this.minPermits = min;
    this.maxPermits = max;
  }

  /** 调用方在拿到 429 时调，会半折当前上限 */
  notifyRateLimited(): void {
    this.consecutiveSuccess = 0;
    const newLimit = Math.max(this.minPermits, Math.floor(this.current / 2));
    if (newLimit < this.current) {
      this.current = newLimit;
      console.warn(`[evalkit] 命中 rate limit，并发降到 ${this.current}`);
    }
  }

  notifySuccess(): void {
    this.consecutiveSuccess += 1;
    if (
      this.consecutiveSuccess >= this.successThreshold &&
      this.current < this.maxPermits
    ) {
      this.consecutiveSuccess = 0;
      this.current = Math.min(this.maxPermits, this.current + 1);
      console.info(`[evalkit] 连续 ${this.successThreshold} 条成功，并发升到 ${this.current}`);
    }
  }

  get limit(): number {
    return this.current;
  }
}
