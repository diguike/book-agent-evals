// solver 链式组合 —— 中间件式串联
// 对照 inspect_ai: src/inspect_ai/solver/_chain.py
import type { Solver } from '../types.js';

export function chain(...solvers: Solver[]): Solver {
  return async (state, generate) => {
    let current = state;
    for (const solver of solvers) {
      current = await solver(current, generate);
      if (current.completed) break;
    }
    return current;
  };
}
