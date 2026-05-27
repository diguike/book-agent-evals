// 注入 system 消息的 solver
import type { Solver } from '../types.js';

export function systemMessage(content: string): Solver {
  return async (state) => {
    // 已经有 system 消息时跳过（防止链式调用时多次注入）
    if (state.messages.some((m) => m.role === 'system')) return state;
    state.messages.unshift({ role: 'system', content });
    return state;
  };
}
