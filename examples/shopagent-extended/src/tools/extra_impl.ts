// 扩展版 4 工具的执行实现
// 共用主线的 DB，但加几个新表 / 新查询
import { getDb } from '@inferloop/shopagent';

interface ToolArgs {
  [k: string]: unknown;
}

function pickString(args: ToolArgs, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) throw new Error(`参数 ${key} 缺失或非字符串`);
  return v;
}

export function executeExtraTool(name: string, args: ToolArgs): unknown {
  const db = getDb();
  switch (name) {
    case 'list_orders': {
      const userId = pickString(args, 'user_id');
      const status = typeof args.status === 'string' ? args.status : undefined;
      const limit = typeof args.limit === 'number' ? args.limit : 10;
      let rows: unknown[];
      if (status) {
        rows = db
          .prepare(
            'SELECT order_id, status, total, created_at FROM orders WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?',
          )
          .all(userId, status, limit);
      } else {
        rows = db
          .prepare(
            'SELECT order_id, status, total, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
          )
          .all(userId, limit);
      }
      return { orders: rows };
    }
    case 'track_shipment': {
      const orderId = pickString(args, 'order_id');
      const row = db
        .prepare('SELECT order_id, status, shipped_at, delivered_at, tracking_no, carrier FROM orders WHERE order_id = ?')
        .get(orderId) as
        | {
            order_id: string;
            status: string;
            shipped_at: string | null;
            delivered_at: string | null;
            tracking_no: string | null;
            carrier: string | null;
          }
        | undefined;
      if (!row) return { error: 'order_not_found' };
      if (!row.tracking_no) return { order_id: orderId, status: row.status, trace: '尚未发货' };
      const trace = [];
      if (row.shipped_at) trace.push({ time: row.shipped_at, event: '已揽收', location: '商家仓库' });
      if (row.shipped_at) {
        const dt = new Date(row.shipped_at);
        trace.push({
          time: new Date(dt.getTime() + 8 * 3600 * 1000).toISOString(),
          event: '运输中',
          location: '中转站',
        });
      }
      if (row.delivered_at) trace.push({ time: row.delivered_at, event: '已签收', location: '收货地址' });
      return { order_id: orderId, status: row.status, carrier: row.carrier, tracking_no: row.tracking_no, trace };
    }
    case 'apply_coupon': {
      const orderId = pickString(args, 'order_id');
      const code = pickString(args, 'coupon_code');
      const order = db.prepare('SELECT status, total FROM orders WHERE order_id = ?').get(orderId) as
        | { status: string; total: number }
        | undefined;
      if (!order) return { error: 'order_not_found' };
      if (order.status !== 'paid') return { error: 'order_not_in_paid_state', status: order.status };
      // Mock 优惠券逻辑
      const discount = code.startsWith('VIP') ? 50 : code.startsWith('NEW') ? 30 : 10;
      const newTotal = Math.max(0, order.total - discount);
      db.prepare('UPDATE orders SET total = ? WHERE order_id = ?').run(newTotal, orderId);
      return { ok: true, discount, new_total: newTotal };
    }
    case 'check_inventory': {
      const sku = pickString(args, 'sku');
      const row = db.prepare('SELECT sku, name, stock FROM skus WHERE sku = ?').get(sku) as
        | { sku: string; name: string; stock: number }
        | undefined;
      if (!row) return { error: 'sku_not_found' };
      return row;
    }
    default:
      return { error: 'unknown_extra_tool', tool: name };
  }
}
