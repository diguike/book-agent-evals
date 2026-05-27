// L1 200 条生成 —— 单轮 + 单工具 / 双工具
// 来源：从 SQLite 真实 seed 取订单/用户 ID
import { getDb } from '@inferloop/shopagent';
import { Rng } from './rng.js';

interface L1Sample {
  id: string;
  input: string;
  target: {
    expectedToolCalls: { tool: string; args_match: Record<string, unknown> }[];
    expectedResponseContains?: string[];
    forbiddenTools?: string[];
  };
  metadata: {
    category: string;
    difficulty: 'easy' | 'medium' | 'hard';
    notes?: string;
  };
}

interface OrderRow {
  order_id: string;
  user_id: string;
  status: string;
  total: number;
  shipping_address: string;
}

interface SkuRow {
  sku: string;
  name: string;
}

// —— 用户输入模板池 ——
const queryOrderTemplates = [
  '查一下我那个订单到哪了，订单号 {ORDER}',
  '{ORDER} 这个订单的物流到哪了？',
  '帮我看一下 {ORDER}',
  '{ORDER} 啥时候发货？',
  '我的订单 {ORDER} 状态怎么样',
  '麻烦查一下 {ORDER} 这单',
  '{ORDER} 现在到哪了',
];

const refundUnshippedTemplates = [
  '订单 {ORDER} 还没发货吧，帮我退了',
  '{ORDER} 不想要了，退款',
  '我要取消 {ORDER}，钱退给我',
  '{ORDER} 给我退款',
];

const refundShippedTemplates = [
  '{ORDER} 收到了不喜欢，能退吗',
  '{ORDER} 已经签收，想退款',
  '想退 {ORDER}，已经到货了',
];

const cancelTemplates = [
  '{ORDER} 还没发货，取消吧',
  '我想取消 {ORDER}',
  '{ORDER} 不要了，能取消吗',
  '麻烦帮我取消 {ORDER}',
];

const updateAddressTemplates = [
  '{ORDER} 还没发货吧，地址改成 {ADDR}',
  '{ORDER} 想改地址到 {ADDR}',
  '帮我把 {ORDER} 的收货地址改成 {ADDR}',
  '{ORDER} 改地址，新地址 {ADDR}',
];

const updateShippedTemplates = [
  '{ORDER} 想改地址到 {ADDR}',
  '{ORDER} 改下地址 {ADDR}',
  '帮我换下 {ORDER} 的地址 {ADDR}',
];

const escalateTemplates = [
  '我已经投诉三次了，给我转人工',
  '我要投诉你们的服务',
  '让人工跟我聊',
  '机器人解决不了我的问题，转人工',
  '说了半天没用，找你们经理',
];

const noteTemplates = [
  '帮我在订单 {ORDER} 上备注：用户希望周末配送',
  '{ORDER} 加个备注：先放快递柜不要送上门',
  '在 {ORDER} 留个言：保留发票',
  '{ORDER} 帮我标记一下要礼品包装',
];

const faqTemplates = [
  '羊毛衫能机洗吗？',
  '7 天无理由退换货是什么规则',
  '什么时候发货',
  '可以指定快递吗',
  '丝绸怎么洗',
  '台灯怎么调亮度',
  '会员等级怎么升',
  '支持哪些支付方式',
  '退款多久到账',
  '过保了能修吗',
];

const newAddresses = [
  '上海市浦东新区张江路 100 号',
  '北京市朝阳区建国路 88 号',
  '广州市天河区天河路 50 号',
  '深圳市南山区科技园 1 号',
  '杭州市西湖区文三路 200 号',
  '成都市武侯区科华路 30 号',
  '武汉市洪山区珞瑜路 12 号',
  '南京市玄武区中央路 33 号',
];

function pickByStatus(orders: OrderRow[], statuses: string[], rng: Rng): OrderRow {
  const filtered = orders.filter((o) => statuses.includes(o.status));
  return rng.pick(filtered);
}

function fillTpl(tpl: string, vars: Record<string, string>): string {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  }
  return out;
}

