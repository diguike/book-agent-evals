// ShopAgent 主线版 8 工具的 OpenAI function-calling schema
// 实现见 ./impl.ts；schema 和实现分开，方便评测时单独引用 schema
import type { ToolSchema } from '../types.js';

export const shopAgentTools: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'get_order',
      description: '查询订单详情，返回订单状态、商品、金额、收货地址、物流状态等。',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'string', description: '订单号，形如 o_99812' },
        },
        required: ['order_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_user',
      description: '查询用户资料，返回用户基本信息和近期订单摘要。',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: '用户 ID' },
        },
        required: ['user_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_faq',
      description: '在 FAQ 知识库里全文搜索，返回相关条目（含商品保养、退换货政策等）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          top_k: { type: 'number', description: '返回多少条，默认 3' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'refund_order',
      description: '给订单退款。退款金额不能超过订单金额。已发货订单需先确认。',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'string' },
          amount: { type: 'number', description: '退款金额（元）' },
          reason: { type: 'string', description: '退款理由（可选）' },
        },
        required: ['order_id', 'amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_shipping_address',
      description: '更新订单收货地址。已发货订单不能改。',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'string' },
          new_address: { type: 'string', description: '新收货地址（完整地址字符串）' },
        },
        required: ['order_id', 'new_address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_order',
      description: '取消订单。已发货订单不能直接取消，需走退货流程。',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'string' },
          reason: { type: 'string', description: '取消理由（可选）' },
        },
        required: ['order_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description: '升级到人工客服。当用户明确要求转人工，或问题超出 agent 能力时使用。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '转人工的原因摘要' },
          urgency: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: '紧急程度',
          },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_note',
      description: '给订单加内部备注，不直接通知用户但人工客服可见。',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'string' },
          note: { type: 'string', description: '备注内容' },
        },
        required: ['order_id', 'note'],
      },
    },
  },
];

export const shopAgentToolNames = shopAgentTools.map((t) => t.function.name);
