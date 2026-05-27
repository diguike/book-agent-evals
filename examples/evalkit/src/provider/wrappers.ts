// 函数式 wrapper —— 给 ch06 正文用的 openaiProvider / withCache / withRetry 函数式 API
// 实际生产建议直接用 ProviderRouter（统一调度 + 自动选 provider），这里保留是为了正文示例能 import 成功
import type { Provider, ProviderRequest, ProviderResponse } from './types.js';
import { OpenAIProvider } from './openai.js';
import { FileCache, type CacheOptions } from './cache.js';
import { retry, type RetryOptions } from './retry.js';

interface OpenAIProviderOpts {
  apiKey?: string;
  baseURL?: string;
  name?: string;
  modelPrefixes?: string[];
}

/** 工厂函数：包一层让正文里的 `openaiProvider({...})` 写法能跑 */
export function openaiProvider(opts: OpenAIProviderOpts = {}): Provider {
  return new OpenAIProvider(opts);
}

/** wrapper：让任何 Provider 装上文件 cache */
export function withCache(provider: Provider, opts: CacheOptions = {}): Provider {
  const cache = new FileCache(opts);
  return {
    name: `${provider.name}+cache`,
    supports: (model: string) => provider.supports(model),
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      const hit = cache.get(req);
      if (hit) return hit;
      const resp = await provider.complete(req);
      cache.set(req, resp);
      return resp;
    },
  };
}

/** wrapper：让任何 Provider 装上指数回退 retry */
export function withRetry(provider: Provider, opts: RetryOptions = {}): Provider {
  return {
    name: `${provider.name}+retry`,
    supports: (model: string) => provider.supports(model),
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      return retry(() => provider.complete(req), opts);
    },
  };
}
