// prompt 模板渲染 solver —— 把 sample.input 套到模板里再喂给 agent
// 用 ${var} 语法，从 sample.metadata + sample.input 取值
import type { Solver } from '../types.js';

export function promptTemplate(template: string): Solver {
  return async (state) => {
    const sample = state.sample;
    const ctx: Record<string, unknown> = {
      input: typeof sample.input === 'string' ? sample.input : '[messages]',
      ...(sample.metadata ?? {}),
    };
    const rendered = template.replace(/\$\{(\w+)\}/g, (_match, key: string) => {
      const v = ctx[key];
      return v === undefined ? '' : String(v);
    });
    // 用渲染后的字符串覆盖最近一条 user 消息（或新建一条）
    const lastUserIdx = [...state.messages].reverse().findIndex((m) => m.role === 'user');
    if (lastUserIdx < 0) {
      state.messages.push({ role: 'user', content: rendered });
    } else {
      const realIdx = state.messages.length - 1 - lastUserIdx;
      state.messages[realIdx] = { role: 'user', content: rendered };
    }
    return state;
  };
}
