// Provider 注册表 —— ch06 正文用的 registry 模式
// 实际生产推荐用 ProviderRouter（更灵活，按 provider.supports() 派发）
// 这里保留为按名字注册的简单版，供正文示例使用
import type { Provider } from './types.js';
import { openaiProvider } from './wrappers.js';

export const providerRegistry = new Map<string, () => Provider>([
  ['openai', () => openaiProvider()],
  [
    'deepseek',
    () =>
      openaiProvider({
        name: 'deepseek',
        apiKey: process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY,
        baseURL: 'https://api.deepseek.com/v1',
        modelPrefixes: ['deepseek-'],
      }),
  ],
  [
    'qwen',
    () =>
      openaiProvider({
        name: 'qwen',
        apiKey: process.env.DASHSCOPE_API_KEY ?? process.env.OPENAI_API_KEY,
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        modelPrefixes: ['qwen-', 'qwen2-', 'qwen3-'],
      }),
  ],
  [
    'zhipu',
    () =>
      openaiProvider({
        name: 'zhipu',
        apiKey: process.env.ZHIPU_API_KEY ?? process.env.OPENAI_API_KEY,
        baseURL: 'https://open.bigmodel.cn/api/paas/v4',
        modelPrefixes: ['glm-'],
      }),
  ],
]);

export function getProviderByName(name: string): Provider | undefined {
  const factory = providerRegistry.get(name);
  return factory?.();
}
