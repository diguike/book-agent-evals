// RAG 50 条评测集 —— FAQ 问答
// 每条给一个 query + 期望召回的 FAQ ground truth + 期望回答关键词
import { getDb } from '@inferloop/shopagent';
import { Rng } from './rng.js';

interface RagSample {
  id: string;
  input: string;
  target: {
    expectedContexts: string[]; // ground truth 关键词
    expectedResponseContains: string[];
  };
  metadata: {
    category: string;
    difficulty: 'easy' | 'medium' | 'hard';
    rephrase_of?: string; // 原 FAQ id
  };
}

// 改写型问询（不是直接复制 FAQ 问题）
const variants: { faqTag: string; queries: { q: string; mustContain: string[] }[] }[] = [
  {
    faqTag: '保养',
    queries: [
      { q: '我刚买的羊毛衫能扔洗衣机吗', mustContain: ['手洗', '羊毛'] },
      { q: '丝绸怎么清洗才不缩水', mustContain: ['干洗', '冷水', '中性'] },
      { q: '羽绒服自己在家怎么洗', mustContain: ['干洗', '低温', '羽绒'] },
      { q: '皮鞋发了点霉怎么处理', mustContain: ['酒精', '软布'] },
      { q: '机械键盘上有灰尘怎么清', mustContain: ['毛刷', '气吹'] },
      { q: '保温杯里有股味道', mustContain: ['小苏打'] },
    ],
  },
  {
    faqTag: '退货',
    queries: [
      { q: '收到 5 天了能退吗', mustContain: ['7 天', '无理由'] },
      { q: '退货运费谁付', mustContain: ['质量', '买家'] },
      { q: '退款多久到账', mustContain: ['1-3', '原路'] },
      { q: '想换货怎么走流程', mustContain: ['寄回', '新品'] },
      { q: '商品坏了想退', mustContain: ['质量', '运费', '商家'] },
      { q: '可以只退一部分钱吗', mustContain: ['部分', '比例'] },
      { q: '签收了发现少东西', mustContain: ['24 小时', '客服'] },
      { q: '没收到货能退吗', mustContain: ['物流', '退款'] },
    ],
  },
  {
    faqTag: '发货',
    queries: [
      { q: '一般几天发货', mustContain: ['24 小时'] },
      { q: '能指定顺丰吗', mustContain: ['备注', '仓库'] },
      { q: '已经下单两天没发货', mustContain: ['24 小时', '客服'] },
      { q: '海外能送吗', mustContain: ['中国大陆', '海外'] },
      { q: '春节期间会发货吗', mustContain: ['公告'] },
      { q: '取件码丢了', mustContain: ['短信', '驿站'] },
      { q: '已经发货还能改地址吗', mustContain: ['联系', '快递员'] },
    ],
  },
  {
    faqTag: '支付',
    queries: [
      { q: '能用微信支付吗', mustContain: ['微信', '支付宝'] },
      { q: '支付的时候报错', mustContain: ['更换', '客服'] },
      { q: '能分期吗', mustContain: ['分期', '500'] },
      { q: '满多少包邮', mustContain: ['99', '包邮'] },
      { q: '订单 30 分钟没付会怎样', mustContain: ['自动取消', '库存'] },
      { q: '怎么开发票', mustContain: ['订单详情', '专票', '普票'] },
      { q: '优惠券能一起用吗', mustContain: ['叠加', '结算页'] },
      { q: '同款降价了能补差价吗', mustContain: ['15 天', '差价'] },
    ],
  },
  {
    faqTag: '账户',
    queries: [
      { q: '怎么注册账号', mustContain: ['手机号', '验证码'] },
      { q: '密码忘了', mustContain: ['修改', '安全设置'] },
      { q: '会员怎么升到金卡', mustContain: ['5000', '消费'] },
      { q: '账号被盗了', mustContain: ['修改密码', '客服'] },
      { q: '积分什么时候过期', mustContain: ['12 个月'] },
      { q: '收货地址能删吗', mustContain: ['地址管理'] },
    ],
  },
  {
    faqTag: '售后',
    queries: [
      { q: '我的耳机保修期是多久', mustContain: ['1 年', '保修'] },
      { q: '收到时商品已经坏了', mustContain: ['签收', '48 小时'] },
      { q: '衣服尺码不合适', mustContain: ['7 天', '吊牌'] },
      { q: '配件丢了能补吗', mustContain: ['客服', '配件'] },
      { q: '怎么投诉', mustContain: ['400', '联系我们'] },
      { q: '过保了还能修吗', mustContain: ['收费'] },
    ],
  },
  {
    faqTag: '会员',
    queries: [
      { q: '会员有什么好处', mustContain: ['95 折', '权益'] },
      { q: '会员日是什么时候', mustContain: ['8 号', '88 折'] },
      { q: 'platinum 等级有啥特权', mustContain: ['88 折', '7×24'] },
      { q: '生日会员有礼物吗', mustContain: ['生日'] },
      { q: '会员能转给别人吗', mustContain: ['不可转赠'] },
    ],
  },
  {
    faqTag: '物流',
    queries: [
      { q: '怎么看快递到哪了', mustContain: ['查看物流', '运单号'] },
      { q: '快递员把东西放驿站没问我', mustContain: ['驿站', '快递员'] },
      { q: '快递已经 5 天没动', mustContain: ['客服', '运单号'] },
    ],
  },
  {
    faqTag: '隐私',
    queries: [
      { q: '我的手机号会被泄露吗', mustContain: ['加密', '脱敏'] },
      { q: '能查我同事的订单吗', mustContain: ['不可以', '账号'] },
    ],
  },
];

export function generateRag(): RagSample[] {
  const db = getDb();
  // 校验 FAQ 表已 seed
  const cnt = db.prepare('SELECT COUNT(*) as n FROM faq').get() as { n: number };
  if (cnt.n === 0) throw new Error('FAQ 表为空，请先 cd ../shopagent && npm run seed');

  const rng = new Rng(45);
  void rng;
  const out: RagSample[] = [];
  let counter = 0;
  function nextId(): string {
    counter += 1;
    return `RAG-${String(counter).padStart(3, '0')}`;
  }

  for (const block of variants) {
    for (const v of block.queries) {
      out.push({
        id: nextId(),
        input: v.q,
        target: {
          expectedContexts: v.mustContain,
          expectedResponseContains: v.mustContain.slice(0, 2),
        },
        metadata: {
          category: block.faqTag,
          difficulty: 'medium',
        },
      });
    }
  }

  return out.slice(0, 50);
}
