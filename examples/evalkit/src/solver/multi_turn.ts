// multiTurn solver —— ch10 引入
// 跟 userSimulator 的区别：multi_turn 用预先脚本化的用户消息（sample.metadata.turns）
// 适合"流程类"评测（一定按这个顺序走 N 步），不需要 LLM 模拟器
import type { Solver } from '../types.js';

interface MultiTurnOpts {
  /** 每轮 agent 跑完的回调（由调用方提供） */
  runAgentTurn: (
    userMessage: string,
    history: { user: string; agent: string }[],
  ) => Promise<{
    agentReply: string;
    toolCalls?: { tool: string; args: Record<string, unknown> }[];
  }>;
  /** 早停判断：返回 true 提前结束 */
  shouldStop?: (
    turn: number,
    history: { user: string; agent: string }[],
  ) => boolean;
}

interface ScriptedTurn {
  user: string;
  /** 可选：本轮预期 agent 应该调到的工具 */
  expectedTools?: string[];
}

export function multiTurn(opts: MultiTurnOpts): Solver {
  return async (state) => {
    const scripted =
      (state.sample.metadata?.turns as ScriptedTurn[] | undefined) ?? [];
    if (scripted.length === 0) {
      // 没有脚本，单轮回退
      const input = typeof state.sample.input === 'string' ? state.sample.input : '';
      const r = await opts.runAgentTurn(input, []);
      state.messages.push({ role: 'user', content: input });
      state.messages.push({ role: 'assistant', content: r.agentReply });
      if (r.toolCalls) {
        for (const tc of r.toolCalls) state.toolCalls.push({ tool: tc.tool, args: tc.args });
      }
      state.output = { completion: r.agentReply, steps: 1 };
      return state;
    }

    const history: { user: string; agent: string }[] = [];
    let lastAgentReply = '';
    for (let i = 0; i < scripted.length; i++) {
      const turn = scripted[i]!;
      if (opts.shouldStop && opts.shouldStop(i, history)) break;
      const r = await opts.runAgentTurn(turn.user, history);
      lastAgentReply = r.agentReply;
      history.push({ user: turn.user, agent: r.agentReply });
      state.messages.push({ role: 'user', content: turn.user });
      state.messages.push({ role: 'assistant', content: r.agentReply });
      if (r.toolCalls) {
        for (const tc of r.toolCalls) state.toolCalls.push({ tool: tc.tool, args: tc.args });
      }
    }
    state.metadata.turnHistory = history;
    state.output = { completion: lastAgentReply, steps: history.length };
    return state;
  };
}
