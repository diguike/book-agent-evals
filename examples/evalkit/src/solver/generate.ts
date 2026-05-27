// generate solver —— ch06 起：真实 LLM 调用，走 Provider Router（含 cache + retry）
// 用法：
//   - 单步生成：generate({ toolCalls: 'none' })
//   - 工具循环：generate({ toolCalls: 'loop', maxSteps: 8 })
// 真实工程经常把整个 agent loop 包成一个 Solver（参见 book/03 末尾），这种情况 generate 不会被调用
import type { GenerateFn, GenerateOpts, Solver, TaskState } from '../types.js';
import type { ToolDef } from './use_tools.js';
import { getDefaultRouter, type ProviderRouter } from '../provider/router.js';

/** 把 sample.input 注入 messages（仅一次） */
function ensureUserMessage(state: TaskState): TaskState {
  const input = state.sample.input;
  const alreadyInjected = state.metadata['_evalkit:user_message_injected'] === true;
  if (alreadyInjected) return state;

  if (Array.isArray(input)) {
    state.messages.push(...input);
  } else if (typeof input === 'string' && input.length > 0) {
    state.messages.push({ role: 'user', content: input });
  }
  state.metadata['_evalkit:user_message_injected'] = true;
  return state;
}

export function generate(opts: GenerateOpts = {}): Solver {
  return async (state, generateFn) => {
    state = ensureUserMessage(state);
    return generateFn(state, opts);
  };
}

interface DefaultGenerateOpts {
  /** 注入 Provider Router；不传走全局默认 */
  router?: ProviderRouter;
  /** 工具调用循环上限 */
  maxSteps?: number;
}

/** 默认 GenerateFn —— 调真实 Provider Router 完成"调模型 + 工具循环" */
export function defaultGenerate(
  model: string,
  taskConfig?: { temperature?: number; maxTokens?: number },
  opts: DefaultGenerateOpts = {},
): GenerateFn {
  const router = opts.router ?? getDefaultRouter();
  const maxStepsCap = opts.maxSteps ?? 8;

  return async (state, generateOpts) => {
    const policy = generateOpts?.toolCalls ?? 'loop';
    const temperature = generateOpts?.temperature ?? taskConfig?.temperature ?? 0;
    const tools = (state.metadata.tools as ToolDef[] | undefined) ?? undefined;
    const useTools = policy !== 'none' && tools && tools.length > 0;

    let steps = 0;
    let finalContent = '';

    while (steps < maxStepsCap) {
      steps += 1;
      const reqExtras: Record<string, unknown> = {};
      if (taskConfig?.maxTokens !== undefined) reqExtras.maxTokens = taskConfig.maxTokens;
      const resp = await router.complete({
        model,
        messages: state.messages,
        ...(useTools ? { tools } : {}),
        temperature,
        ...reqExtras,
      });

      state.messages.push({
        role: 'assistant',
        content: resp.content,
        ...(resp.tool_calls && resp.tool_calls.length > 0 ? { tool_calls: resp.tool_calls } : {}),
      });

      // 没有工具调用 → 结束
      if (!resp.tool_calls || resp.tool_calls.length === 0) {
        finalContent = resp.content;
        break;
      }

      // 调用方应该在 state.metadata 里放一个 toolExecutor —— 真实评测里 agent
      // 框架（Vercel AI SDK / 自己实现）会自己处理工具调用循环，generate 不会跑到这里
      const executor = state.metadata.toolExecutor as
        | ((name: string, args: Record<string, unknown>) => Promise<unknown> | unknown)
        | undefined;

      for (const tc of resp.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          // 忽略 parse 错
        }
        let result: unknown;
        if (executor) {
          try {
            result = await executor(tc.function.name, args);
          } catch (err) {
            result = { error: 'tool_execution_failed', message: (err as Error).message };
          }
        } else {
          result = { error: 'no_tool_executor', tool: tc.function.name };
        }
        state.toolCalls.push({ tool: tc.function.name, args, result });
        state.messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }

      if (policy === 'single') break;
    }

    state.output = {
      completion: finalContent,
      steps,
    };
    return state;
  };
}
