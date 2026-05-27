// Seed 脚本 —— 一键重建 mock DB
// 跑：cd examples/shopagent && npm run seed
//
// 数据规模：5000 订单 / 500 用户 / 200 SKU / 100 FAQ
// 所有数据合成：手机号 1XXXXXXXXXX 占位，身份证号不出现
import { getDb, resetDb } from './sqlite.js';
import { unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// —— 伪随机：种子化 random 让 seed 数据可复现 ——
class Rng {
  private state: number;
  constructor(seed = 42) {
    this.state = seed;
  }
  next(): number {
    // xorshift32
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x;
    return Math.abs(x) / 2 ** 31;
  }
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
  pick<T>(arr: T[]): T {
    return arr[this.int(0, arr.length - 1)] as T;
  }
}

// —— 合成数据池 ——

const nicknames = [
  '张三', '李四', '王五', '赵六', '陈七', '周八', '吴九', '郑十',
  '冯朝', '钱亮', '孙浩', '李峰', '周宇', '吴磊', '郑爽', '王芳',
  '李娜', '陈静', '刘洋', '杨柳', '黄梅', '何雨', '林森', '罗云',
  '高翔', '徐辉', '马俊', '宋明', '蒋华', '韩强', '冯雪', '邓平',
  '曹斌', '彭程', '段勇', '丁俊', '田园', '袁帅', '杜星', '蔡明',
];

const cities = [
  { city: '北京', district: '朝阳区' },
  { city: '北京', district: '海淀区' },
  { city: '上海', district: '浦东新区' },
  { city: '上海', district: '徐汇区' },
  { city: '广州', district: '天河区' },
  { city: '深圳', district: '南山区' },
  { city: '深圳', district: '福田区' },
  { city: '杭州', district: '西湖区' },
  { city: '杭州', district: '滨江区' },
  { city: '成都', district: '武侯区' },
  { city: '武汉', district: '洪山区' },
  { city: '南京', district: '玄武区' },
  { city: '苏州', district: '吴中区' },
  { city: '西安', district: '雁塔区' },
  { city: '重庆', district: '渝中区' },
];

const streets = ['长安街', '建国路', '中山路', '解放路', '人民路', '科技园', '文三路', '珞瑜路', '科华路', '张江路'];

const skuTemplates = [
  { category: '服饰', items: ['羊毛衫', '运动鞋', '棉外套', 'T 恤', '牛仔裤', '羽绒服', '丝巾', '皮带', '袜子', '内衣'] },
  { category: '数码', items: ['蓝牙耳机', '机械键盘', '智能音箱', '电源适配器', '充电宝', '数据线', '手机壳', 'U 盘', '路由器', '智能手表'] },
  { category: '家居', items: ['保温杯', '马克杯', '抱枕', '台灯', '香薰', '收纳盒', '床品四件套', '毛巾', '地毯', '香烛'] },
  { category: '美妆', items: ['面膜', '口红', '香水', '洗面奶', '护手霜', '精华液', '防晒霜', '眼霜', '粉底液', '卸妆水'] },
  { category: '食品', items: ['坚果礼盒', '巧克力', '咖啡豆', '零食大礼包', '蜂蜜', '茶叶', '果干', '饼干', '速溶咖啡', '麦片'] },
];

const orderStatuses: { status: string; weight: number }[] = [
  { status: 'paid', weight: 30 },
  { status: 'shipped', weight: 25 },
  { status: 'delivered', weight: 35 },
  { status: 'pending', weight: 5 },
  { status: 'cancelled', weight: 3 },
  { status: 'refunded', weight: 2 },
];

const memberLevels: { level: string; weight: number }[] = [
  { level: 'normal', weight: 70 },
  { level: 'silver', weight: 15 },
  { level: 'gold', weight: 10 },
  { level: 'platinum', weight: 5 },
];

const carriers = ['顺丰', '圆通', '中通', '韵达', '京东物流', '德邦', '邮政 EMS'];

function weightedPick<T extends { weight: number }>(rng: Rng, items: T[]): T {
  const total = items.reduce((a, b) => a + b.weight, 0);
  let r = rng.next() * total;
  for (const it of items) {
    r -= it.weight;
    if (r <= 0) return it;
  }
  return items[items.length - 1]!;
}

function genAddress(rng: Rng): string {
  const c = rng.pick(cities);
  const street = rng.pick(streets);
  const num = rng.int(1, 999);
  return `${c.city}${c.district}${street} ${num} 号`;
}

// —— FAQ 100 条 ——

const faqTopics: { tag: string; questions: { q: string; a: string }[] }[] = [
  {
    tag: '保养',
    questions: [
      { q: '羊毛衫能机洗吗', a: '羊毛衫建议手洗，水温不超过 30°C，使用专用羊毛洗涤剂。机洗会导致缩水变形，损坏纤维结构。' },
      { q: '丝绸怎么洗', a: '丝绸建议干洗或冷水手洗，使用中性洗涤剂，洗后阴干，避免暴晒。' },
      { q: '皮鞋发霉怎么办', a: '用软布蘸取酒精擦拭，自然晾干，避免阳光直射。霉点严重时建议送专业护理。' },
      { q: '羽绒服洗涤注意事项', a: '建议送干洗。若手洗用 30°C 以下温水，加专用羽绒洗涤剂，晾干时多拍打恢复蓬松。' },
      { q: '机械键盘怎么清洁', a: '拔掉键帽用毛刷或气吹清理，键帽用温水洗后晾干。轴体不要进水。' },
      { q: '蓝牙耳机充不进电', a: '检查充电盒触点是否有污渍，用棉签擦拭。如仍无法充电请联系售后。' },
      { q: '智能手表防水级别', a: '本店智能手表标配 IP68 防水，可日常洗手淋雨。不建议游泳或潜水佩戴。' },
      { q: '台灯亮度调节', a: '本店台灯多档可调，长按开关切换亮度档位，部分支持触控调节。' },
      { q: '保温杯如何除异味', a: '加入少许小苏打和温水浸泡 30 分钟，刷洗后晾干。频繁使用可减少异味。' },
      { q: '香薰可以续芯吗', a: '本店多数香薰支持续芯，详见商品页"续芯包"链接。' },
    ],
  },
  {
    tag: '退货',
    questions: [
      { q: '7 天无理由退换货规则', a: '签收后 7 天内可申请无理由退换，商品需保持完好（不影响二次销售）。定制商品、生鲜、贴身衣物、数字商品除外。运费由买家承担，除非商品本身有质量问题。' },
      { q: '退货需要原包装吗', a: '需要原包装、所有配件和发票。如遗失需酌情扣费。' },
      { q: '退货运费谁出', a: '质量问题由商家承担运费；7 天无理由由买家承担运费。' },
      { q: '退款多久到账', a: '审核通过后 1-3 个工作日原路退回，信用卡可能需要 7 个工作日。' },
      { q: '已签收能退货吗', a: '7 天内可申请无理由退货。已使用且影响二次销售的不支持。' },
      { q: '部分退款怎么处理', a: '部分退款按比例退回到原支付账户，余款保留在订单内。' },
      { q: '换货流程', a: '提交换货申请→审核→寄回旧品→收到后发新品，全程约 5-7 天。' },
      { q: '只退不换会扣钱吗', a: '7 天无理由退货不扣运费可能扣运费，详见具体订单页面。' },
      { q: '没收到货想退款', a: '请先联系物流方，确认无法送达后申请退款，订单状态会变为 refunded。' },
      { q: '商品有质量问题', a: '请拍照举证后联系客服，质量问题包退包换，运费商家承担。' },
    ],
  },
  {
    tag: '发货',
    questions: [
      { q: '什么时候发货', a: '一般在付款后 24 小时内发货。预售商品按详情页注明时间。大促期间可能延迟 1-3 天。' },
      { q: '可以指定快递吗', a: '默认匹配最优路线快递。如需指定可在备注中说明，能否满足以仓库为准。' },
      { q: '发货后多久到', a: '一般 2-5 天，偏远地区 5-10 天。详见快递单号查询。' },
      { q: '为什么物流不更新', a: '快递在中转或揽收高峰期可能延迟更新，通常 24 小时内会刷新。' },
      { q: '能修改地址吗', a: '订单未发货可改地址。已发货请联系快递员或拒收。' },
      { q: '可以加急吗', a: '部分订单支持加急配送，详见商品页是否标有"急送"标识，需额外付费。' },
      { q: '发货地在哪', a: '本店仓库位于江苏苏州、广东深圳两地，按收货地址自动匹配。' },
      { q: '海外订单发货吗', a: '目前只支持中国大陆、港澳台地区，海外暂未开通。' },
      { q: '春节会发货吗', a: '春节按公告日期暂停，详见网站首页公告。' },
      { q: '取件码丢了怎么办', a: '凭手机短信或菜鸟驿站 APP 查询，也可联系驿站工作人员。' },
    ],
  },
  {
    tag: '支付',
    questions: [
      { q: '支持哪些支付方式', a: '支持支付宝、微信支付、银联卡、Apple Pay、信用卡。' },
      { q: '能使用礼品卡吗', a: '部分商品支持礼品卡支付，结算时勾选即可。' },
      { q: '支付失败怎么办', a: '可尝试更换支付方式重新支付。如金额已扣，请联系客服核实。' },
      { q: '能分期付款吗', a: '满 500 元订单支持花呗 / 信用卡分期，详见结算页。' },
      { q: '订单超时未支付', a: '订单 30 分钟未支付自动取消，库存释放。可重新下单。' },
      { q: '发票怎么开', a: '订单详情页可申请普票或专票，一般 3 个工作日内出。' },
      { q: '优惠券能叠加吗', a: '满减券和品类券通常可叠加，店铺券和平台券有时不可叠加，以结算页为准。' },
      { q: '运费规则', a: '满 99 包邮，部分偏远地区另算。具体见结算页。' },
      { q: '价格保护', a: '收货后 15 天内若同款降价，可申请差价返还。' },
      { q: '能改价吗', a: '订单已支付不可改价。如有客服协商，可走退款重拍。' },
    ],
  },
  {
    tag: '账户',
    questions: [
      { q: '注册账号', a: '点击右上角"注册"，按提示填手机号 + 验证码即可。' },
      { q: '修改密码', a: '账户中心 → 安全设置 → 修改密码。' },
      { q: '绑定手机', a: '账户中心 → 实名认证 → 绑定手机。' },
      { q: '会员等级怎么升', a: '累计消费满 1000 元升 silver，5000 升 gold，20000 升 platinum。' },
      { q: '注销账号', a: '请联系客服并完成身份核验，注销不可恢复。' },
      { q: '账号被盗', a: '立即修改密码 + 联系客服冻结，警方报案保留证据。' },
      { q: '怎么删除收货地址', a: '账户中心 → 地址管理 → 删除。最后一个地址不能删。' },
      { q: '看不到订单', a: '请确认账号是否登录正确，订单可能在其他绑定的手机号下。' },
      { q: '积分有效期', a: '积分自获取起 12 个月内有效，过期自动清零。' },
      { q: '会员可以退吗', a: '会员开通后 7 天内无使用可退，详见会员协议。' },
    ],
  },
  {
    tag: '售后',
    questions: [
      { q: '维修服务', a: '部分电子产品提供 1 年免费保修，详见保修卡。' },
      { q: '过保了能修吗', a: '过保收费维修，详见商品页"保修说明"。' },
      { q: '配件丢了能补吗', a: '联系客服按官方价补购配件。部分配件可免费寄送。' },
      { q: '商品到货损坏', a: '签收时请验货拍照，48 小时内联系客服走理赔流程。' },
      { q: '色差问题', a: '由于显示器差异，实物与图片可能略有色差。明显色差可退换。' },
      { q: '尺码不合适', a: '7 天无理由退换，注意保持商品完好、吊牌完整。' },
      { q: '面料过敏', a: '收到后试穿如有过敏请立即停穿，凭医生证明可退换。' },
      { q: '商品瑕疵', a: '可申请部分退款或换货，请上传清晰的瑕疵图片。' },
      { q: '联系客服', a: '工作时间 9:00-22:00。客服电话见网站底部，节假日不间断。' },
      { q: '投诉建议', a: '可在"联系我们"提交，或拨打 400 客服电话。我们会在 24 小时内回复。' },
    ],
  },
  {
    tag: '会员',
    questions: [
      { q: '会员有什么权益', a: '会员享受 95 折、生日礼券、专属客服、优先发货。等级越高权益越多。' },
      { q: '会员日活动', a: '每月 8 号会员日，多款商品 88 折。' },
      { q: '会员积分用途', a: '可抵扣订单金额（1 积分=0.01 元）、兑换商品、抽奖。' },
      { q: 'platinum 等级权益', a: 'platinum 会员享受 88 折、专属客服 7×24、生日双倍积分、免运费、优先售后。' },
      { q: '降级规则', a: '12 个月内未达消费门槛自动降一级。' },
      { q: '会员注销后积分', a: '注销账号积分清零，请提前使用。' },
      { q: '能转赠会员吗', a: '会员等级不可转赠。积分可在指定活动中转赠。' },
      { q: '会员价跟普通价区别', a: '会员价是会员专享，通常低 5%-12%。' },
      { q: '生日礼券领取', a: '生日当月自动发放至账户，30 天内有效。' },
      { q: '会员客服', a: '银卡及以上会员可在 APP 内一键联系专属客服。' },
    ],
  },
  {
    tag: '物流',
    questions: [
      { q: '怎么查物流', a: '订单详情页点"查看物流"，或在快递公司官网输入运单号查询。' },
      { q: '签收后发现少件', a: '请保留外包装在签收 24 小时内联系客服，凭证齐全可补发。' },
      { q: '快递放在驿站没人送', a: '商家默认按地址投递，是否上门由快递员决定。可联系驿站取件或要求送货。' },
      { q: '更换快递公司', a: '订单未发货可联系客服指定。已发货无法更换。' },
      { q: '物流停滞超过 5 天', a: '联系客服并提供运单号，由客服跟进物流方处理。' },
      { q: '快递员态度差', a: '可向所在快递公司投诉，或在订单中点"评价快递"。' },
      { q: '海外仓发货', a: '部分商品海外仓发货，时效较长（5-15 天），不收关税。' },
      { q: '到付订单', a: '本店暂不支持到付，所有订单需在线支付。' },
      { q: '物流费保险', a: '默认所有订单含基础物流险，可在结算页加购扩展险。' },
      { q: '冷链配送', a: '生鲜、冷链商品有专门快递，详见商品页。' },
    ],
  },
  {
    tag: '隐私',
    questions: [
      { q: '个人信息怎么保护', a: '订单脱敏后处理，敏感字段加密存储，不向第三方泄露。详见隐私政策。' },
      { q: '可以查我同事的订单吗', a: '不可以。客服只能查询当前登录账号的订单。' },
      { q: '退款记录会显示给谁', a: '仅订单本人和店铺财务可见。' },
      { q: '数据被删吗', a: '账户注销后 30 天内删除可识别个人信息，订单交易数据保留 7 年用于税务和审计。' },
      { q: 'cookie 怎么管', a: '可在浏览器设置中清除或禁用 cookie，但会影响购物体验。' },
      { q: '隐私协议在哪', a: '网站底部"隐私协议"链接可查看完整内容。' },
      { q: '客服会看到我的密码吗', a: '客服无法查看用户密码。如需重置请走"忘记密码"流程。' },
      { q: '订单导出包含什么', a: '订单详情、金额、状态。不含支付方式详情和身份证号。' },
      { q: '撤回授权', a: '账户中心 → 隐私设置 → 撤回授权（部分授权撤回后影响正常使用）。' },
      { q: '数据可携权', a: '可向客服申请导出您的全部订单数据，3 个工作日内邮件发送。' },
    ],
  },
  {
    tag: '活动',
    questions: [
      { q: '双 11 活动什么时候', a: '一般 10 月底预热，11.11 当天爆发。详见首页活动入口。' },
      { q: '满减规则', a: '同店铺商品满 199-30，满 399-80，满 999-200，可叠加店铺券。' },
      { q: '红包怎么用', a: '结算页自动抵扣，部分红包需手动选择。一个订单可用一个红包。' },
      { q: '抽奖奖品邮寄', a: '虚拟奖品自动到账，实物奖品 7 天内邮寄，请保持收货地址正确。' },
      { q: '签到积分', a: '每日签到 1 积分，连续 7 天奖励 10 积分，连续 30 天奖励 50 积分。' },
      { q: '邀请好友', a: '邀请新用户注册并下单，您和好友各得 30 元红包。' },
      { q: '老客户福利', a: '90 天内回购可领 10 元券，详见"我的福利"。' },
      { q: '内购会怎么参加', a: '会员可在 APP 内"我的"→"内购会"参加。' },
      { q: '抽奖中奖概率', a: '不同活动中奖率不同，详见活动详情页。所有抽奖经过公证。' },
      { q: '活动条款', a: '所有促销活动以详情页规则为准，本店保留最终解释权。' },
    ],
  },
];

export function seed(opts: { silent?: boolean } = {}): void {
  // 删除已有 db 文件
  const dbFile = process.env.SHOPAGENT_DB ?? resolve(__dirname, '../../data/shopagent.db');
  resetDb();
  if (existsSync(dbFile)) unlinkSync(dbFile);

  const db = getDb();
  const rng = new Rng(42);
  const log = opts.silent ? (() => {}) : console.log.bind(console);

  log('[seed] 创建 SKU…');
  const skus: { sku: string; name: string; category: string; price: number; stock: number }[] = [];
  const insSku = db.prepare('INSERT INTO skus (sku, name, category, price, stock) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 200; i++) {
    const tmpl = rng.pick(skuTemplates);
    const name = rng.pick(tmpl.items) + ' ' + ['基础款', '经典款', '限量版', '尊享款'][rng.int(0, 3)];
    const sku = 'sku_' + String(i + 1).padStart(4, '0');
    const price = [29, 59, 89, 99, 159, 199, 299, 399, 599, 799, 999, 1299, 1999, 2999][rng.int(0, 13)]!;
    const stock = rng.int(0, 200);
    skus.push({ sku, name, category: tmpl.category, price, stock });
    insSku.run(sku, name, tmpl.category, price, stock);
  }

  log('[seed] 创建用户…');
  const users: { user_id: string; member_level: string }[] = [];
  const insUser = db.prepare(
    'INSERT INTO users (user_id, nickname, phone_masked, member_level, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < 500; i++) {
    const userId = 'u_' + String(1000 + i).padStart(4, '0');
    const nickname = rng.pick(nicknames);
    const level = weightedPick(rng, memberLevels).level;
    users.push({ user_id: userId, member_level: level });
    const createdAt = new Date(2024, rng.int(0, 11), rng.int(1, 28)).toISOString();
    insUser.run(userId, nickname, '1XXXXXXXXXX', level, createdAt);
  }

  log('[seed] 创建订单…');
  const insOrder = db.prepare(
    'INSERT INTO orders (order_id, user_id, status, total, shipping_address, created_at, shipped_at, delivered_at, tracking_no, carrier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insItem = db.prepare(
    'INSERT INTO order_items (order_id, sku, name, qty, price) VALUES (?, ?, ?, ?, ?)',
  );

  for (let i = 0; i < 5000; i++) {
    const orderId = 'o_' + String(50000 + i);
    const user = rng.pick(users);
    const status = weightedPick(rng, orderStatuses).status;
    const itemCount = rng.int(1, 3);
    let total = 0;
    const itemMap = new Map<string, { sku: string; name: string; qty: number; price: number }>();
    for (let j = 0; j < itemCount; j++) {
      const sku = rng.pick(skus);
      const qty = rng.int(1, 2);
      total += sku.price * qty;
      const existing = itemMap.get(sku.sku);
      if (existing) {
        existing.qty += qty;
      } else {
        itemMap.set(sku.sku, { sku: sku.sku, name: sku.name, qty, price: sku.price });
      }
    }
    const items = Array.from(itemMap.values());
    const address = genAddress(rng);
    const created = new Date(2025, rng.int(0, 11), rng.int(1, 28), rng.int(0, 23), rng.int(0, 59));
    const createdISO = created.toISOString();
    let shippedISO: string | null = null;
    let deliveredISO: string | null = null;
    let tracking: string | null = null;
    let carrier: string | null = null;
    if (status === 'shipped' || status === 'delivered' || status === 'refunded') {
      shippedISO = new Date(created.getTime() + rng.int(1, 36) * 3600 * 1000).toISOString();
      tracking = rng.pick(['SF', 'YT', 'ZT', 'YD', 'JD']) + String(rng.int(1000000000, 9999999999));
      carrier = rng.pick(carriers);
    }
    if (status === 'delivered') {
      const shippedTime = shippedISO ? new Date(shippedISO).getTime() : created.getTime();
      deliveredISO = new Date(shippedTime + rng.int(24, 120) * 3600 * 1000).toISOString();
    }
    insOrder.run(orderId, user.user_id, status, total, address, createdISO, shippedISO, deliveredISO, tracking, carrier);
    for (const it of items) {
      insItem.run(orderId, it.sku, it.name, it.qty, it.price);
    }
  }

  log('[seed] 创建 FAQ…');
  const insFaq = db.prepare('INSERT INTO faq (id, question, answer, tags) VALUES (?, ?, ?, ?)');
  let faqIdx = 0;
  for (const topic of faqTopics) {
    for (const qa of topic.questions) {
      faqIdx += 1;
      const id = 'faq_' + String(faqIdx).padStart(3, '0');
      insFaq.run(id, qa.q, qa.a, topic.tag);
    }
  }

  log(`[seed] 完成：${500} 用户 / ${200} SKU / ${5000} 订单 / ${faqIdx} FAQ`);
  log(`[seed] DB 文件：${dbFile}`);
}

// 作为脚本直接跑
if (import.meta.url === `file://${process.argv[1]}`) {
  seed();
}
