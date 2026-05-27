// @inferloop/shopagent-extended —— 12 工具版（附录 D 用）
export { runExtendedShopAgent } from './agent.js';
export { extraTools } from './tools/extra.js';
export { executeExtraTool } from './tools/extra_impl.js';
export { EXTENDED_SYSTEM_PROMPT } from './prompt.js';

// 合并的 tools 列表
import { shopAgentTools } from '@inferloop/shopagent';
import { extraTools } from './tools/extra.js';
export const allShopAgentTools = [...shopAgentTools, ...extraTools];
