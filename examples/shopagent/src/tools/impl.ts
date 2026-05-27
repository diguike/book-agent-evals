// 8 工具的实际执行实现 —— 跑在 agent loop 里。
// 这里实现就是 mock DB 调用 + policy 检查
import {
  getOrderById,
  getUserById,
  searchFaq,
  applyRefund,
  applyAddressUpdate,
  applyCancel,
  appendNote,
  recordEscalation,
} from '../db/index.js';

type ToolArgs = Record<string, unknown>;
type ToolResult = unknown;

function pickString(args: ToolArgs, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`参数 ${key} 缺失或非字符串`);
  }
  return v;
}

function pickNumber(args: ToolArgs, key: string): number {
  const v = args[key];
  if (typeof v !== 'number') {
    throw new Error(`参数 ${key} 缺失或非数字`);
  }
  return v;
}

function pickOptionalString(args: ToolArgs, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

export function executeTool(name: string, args: ToolArgs): ToolResult {
  switch (name) {
    case 'get_order': {
      const orderId = pickString(args, 'order_id');
      const order = getOrderById(orderId);
      if (!order) return { error: 'order_not_found', order_id: orderId };
      return order;
    }
    case 'get_user': {
      const userId = pickString(args, 'user_id');
      const user = getUserById(userId);
      if (!user) return { error: 'user_not_found', user_id: userId };
      return user;
    }
    case 'search_faq': {
      const query = pickString(args, 'query');
      const topK = typeof args.top_k === 'number' ? args.top_k : 3;
      return { results: searchFaq(query, topK) };
    }
    case 'refund_order': {
      const orderId = pickString(args, 'order_id');
      const amount = pickNumber(args, 'amount');
      const reason = pickOptionalString(args, 'reason');
      const result = applyRefund(orderId, amount);
      return { ...result, order_id: orderId, amount, reason };
    }
    case 'update_shipping_address': {
      const orderId = pickString(args, 'order_id');
      const newAddress = pickString(args, 'new_address');
      const result = applyAddressUpdate(orderId, newAddress);
      return { ...result, order_id: orderId, new_address: newAddress };
    }
    case 'cancel_order': {
      const orderId = pickString(args, 'order_id');
      const reason = pickOptionalString(args, 'reason');
      const result = applyCancel(orderId);
      return { ...result, order_id: orderId, reason };
    }
    case 'escalate_to_human': {
      const reason = pickString(args, 'reason');
      const urgency = pickOptionalString(args, 'urgency') ?? 'medium';
      return recordEscalation(reason, urgency);
    }
    case 'add_note': {
      const orderId = pickString(args, 'order_id');
      const note = pickString(args, 'note');
      return appendNote(orderId, note);
    }
    default:
      return { error: 'unknown_tool', tool: name };
  }
}
