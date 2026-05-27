// Provider 路由 —— 根据 model 名字派发到对应 provider，带 cache + retry
import type { Provider, ProviderRequest, ProviderResponse } from './types.js';
import { FileCache, type CacheOptions } from './cache.js';
import { retry, type RetryOptions } from './retry.js';
import { OpenAIProvider, deepseekProvider, qwenProvider, zhipuProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';

export interface RouterOptions {
  providers?: Provider[];
  cache?: CacheOptions;
  retry?: RetryOptions;
}

/** 内置默认 provider 列表 */
export function defaultProviders(): Provider[] {
  return [
    new OpenAIProvider(),
    new AnthropicProvider(),
    deepseekProvider(),
    qwenProvider(),
    zhipuProvider(),
  ];
}

export class ProviderRouter {
  private providers: Provider[];
  private cache: FileCache;
  private retryOpts: RetryOptions;

  constructor(opts: RouterOptions = {}) {
    this.providers = opts.providers ?? defaultProviders();
    this.cache = new FileCache(opts.cache);
    this.retryOpts = opts.retry ?? {};
  }

  pickProvider(model: string): Provider {
    const p = this.providers.find((pp) => pp.supports(model));
    if (!p) {
      throw new Error(`没有 provider 支持 model="${model}"。已注册：${this.providers.map((pp) => pp.name).join(', ')}`);
    }
    return p;
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const cached = this.cache.get(req);
    if (cached) return cached;
    const provider = this.pickProvider(req.model);
    const resp = await retry(() => provider.complete(req), this.retryOpts);
    this.cache.set(req, resp);
    return resp;
  }
}

/** 进程级默认 router（懒初始化） */
let defaultRouter: ProviderRouter | null = null;
export function getDefaultRouter(): ProviderRouter {
  if (!defaultRouter) defaultRouter = new ProviderRouter();
  return defaultRouter;
}

/** 测试 / 注入用：替换默认 router */
export function setDefaultRouter(r: ProviderRouter): void {
  defaultRouter = r;
}
