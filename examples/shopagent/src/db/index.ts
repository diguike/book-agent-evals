// 兼容层 —— 把原内存 DB 的 API 重导出为 SQLite 版本
// 这样 tools/impl.ts 不用改一行代码

export {
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
  getDb,
  resetDb,
} from './sqlite.js';

export type { Order, User, FaqEntry, DbSnapshot } from './sqlite.js';
