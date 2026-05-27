// 扩展版新增的 4 个工具 schema：覆盖主线 8 个不能演示的 trajectory 场景
import type { ToolSchema } from '@inferloop/shopagent';

export const extraTools: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'list_orders',
      description: '列出某用户的订单列表，支持按状态过滤。',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: '用户 ID' },
          status: {
            type: 'string',
            enum: ['pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'],
          },
          limit: { type: 'number', description: '返回多少条，默认 10' },
        },
        required: ['user_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'track_shipment',
      description: '查询订单物流轨迹（每个节点的时间和地点）。',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'string' },
        },
        required: ['order_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_coupon',
      description: '把一张优惠券应用到订单上。订单状态必须是 paid。',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'string' },
          coupon_code: { type: 'string' },
        },
        required: ['order_id', 'coupon_code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_inventory',
      description: '查询某个 SKU 当前库存数量。',
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string' },
        },
        required: ['sku'],
      },
    },
  },
];