export function generateL1(): L1Sample[] {
  const db = getDb();
  const orders = db.prepare('SELECT order_id, user_id, status, total, shipping_address FROM orders LIMIT 1000').all() as unknown as OrderRow[];
  const skus = db.prepare('SELECT sku, name FROM skus').all() as unknown as SkuRow[];
  void skus;
  const rng = new Rng(42);
  const out: L1Sample[] = [];
  let counter = 0;

  function nextId(): string {
    counter += 1;
    return `L1-${String(counter).padStart(3, '0')}`;
  }

  // —— 1. 单工具 get_order：60 条 ——
  for (let i = 0; i < 60; i++) {
    const o = rng.pick(orders);
    const tpl = rng.pick(queryOrderTemplates);
    out.push({
      id: nextId(),
      input: fillTpl(tpl, { ORDER: o.order_id }),
      target: {
        expectedToolCalls: [{ tool: 'get_order', args_match: { order_id: o.order_id } }],
        expectedResponseContains: [o.order_id],
      },
      metadata: { category: 'query_order', difficulty: 'easy' },
    });
  }

  // —— 2. get_order + refund（未发货）：30 条 ——
  for (let i = 0; i < 30; i++) {
    const o = pickByStatus(orders, ['paid', 'pending'], rng);
    const tpl = rng.pick(refundUnshippedTemplates);
    out.push({
      id: nextId(),
      input: fillTpl(tpl, { ORDER: o.order_id }),
      target: {
        expectedToolCalls: [
          { tool: 'get_order', args_match: { order_id: o.order_id } },
          { tool: 'refund_order', args_match: { order_id: o.order_id } },
        ],
        expectedResponseContains: ['退款'],
      },
      metadata: { category: 'refund_happy_path', difficulty: 'medium' },
    });
  }

  // —— 3. get_order，已发货拒绝退款：15 条 ——
  for (let i = 0; i < 15; i++) {
    const o = pickByStatus(orders, ['shipped', 'delivered'], rng);
    const tpl = rng.pick(refundShippedTemplates);
    out.push({
      id: nextId(),
      input: fillTpl(tpl, { ORDER: o.order_id }),
      target: {
        expectedToolCalls: [{ tool: 'get_order', args_match: { order_id: o.order_id } }],
        expectedResponseContains: ['退货'],
        forbiddenTools: ['refund_order'],
      },
      metadata: {
        category: 'refund_shipped_policy',
        difficulty: 'medium',
        notes: '已发货订单不能直接退款，应引导走退货流程',
      },
    });
  }

  // —— 4. update_shipping_address（未发货成功）：25 条 ——
  for (let i = 0; i < 25; i++) {
    const o = pickByStatus(orders, ['paid', 'pending'], rng);
    const newAddr = rng.pick(newAddresses);
    const tpl = rng.pick(updateAddressTemplates);
    out.push({
      id: nextId(),
      input: fillTpl(tpl, { ORDER: o.order_id, ADDR: newAddr }),
      target: {
        expectedToolCalls: [
          { tool: 'get_order', args_match: { order_id: o.order_id } },
          { tool: 'update_shipping_address', args_match: { order_id: o.order_id } },
        ],
        expectedResponseContains: ['地址'],
      },
      metadata: { category: 'address_change_happy_path', difficulty: 'medium' },
    });
  }

  // —— 5. update_shipping_address（已发货拒绝）：15 条 ——
  for (let i = 0; i < 15; i++) {
    const o = pickByStatus(orders, ['shipped', 'delivered'], rng);
    const newAddr = rng.pick(newAddresses);
    const tpl = rng.pick(updateShippedTemplates);
    out.push({
      id: nextId(),
      input: fillTpl(tpl, { ORDER: o.order_id, ADDR: newAddr }),
      target: {
        expectedToolCalls: [{ tool: 'get_order', args_match: { order_id: o.order_id } }],
        expectedResponseContains: ['已发货', '不能', '无法'],
        forbiddenTools: ['update_shipping_address'],
      },
      metadata: {
        category: 'address_change_shipped_policy',
        difficulty: 'hard',
        notes: '已发货订单不能改地址，policy 2',
      },
    });
  }

  // —— 6. cancel_order：20 条 ——
  for (let i = 0; i < 20; i++) {
    const o = pickByStatus(orders, ['paid', 'pending'], rng);
    const tpl = rng.pick(cancelTemplates);
    out.push({
      id: nextId(),
      input: fillTpl(tpl, { ORDER: o.order_id }),
      target: {
        expectedToolCalls: [
          { tool: 'get_order', args_match: { order_id: o.order_id } },
          { tool: 'cancel_order', args_match: { order_id: o.order_id } },
        ],
        expectedResponseContains: ['取消'],
      },
      metadata: { category: 'cancel_order', difficulty: 'medium' },
    });
  }

  // —— 7. search_faq：15 条 ——
  for (let i = 0; i < 15; i++) {
    const q = rng.pick(faqTemplates);
    out.push({
      id: nextId(),
      input: q,
      target: {
        expectedToolCalls: [{ tool: 'search_faq', args_match: {} }],
      },
      metadata: { category: 'faq_lookup', difficulty: 'easy' },
    });
  }

  // —— 8. escalate_to_human：10 条 ——
  for (let i = 0; i < 10; i++) {
    const q = rng.pick(escalateTemplates);
    out.push({
      id: nextId(),
      input: q,
      target: {
        expectedToolCalls: [{ tool: 'escalate_to_human', args_match: {} }],
        expectedResponseContains: ['人工'],
      },
      metadata: { category: 'escalation', difficulty: 'easy' },
    });
  }

  // —— 9. add_note：10 条 ——
  for (let i = 0; i < 10; i++) {
    const o = rng.pick(orders);
    const tpl = rng.pick(noteTemplates);
    out.push({
      id: nextId(),
      input: fillTpl(tpl, { ORDER: o.order_id }),
      target: {
        expectedToolCalls: [{ tool: 'add_note', args_match: { order_id: o.order_id } }],
        expectedResponseContains: ['备注'],
      },
      metadata: { category: 'add_note', difficulty: 'easy' },
    });
  }

  return out;
}
