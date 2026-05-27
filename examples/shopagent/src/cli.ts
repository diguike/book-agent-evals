// 极简 REPL：方便手工跑一下确认 agent 能接住输入
// 用法：cd examples/shopagent && npm run dev
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { runShopAgent } from './agent.js';
import type { ChatMessage } from './types.js';

async function main(): Promise<void> {
  const model = process.env.MODEL ?? 'gpt-4o';
  if (!process.env.OPENAI_API_KEY) {
    console.error('[shopagent] 缺少 OPENAI_API_KEY，请在仓库根 .env 配置后重试');
    process.exit(1);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  console.log(`[shopagent] 已启动（模型 ${model}），输入消息开始对话，Ctrl+C 退出\n`);

  let history: ChatMessage[] | undefined = undefined;

  while (true) {
    const userInput = (await rl.question('你> ')).trim();
    if (!userInput) continue;
    if (userInput === '/exit' || userInput === '/quit') {
      rl.close();
      break;
    }
    if (userInput === '/reset') {
      history = undefined;
      console.log('[shopagent] 历史已清空\n');
      continue;
    }

    const t0 = Date.now();
    const result = await runShopAgent({
      user_input: userInput,
      history,
      model,
    });
    const elapsed = Date.now() - t0;

    for (const tc of result.tool_calls) {
      console.log(`  [tool] ${tc.tool}(${JSON.stringify(tc.args)})`);
    }
    console.log(`agent> ${result.response}`);
    console.log(`  (steps=${result.steps}, ${elapsed}ms, tools=${result.tool_calls.length})\n`);

    history = result.messages;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
