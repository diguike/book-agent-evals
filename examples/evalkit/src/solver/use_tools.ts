// useTools solver —— 把可用工具列表挂进 state.metadata，给后续 generate solver 用
// v1 这一章 generate 是 stub；ch06 真实实现会读 state.metadata.tools
import type { Solver } from '../types.js';

/** 工具定义采用 OpenAI function-calling 兼容格式 */
export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function useTools(tools: ToolDef[]): Solver {
  return async (state) => {
    state.metadata.tools = tools;
    return state;
  };
}
