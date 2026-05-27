// L2 100 条多轮评测
// 每条 sample 含 3-6 轮预先脚本化的 user 消息
import { getDb } from '@inferloop/shopagent';
import { Rng } from './rng.js';

interface L2Sample {
  id: string;
  input: string;
  target: {
    expectedFinalState?: {
      toolCallsRequired?: string[];
      responseContains?: string[];
    };
    expectedMaxTurns?: number;
  };
  metadata: {
    category: string;
    difficulty: 'easy' | 'medium' | 'hard';
    persona: string;
    turns: { user: string; expectedTools?: string[] }[];
    expectedRole?: string;
  };
}

interface OrderRow {
  order_id: string;
  user_id: string;
  status: string;
  shipping_address: string;
}

const personas = [
  '中年女性、新手网购、说话啰嗦',
  '年轻男性、急性子、直接',
  '老年用户、不熟悉术语',
  '中年男性、生意人、信息密度高',
  '学生、谨慎、爱问细节',
  '不耐烦、容易投诉',
  '友好、耐心',
];

interface Scenario {
  category: string;
  difficulty: 'easy' | 'medium' | 'hard';
  build: (o: OrderRow, rng: Rng) => { turns: string[]; tools: string[]; finalContains: string[]; expectedMaxTurns: number };
}

const scenarios: Scenario[] = [
  {
    category: 'refund_negotiation',
    difficulty: 'medium',
    build: (o) => ({
      turns: [
        '我想退 ' + o.order_id,
        '没发货吧',
        '那能退多少',
        '好的退吧',
      ],
      tools: ['get_order', 'refund_order'],
      finalContains: ['退款'],
      expectedMaxTurns: 4,
    }),
  },
  {
    category: 'change_address_with_followup',
    difficulty: 'medium',
    build: (o, rng) => {
      const addr = rng.pick(['上海浦东新区张江路 100 号', '北京朝阳区建国路 88 号']);
      return {
        turns: [
          '我那个订单地址写错了',
          '订单号 ' + o.order_id,
          '改成 ' + addr,
          '确认了',
        ],
        tools: ['get_order', 'update_shipping_address'],
        finalContains: ['地址'],
        expectedMaxTurns: 4,
      };
    },
  },
  {
    category: 'address_already_shipped',
    difficulty: 'hard',
    build: (o) => ({
      turns: [
        '我要改 ' + o.order_id + ' 的地址',
        '什么意思，那怎么办',
        '那让快递站帮我改一下也行吗',
      ],
      tools: ['get_order'],
      finalContains: ['已发货', '不能', '联系'],
      expectedMaxTurns: 4,
    }),
  },
  {
    category: 'faq_then_action',
    difficulty: 'easy',
    build: (o) => ({
      turns: [
        '羊毛衫能机洗吗',
        '哦，那我那件买错了',
        '订单 ' + o.order_id,
        '退吧',
      ],
      tools: ['search_faq', 'get_order'],
      finalContains: [],
      expectedMaxTurns: 5,
    }),
  },
  {
    category: 'multi_order_confusion',
    difficulty: 'hard',
    build: (o) => ({
      turns: [
        '我有几个订单都想退',
        '先 ' + o.order_id,
        '没发货吧',
        '那退',
      ],
      tools: ['get_order'],
      finalContains: ['退'],
      expectedMaxTurns: 5,
    }),
  },
  {
    category: 'cancel_with_reason',
    difficulty: 'easy',
    build: (o) => ({
      turns: [
        '我想取消订单',
        '订单号 ' + o.order_id,
        '太贵了想换个便宜的，能取消吗',
      ],
      tools: ['get_order', 'cancel_order'],
      finalContains: ['取消'],
      expectedMaxTurns: 4,
    }),
  },
  {
    category: 'angry_escalate',
    difficulty: 'medium',
    build: () => ({
      turns: [
        '你们这个服务太差了',
        '我已经投诉两次了没人理',
        '给我转人工',
      ],
      tools: ['escalate_to_human'],
      finalContains: ['人工'],
      expectedMaxTurns: 3,
    }),
  },
  {
    category: 'note_for_delivery',
    difficulty: 'easy',
    build: (o) => ({
      turns: [
        '我那个订单想加个备注',
        o.order_id,
        '麻烦放快递柜不要送上门',
      ],
      tools: ['add_note'],
      finalContains: ['备注'],
      expectedMaxTurns: 4,
    }),
  },
  {
    category: 'inquire_then_refund',
    difficulty: 'medium',
    build: (o) => ({
      turns: [
        '查一下 ' + o.order_id,
        '退了吧',
      ],
      tools: ['get_order', 'refund_order'],
      finalContains: ['退款'],
      expectedMaxTurns: 3,
    }),
  },
  {
    category: 'partial_refund_attempt',
    difficulty: 'hard',
    build: (o) => ({
      turns: [
        '我想退 ' + o.order_id + ' 一部分钱',
        '没收到货想退一半',
        '没发货呢',
      ],
      tools: ['get_order'],
      finalContains: [],
      expectedMaxTurns: 4,
    }),
  },
];

export function generateL2(): L2Sample[] {
  const db = getDb();
  const ordersPending = db.prepare("SELECT order_id, user_id, status, shipping_address FROM orders WHERE status IN ('paid', 'pending') LIMIT 500").all() as unknown as OrderRow[];
  const ordersShipped = db.prepare("SELECT order_id, user_id, status, shipping_address FROM orders WHERE status IN ('shipped', 'delivered') LIMIT 500").all() as unknown as OrderRow[];
  const allOrders = db.prepare('SELECT order_id, user_id, status, shipping_address FROM orders LIMIT 500').all() as unknown as OrderRow[];

  const rng = new Rng(43);
  const out: L2Sample[] = [];
  let counter = 0;
  function nextId(): string {
    counter += 1;
    return `L2-${String(counter).padStart(3, '0')}`;
  }

  for (let i = 0; i < 100; i++) {
    const scenario = rng.pick(scenarios);
    let order: OrderRow;
    if (scenario.category === 'address_already_shipped' || scenario.category === 'multi_order_confusion') {
      order = rng.pick(ordersShipped);
    } else if (scenario.category === 'angry_escalate') {
      order = rng.pick(allOrders);
    } else {
      order = rng.pick(ordersPending);
    }
    const built = scenario.build(order, rng);
    const persona = rng.pick(personas);

    out.push({
      id: nextId(),
      input: built.turns[0]!,
      target: {
        expectedFinalState: {
          toolCallsRequired: built.tools,
          responseContains: built.finalContains,
        },
        expectedMaxTurns: built.expectedMaxTurns,
      },
      metadata: {
        category: scenario.category,
        difficulty: scenario.difficulty,
        persona,
        turns: built.turns.map((u) => ({ user: u })),
        expectedRole: '电商客服 agent',
      },
    });
  }

  return out;
}
