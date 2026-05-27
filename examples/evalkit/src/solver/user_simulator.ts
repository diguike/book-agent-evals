// userSimulator solver —— ch09 引入
// 多轮评测时，"用户"也由 LLM 模拟：模拟器拿 sample.metadata.persona + 上一轮 agent 回复，生成下一轮 user 消息
//
// 接口设计原则（ch09 修订重点）：模拟器只接受 lastAgentMessage，不接收整个对话历史
// 理由：(1) 真用户也只看最新回复（不会回去翻自己说过什么）(2) 减少 token 消耗 (3) 让模拟器更鲁棒
//
// 触发结束：模拟器输出包含 "<END>" 或者 turn 数达上限
import type { Solver } from '../types.js';
import type { ProviderRouter } from '../provider/router.js';
import { getDefaultRouter } from '../provider/router.js';

export interface UserSimulatorOpts {
  /** 模拟器用什么模型（通常用比 agent 更弱的模型节省成本） */
  model: string;
  /** 最大轮数 */
  maxTurns?: number;
  /** 自定义 system prompt（覆盖默认） */
  systemPrompt?: string;
  router?: ProviderRouter;
  /** 调用方需要传"agent 怎么跑一轮"的回调；输入 user 消息，输出 agent 回复 */
  runAgentTurn: (userMessage: string) => Promise<{ agentReply: string; toolCalls?: { tool: string; args: Record<string, unknown> }[] }>;
}

const DEFAULT_SYSTEM_PROMPT = `你在模拟一个真实的电商客服用户。
- 你的目标和身份会通过对话内容透露给你
- 用口语化的中文回复，简短，每次只表达一件事
- 不要透露你是 AI 模拟器
- 如果你的目标已经达成（agent 给出了你想要的结果），回复 "<END>"
- 如果 agent 反复绕圈子超过 3 轮，也回复 "<END>"`;

export function userSimulator(opts: UserSimulatorOpts): Solver {
  const router = opts.router ?? getDefaultRouter();
  const maxTurns = opts.maxTurns ?? 8;
  const sysPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  return async (state) => {
    // 第一轮 user 消息从 sample.input 取
    let userMessage = typeof state.sample.input === 'string' ? state.sample.input : '';
    const persona =
      (state.sample.metadata?.persona as string | undefined) ?? '一个普通用户';

    state.metadata.simulatedTurns = [];
    const turns: { user: string; agent: string }[] = [];

    let turn = 0;
    while (turn < maxTurns) {
      turn += 1;

      // 1. agent 跑一轮
      const agentRes = await opts.runAgentTurn(userMessage);
      const agentReply = agentRes.agentReply;
      turns.push({ user: userMessage, agent: agentReply });
      state.messages.push({ role: 'user', content: userMessage });
      state.messages.push({ role: 'assistant', content: agentReply });
      if (agentRes.toolCalls) {
        for (const tc of agentRes.toolCalls) {
          state.toolCalls.push({ tool: tc.tool, args: tc.args });
        }
      }

      // 2. 模拟器决定要不要继续：只看 lastAgentMessage（ch09 修订点）
      const simResp = await router.complete({
        model: opts.model,
        temperature: 0.3,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: `你是：${persona}\n\nagent 刚才说：${agentReply}\n\n你接下来要说什么？（如果对话结束，输出 <END>）` },
        ],
      });
      const next = simResp.content.trim();
      if (next.includes('<END>') || next.length === 0) break;
      userMessage = next;
    }

    state.metadata.simulatedTurns = turns;
    state.output = {
      completion: turns[turns.length - 1]?.agent ?? '',
      steps: turn,
    };
    return state;
  };
}
