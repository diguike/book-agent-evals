// SQLite 后端 —— 用 Node 内置 node:sqlite（Node 22.5+）
// 不引第三方 native module，避免读者环境装不上
//
// 数据库文件位置：默认 data/shopagent.db（gitignored），seed 脚本一键重建
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedDb: DatabaseSync | null = null;

function dbPath(): string {
  return process.env.SHOPAGENT_DB ?? resolve(__dirname, '../../data/shopagent.db');
}

export function getDb(): DatabaseSync {
  if (cachedDb) return cachedDb;
  const p = dbPath();
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  initSchema(db);
  cachedDb = db;
  return db;
}

export function resetDb(): void {
  if (cachedDb) {
    cachedDb.close();
    cachedDb = null;
  }
}

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      phone_masked TEXT NOT NULL,
      member_level TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skus (
      sku TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price REAL NOT NULL,
      stock INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      total REAL NOT NULL,
      shipping_address TEXT NOT NULL,
      created_at TEXT NOT NULL,
      shipped_at TEXT,
      delivered_at TEXT,
      tracking_no TEXT,
      carrier TEXT,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

    CREATE TABLE IF NOT EXISTS order_items (
      order_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      qty INTEGER NOT NULL,
      price REAL NOT NULL,
      PRIMARY KEY (order_id, sku),
      FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS faq (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      tags TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(order_id)
    );

    CREATE TABLE IF NOT EXISTS escalations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT,
      reason TEXT NOT NULL,
      urgency TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refunds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      amount REAL NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(order_id)
    );
  `);
}

// —— 简单查询 helpers ——

export interface Order {
  order_id: string;
  user_id: string;
  status: string;
  total: number;
  shipping_address: string;
  created_at: string;
  shipped_at: string | null;
  delivered_at: string | null;
  tracking_no: string | null;
  carrier: string | null;
  items: { sku: string; name: string; qty: number; price: number }[];
}

export interface User {
  user_id: string;
  nickname: string;
  phone_masked: string;
  member_level: string;
  created_at: string;
}

export interface FaqEntry {
  id: string;
  question: string;
  answer: string;
  tags: string[];
}

let getOrderStmt: StatementSync | null = null;
let getOrderItemsStmt: StatementSync | null = null;

export function getOrderById(orderId: string): Order | undefined {
  const db = getDb();
  if (!getOrderStmt) getOrderStmt = db.prepare('SELECT * FROM orders WHERE order_id = ?');
  if (!getOrderItemsStmt)
    getOrderItemsStmt = db.prepare('SELECT sku, name, qty, price FROM order_items WHERE order_id = ?');
  const row = getOrderStmt.get(orderId) as unknown as Order | undefined;
  if (!row) return undefined;
  const items = getOrderItemsStmt.all(orderId) as unknown as Order['items'];
  return { ...row, items };
}

let getUserStmt: StatementSync | null = null;
export function getUserById(userId: string): User | undefined {
  const db = getDb();
  if (!getUserStmt) getUserStmt = db.prepare('SELECT * FROM users WHERE user_id = ?');
  return getUserStmt.get(userId) as unknown as User | undefined;
}

let searchFaqStmt: StatementSync | null = null;
export function searchFaq(query: string, topK = 3): FaqEntry[] {
  const db = getDb();
  if (!searchFaqStmt) {
    searchFaqStmt = db.prepare(
      `SELECT id, question, answer, tags FROM faq
       WHERE question LIKE ? OR answer LIKE ? OR tags LIKE ?
       LIMIT ?`,
    );
  }
  const like = `%${query}%`;
  const rows = searchFaqStmt.all(like, like, like, topK) as unknown as {
    id: string;
    question: string;
    answer: string;
    tags: string;
  }[];
  return rows.map((r) => ({ ...r, tags: r.tags.split(',') }));
}

// —— 写操作 ——

let updateOrderStatusStmt: StatementSync | null = null;
let insertRefundStmt: StatementSync | null = null;
export function applyRefund(orderId: string, amount: number, reason?: string): { ok: boolean; reason?: string } {
  const db = getDb();
  const order = getOrderById(orderId);
  if (!order) return { ok: false, reason: 'order_not_found' };
  if (amount > order.total) return { ok: false, reason: 'amount_exceeds_total' };
  if (!updateOrderStatusStmt)
    updateOrderStatusStmt = db.prepare('UPDATE orders SET status = ? WHERE order_id = ?');
  if (!insertRefundStmt)
    insertRefundStmt = db.prepare(
      'INSERT INTO refunds (order_id, amount, reason, created_at) VALUES (?, ?, ?, ?)',
    );
  updateOrderStatusStmt.run('refunded', orderId);
  insertRefundStmt.run(orderId, amount, reason ?? null, new Date().toISOString());
  return { ok: true };
}

let updateAddressStmt: StatementSync | null = null;
export function applyAddressUpdate(orderId: string, newAddress: string): { ok: boolean; reason?: string } {
  const order = getOrderById(orderId);
  if (!order) return { ok: false, reason: 'order_not_found' };
  if (order.status === 'shipped' || order.status === 'delivered') {
    return { ok: false, reason: 'already_shipped' };
  }
  if (!updateAddressStmt)
    updateAddressStmt = getDb().prepare('UPDATE orders SET shipping_address = ? WHERE order_id = ?');
  updateAddressStmt.run(newAddress, orderId);
  return { ok: true };
}

export function applyCancel(orderId: string): { ok: boolean; reason?: string } {
  const order = getOrderById(orderId);
  if (!order) return { ok: false, reason: 'order_not_found' };
  if (order.status === 'shipped' || order.status === 'delivered') {
    return { ok: false, reason: 'already_shipped' };
  }
  if (!updateOrderStatusStmt)
    updateOrderStatusStmt = getDb().prepare('UPDATE orders SET status = ? WHERE order_id = ?');
  updateOrderStatusStmt.run('cancelled', orderId);
  return { ok: true };
}

let insertNoteStmt: StatementSync | null = null;
let listNotesStmt: StatementSync | null = null;
export function appendNote(orderId: string, note: string): { ok: boolean } {
  if (!getOrderById(orderId)) return { ok: false };
  if (!insertNoteStmt)
    insertNoteStmt = getDb().prepare(
      'INSERT INTO notes (order_id, note, created_at) VALUES (?, ?, ?)',
    );
  insertNoteStmt.run(orderId, note, new Date().toISOString());
  return { ok: true };
}

export function getNotes(orderId: string): string[] {
  if (!listNotesStmt)
    listNotesStmt = getDb().prepare('SELECT note FROM notes WHERE order_id = ? ORDER BY id');
  const rows = listNotesStmt.all(orderId) as unknown as { note: string }[];
  return rows.map((r) => r.note);
}

let insertEscalationStmt: StatementSync | null = null;
export function recordEscalation(reason: string, urgency = 'medium', orderId?: string): { ok: boolean } {
  if (!insertEscalationStmt)
    insertEscalationStmt = getDb().prepare(
      'INSERT INTO escalations (order_id, reason, urgency, created_at) VALUES (?, ?, ?, ?)',
    );
  insertEscalationStmt.run(orderId ?? null, reason, urgency, new Date().toISOString());
  return { ok: true };
}

/** 快照接口：评测时 ch11 用，导出主要表的全量数据用于 db_state_delta */
export interface DbSnapshot {
  orders: Record<string, { status: string; total: number; shipping_address: string }>;
  refunds: Record<string, { order_id: string; amount: number }>;
  notes: Record<string, { order_id: string; note: string }>;
  escalations: Record<string, { reason: string; urgency: string }>;
}

export function snapshotDb(): DbSnapshot {
  const db = getDb();
  const orders = db.prepare('SELECT order_id, status, total, shipping_address FROM orders').all() as unknown as Array<{
    order_id: string;
    status: string;
    total: number;
    shipping_address: string;
  }>;
  const refunds = db.prepare('SELECT id, order_id, amount FROM refunds').all() as unknown as Array<{
    id: number;
    order_id: string;
    amount: number;
  }>;
  const notes = db.prepare('SELECT id, order_id, note FROM notes').all() as unknown as Array<{
    id: number;
    order_id: string;
    note: string;
  }>;
  const escalations = db.prepare('SELECT id, reason, urgency FROM escalations').all() as unknown as Array<{
    id: number;
    reason: string;
    urgency: string;
  }>;

  return {
    orders: Object.fromEntries(
      orders.map((o) => [
        o.order_id,
        { status: o.status, total: o.total, shipping_address: o.shipping_address },
      ]),
    ),
    refunds: Object.fromEntries(
      refunds.map((r) => [String(r.id), { order_id: r.order_id, amount: r.amount }]),
    ),
    notes: Object.fromEntries(
      notes.map((n) => [String(n.id), { order_id: n.order_id, note: n.note }]),
    ),
    escalations: Object.fromEntries(
      escalations.map((e) => [String(e.id), { reason: e.reason, urgency: e.urgency }]),
    ),
  };
}
