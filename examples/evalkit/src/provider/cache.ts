// 请求级缓存 —— 同样的 (model, messages, tools, temperature) 命中已有响应
// 落盘到 .evalkit-cache/，按 SHA-256 hash 分目录
// 评测时 temperature=0 大量命中，能省 token + 时间
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import type { ProviderRequest, ProviderResponse } from './types.js';

export interface CacheOptions {
  /** 缓存根目录 */
  dir?: string;
  /** 关掉缓存（debug 用） */
  disabled?: boolean;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k])).join(',') + '}';
}

export function cacheKey(req: ProviderRequest): string {
  const h = createHash('sha256');
  h.update(stableStringify(req));
  return h.digest('hex');
}

export class FileCache {
  readonly dir: string;
  readonly disabled: boolean;

  constructor(opts: CacheOptions = {}) {
    this.dir = resolve(opts.dir ?? process.env.EVALKIT_CACHE_DIR ?? '.evalkit-cache');
    this.disabled = opts.disabled ?? process.env.EVALKIT_CACHE === 'off';
  }

  pathFor(key: string): string {
    return join(this.dir, key.slice(0, 2), key.slice(2, 4), key + '.json');
  }

  get(req: ProviderRequest): ProviderResponse | undefined {
    if (this.disabled) return undefined;
    const p = this.pathFor(cacheKey(req));
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, 'utf-8')) as ProviderResponse;
    } catch {
      return undefined;
    }
  }

  set(req: ProviderRequest, resp: ProviderResponse): void {
    if (this.disabled) return;
    const p = this.pathFor(cacheKey(req));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(resp));
  }
}
