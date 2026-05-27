// @inferloop/shopagent 公开导出入口

export { runShopAgent } from './agent.js';
export { shopAgentTools, shopAgentToolNames } from './tools/index.js';
export { executeTool } from './tools/impl.js';
export { SYSTEM_PROMPT } from './prompt.js';
// DB 暴露给扩展包 + 评测脚本（ch11 db_state_delta 需要 snapshotDb）
export {
  getDb,
  getDb as getShopAgentDb, // ch11 正文用的名字别名
  resetDb,
  getOrderById,
  getUserById,
  searchFaq,
  applyRefund,
  applyAddressUpdate,
  applyCancel,
  appendNote,
  getNotes,
  recordEscalation,
  snapshotDb,
} from './db/sqlite.js';
export { seed } from './db/seed.js';
export type { Order, User, FaqEntry, DbSnapshot } from './db/sqlite.js';
export type {
  ShopAgentRunInput,
  ShopAgentRunOutput,
  ChatMessage,
  AssistantToolCall,
  ToolCallRecord,
  ToolSchema,
} from './types.js';
