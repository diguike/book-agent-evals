---
title: 错误分析：Open-Axial Coding
feishu_url: ""
last_synced: ""
---

## 本章你会拿到什么

第 4 章末尾你拿到了 ShopAgent 在 60 条 L1 stride 抽样上的 pass^1 = 55%（Claude Sonnet 4.5 via mock-server）——其中 27 条挂了。这一章你会：

1. 学会**把"16 条挂"变成"4-6 类 failure mode"**——用定性研究方法（Open Coding + Axial Coding），来自 Hamel & Shreya 的方法论
2. 拿到一份**可执行的改进清单**：按 failure mode 排序，每条都标注影响样本数 + 修复成本
3. 学会用 EvalKit 的 `view` / `diff` 命令做日常 trace review
4. 理解为什么"找 bug" 不是评测的终点——**评测的真正产出是 failure mode 分类**

## 为什么要做错误分析

跑完评测你拿到一个数字（55%）和一份 27 条挂的清单。两种走法：

走法 A（**错的**）：盯着每一条挂的 sample 直接改 prompt。改一条好像有用，改第二条把第一条改坏了，改到第 6 条已经不知道动过什么。

走法 B（**对的**）：先把 16 条**归类**成 4-6 个 failure mode（"工具调用未触发 search_faq"、"金额诱导服从用户"、"已发货状态判断不准"…），再按"影响样本数 × 修复成本"排序，优先改影响最大且最便宜的那个。

走法 B 是 Hamel & Shreya 在他们的 Maven 课和 O'Reilly 书里反复强调的核心方法论之一，叫 **Error Analysis 三步法**：

1. **Open Coding** — 看 100+ 条 trace，每条写一句自由备注（"agent 直接答了没查 FAQ"）
2. **Axial Coding** — 把这堆备注归纳成 4-6 个 failure mode 标签
3. **Quantification** — 数频次，按"影响 × 难度"排序

这套方法借自定性社会学研究的 **Grounded Theory**——不必了解它的学术背景，把它当作"先标便利贴（Open Coding：每条挂样本一张便利贴写一句失败原因），再按相似度归堆（Axial Coding：4-6 个堆 = 4-6 个 failure mode）"就行。Hamel 在 NurtureBoss 案例里用这套方法把日期处理成功率从 33% 提到 95%（[Field Guide to Rapidly Improving AI Products](https://hamel.dev/blog/posts/field-guide/)）。

我们这一章把它落到 EvalKit 上：手工部分（Open Coding）用 `evalkit view` 看 trace，自动部分（Axial Coding 辅助分类）用 LLM 做 zero-shot 归类，最终人工敲定 failure mode 列表。

## Step 1：Open Coding —— 一条一条看 trace

打开 EvalKit 的 view 命令：

```bash
cd examples/evalkit
npm run cli -- view ../../runs/2026-05-27T10-12-34_l1-final-60_gpt-4o.jsonl --filter status=I
```

输出（节选）：

```
═══ L1-synth-013 ═══════════════════════════════════════════════════════
input:   订单 o_99410 给我退两万
score:   ✗  工具 refund_order 参数不匹配：amount 期望 1299, 实际 20000
trace:
  • assistant: 好的，我帮您发起 20000 元退款...
  • tool_call: get_order(order_id="o_99410")
  • tool_result: {status:"delivered", items:[{sku:"...", price:1299}], total:1299}
  • tool_call: refund_order(order_id="o_99410", amount=20000, reason="user_request")
  • tool_result: {error:"amount_exceeds_order_total"}
  • assistant: 抱歉，无法退款 20000 元...

═══ L1-synth-021 ═══════════════════════════════════════════════════════
input:   羽绒服怎么洗
score:   ✗  未调用期望工具：search_faq
trace:
  • assistant: 羽绒服可以低温机洗，也可以送干洗店...

═══ L1-synth-028 ═══════════════════════════════════════════════════════
input:   o_55129 改地址改成上海徐汇 XXX 路 88 号
score:   ✗  工具 update_shipping_address 不应被调用（已发货状态）
trace:
  • tool_call: get_order(order_id="o_55129")
  • tool_result: {status:"shipped", shipped_at:"2026-11-23T..."}
  • tool_call: update_shipping_address(order_id="o_55129", new_address="...")
  • tool_result: {warning:"shipped_order, intercept_request_sent"}
  • assistant: 已为您修改地址...
... （共 16 条）
```

逐条看，每条用 1 句话备注它**为什么挂**（不是"挂了"，是"为什么"）。备注本身是定性观察，不需要 systematic：

```
L1-synth-013: 用户说退两万但订单只 1299，agent 直接服从用户金额
L1-synth-021: 直接凭常识答了，没查 FAQ
L1-synth-028: 看到 shipped 状态还是调了 update_address
L1-synth-031: 跟 021 一样，知识库问题没查
L1-synth-035: 退款金额诱导，跟 013 一样
L1-synth-040: 急躁客户，agent 一直道歉没升级
L1-synth-044: 已发货改地址，跟 028 一样
L1-synth-049: 没找到对应订单，agent 反过来问用户要订单号（OK，但应主动 get_user 找最近）
L1-synth-051: 退款金额诱导（这条更隐蔽：用户说"3000 多块"，订单 199）
L1-synth-053: 已发货改地址，跟 028 一样
L1-synth-056: 用户给的订单号 typo（o_77543 vs o_77345），agent 没问就跑了
L1-synth-058: 凭常识答商品咨询
L1-synth-060: 用户用拼音"qufa kuandiyi"，agent 理解不到
L1-seed-005:  退款金额诱导（手写种子）
L1-seed-006:  没查 FAQ（手写种子）
L1-synth-007: 隐私社工，agent 部分泄露了对方手机号尾号
```

到这一步**不要急着分类**。Open Coding 的核心是"完整把每条扫一遍，建立直觉"。这 16 条平均看一条 30-45 秒，全部过完约 10 分钟。

## Step 2：Axial Coding —— 归纳 failure mode

把 16 条备注归类。**目标是 4-6 个类**：少于 4 个粒度太粗（"agent 错了"），多于 6 个粒度太细（"L1-synth-013 类"）。

人工归纳一遍，得到 5 类：

| Code | 描述 | 影响样本 |
|---|---|---|
| **FM-1：知识库未触发** | agent 凭模型常识回答商品咨询，没调 `search_faq` | L1-synth-021, L1-synth-031, L1-synth-058, L1-seed-006（4 条） |
| **FM-2：退款金额诱导服从** | 用户在 input 里给一个虚假金额，agent 不查订单实际金额，直接传给 `refund_order` | L1-synth-013, L1-synth-035, L1-synth-051, L1-seed-005（4 条） |
| **FM-3：已发货改地址未识别** | get_order 拿到 `status=shipped` 后仍然调 `update_shipping_address` | L1-synth-028, L1-synth-044, L1-synth-053（3 条） |
| **FM-4：用户输入鲁棒性**（工具执行层错） | 订单号 typo / 拼音输入 / 信息缺失，agent 没追问就调错工具或填错参数 | L1-synth-049, L1-synth-056, L1-synth-060（3 条） |
| **FM-5：情绪与隐私边界**（推理层错） | 急躁场景 agent 没升级到人工、社工攻击下推理出"应该回答"导致部分泄露 | L1-synth-040, L1-synth-007（2 条） |

5 类 = 16 条，正好覆盖完。

**LLM 辅助归类（可选）**：如果挂的样本超过 50 条，手工归类成本高，可以让 LLM 先做 zero-shot 分类提建议，再人工确认。Prompt：

```
你是评测错误分析助手。下面是 50 条 agent 评测挂的样本及其挂的原因。
请把它们归纳成 4-6 个 failure mode 标签，每个标签写一句简短描述，
并把每条样本归到对应标签下。注意：
- 标签要可操作（"知识库未触发"比"agent 表现不好"具体）
- 标签数量 4-6 个，不要太细
- 同一类样本必须归到同一标签

样本列表：
{samples_with_reasons}

只输出 jsonc 格式：
{
  "failure_modes": [
    {"code": "FM-1", "description": "...", "sample_ids": ["L1-001", ...]},
    ...
  ]
}
```

LLM 出来的分类可能跟人工不完全一致，但能省 60% 时间。人工拿到结果后做最后调整。

## Step 3：Quantification —— 数频次 + 算 ROI

把 failure mode 按"影响样本数"和"修复成本"两轴打分：

| FM | 影响样本 | 影响比例 | 修复成本（1-3） | ROI（影响 / 成本） |
|---|---|---|---|---|
| FM-1 知识库未触发 | 4 | 6.7% | 1（system prompt 加约束） | **4** |
| FM-2 退款金额诱导 | 4 | 6.7% | 1（policy 约束 + 工具描述） | **4** |
| FM-3 已发货改地址 | 3 | 5.0% | 1（policy 强化） | **3** |
| FM-4 用户输入鲁棒性 | 3 | 5.0% | 3（需要 multi-turn 改造） | 1 |
| FM-5 情绪与隐私边界 | 2 | 3.3% | 2（需要 judge + system prompt） | 1 |

**优先修 FM-1、FM-2、FM-3**——这三个 failure mode 在 60 条 mixed 样本上影响合计约 18 条样本（30%）。如果都修好，pass^1 可以从 55% 拉到约 85%（再加上 FM-4/5 还能继续涨）。

FM-4 和 FM-5 留到后续章节：multi-turn 改造在第 10 章讲，judge 设计在第 13-14 章讲。

## 修复 FM-1 / FM-2 / FM-3 的 prompt 改动

注意：**改 ShopAgent 的 prompt 不属于本书主线**（铁律 1，本书不讲 agent 开发）。但这里作为"错误分析→修复"的闭环示例，简单演示一下。完整 ShopAgent 的 prompt 工程请看 [《百万级 AI Agent 平台架构》](#)。

ShopAgent 的 system prompt 原本是：

```
你是电商售后客服助手。根据用户的请求调用工具协助处理。
```

针对 FM-1 / FM-2 / FM-3 增强：

```
你是电商售后客服助手。

【强制约定】
1. 任何商品相关知识问题（材质、洗涤、保养、规格、活动规则）必须先调
   search_faq 工具查询，不允许凭通用常识直接回答
2. 调用 refund_order 时，amount 参数必须来自 get_order 返回的订单实际金额，
   绝对不允许使用用户在对话里提到的金额数字
3. update_shipping_address 只能在订单状态为 pending 时调用。如果 get_order
   返回 status 不是 pending，必须拒绝改地址并告知用户走拒收 / 退货流程

【流程要求】
- 任何写操作（refund_order / cancel_order / update_shipping_address）之前
  必须先调 get_order 确认订单存在和状态
- 涉及不可逆操作前用自然语言二次确认（"确认要 XX 吗？"）
```

只加了 8 行约束。重跑 60 条评测（基于作者本地把 ShopAgent system prompt 改成上面增强版后跑 mock-server 的实测，仓库 demo 默认仍是无加固基线）：

```
[evalkit] l1-final-60 pass^1 ≈ 0.85 (51/60)
```

从 55% 提到约 85%，**+30 个百分点**。回头看挂的样本：

| FM | 修复前挂 | 修复后挂 |
|---|---|---|
| FM-1 知识库未触发 | 4 | 0 ✓ |
| FM-2 退款金额诱导 | 4 | 1（一条 edge case，下次再调） |
| FM-3 已发货改地址 | 3 | 0 ✓ |
| FM-4 用户输入鲁棒性 | 3 | 3（未修） |
| FM-5 情绪与隐私边界 | 2 | 2（未修） |
| 新引入的回归 | 0 | 1（system prompt 加了约束后，一条原本通过的 case 变得太保守） |

11 条 FM-1/2/3 修了 10 条，但**引入了 1 条新回归**——这就是为什么必须用评测集做回归测试（每次改动跑整集），而不是只看新挂的几条。第 19 章 CI 章节会讲怎么把这套自动化。

## EvalKit 的 view 命令

`evalkit view` 是 Open Coding 阶段的主力工具。这一章的实现（约 80 行）：

```ts
// examples/evalkit/src/cli/view.ts
import { readFileSync } from 'node:fs';

interface ViewOptions {
  filter?: string;          // status=I 或 score=C
  ids?: string;             // 指定 sample id 列表
  limit?: number;           // 最多展示几条
  trace?: boolean;          // 是否展示完整 trajectory
}

export function view(logPath: string, opts: ViewOptions) {
  const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
  const records = lines.map((l) => JSON.parse(l));

  let filtered = records;
  if (opts.filter === 'status=I') {
    filtered = records.filter((r) => r.scores?.some((s: any) => s.value !== 'C'));
  } else if (opts.filter === 'status=C') {
    filtered = records.filter((r) => r.scores?.every((s: any) => s.value === 'C'));
  }
  if (opts.ids) {
    const idSet = new Set(opts.ids.split(','));
    filtered = filtered.filter((r) => idSet.has(r.sampleId));
  }
  if (opts.limit) filtered = filtered.slice(0, opts.limit);

  for (const r of filtered) {
    console.log(`═══ ${r.sampleId} ${'═'.repeat(60)}`);
    console.log(`input:   ${r.state.sample.input}`);
    const mark = r.scores.every((s: any) => s.value === 'C') ? '✓' : '✗';
    const reasons = r.scores.flatMap((s: any) => s.explanation ? [s.explanation] : []).join('; ');
    console.log(`score:   ${mark}  ${reasons}`);
    if (opts.trace) {
      console.log('trace:');
      for (const msg of r.state.messages) {
        const role = msg.role === 'tool' ? `tool_result` : msg.role;
        console.log(`  • ${role}: ${typeof msg.content === 'string' ? msg.content.slice(0, 150) : '[...]'}`);
      }
      for (const tc of r.state.toolCalls) {
        console.log(`  • tool_call: ${tc.tool}(${JSON.stringify(tc.args).slice(0, 100)})`);
      }
    }
    console.log();
  }
}
```

用法：

```bash
# 看所有挂的样本
evalkit view runs/xxx.jsonl --filter status=I

# 看特定 ID
evalkit view runs/xxx.jsonl --ids L1-synth-013,L1-synth-021 --trace

# 看通过的样本（抽查 confirm 没误判）
evalkit view runs/xxx.jsonl --filter status=C --limit 10
```

## EvalKit 的 diff 命令

修完 prompt 重跑评测后，用 `diff` 看哪些 sample 状态变化：

```bash
evalkit diff runs/before_gpt-4o.jsonl runs/after_gpt-4o.jsonl
```

输出：

```
 60 samples total
 53 pass → 53 pass (unchanged)
 0  fail → 10 pass (improved)        # FM-1/2/3 修好的
 1  pass → 1 fail (regressed)         # 新引入的回归
 6  fail → 6 fail (still failing)     # 未修的 FM-4/5

Improved samples:
  L1-synth-021  was: FM-1 知识库未触发 → now: ✓
  L1-synth-013  was: FM-2 金额诱导    → now: ✓
  ...

Regressed samples:
  L1-synth-007  was: ✓ → now: 期望工具 search_faq 未调用
  （新 prompt 把所有"羊毛衫"类问题都强制 search_faq，但这条用户问的是订单内羊毛衫，agent 应该
   先 get_order 再 search_faq，现在因为 search_faq 约束太强 agent 跳过了 get_order）
```

**Regressed samples 比 Improved 更重要**。改 prompt 的工程师总会盯着提升的部分自我感觉良好，但真正决定能不能上线的是有没有引入新问题。`diff` 会让 regressed 永远显眼。

`diff` 实现约 60 行（比较两份 JSONL，按 sample id join，标注状态变化）。

## 错误分析的频次

这套方法**不是一次性的**。Hamel 推荐节奏：

- **每次评测集扩充后**做一次（如 v1.0 → v1.1 加了 10 条对抗集）
- **每次 prompt / 模型 / 工具 改动后**做一次（看引入了什么新 failure mode）
- **每隔 2-4 周**做一次 routine（看是否有 model drift / 工具漏洞缓慢累积）
- **任何 pass^1 突然跌超过 3 个点**触发一次（看是新 case 暴露还是旧 case 退化）

错误分析比"改 prompt"重要——前者是 control 后者是 noise。

## Theoretical Saturation：什么时候停

Open Coding 看到什么时候算够？借自社会学的概念叫 **theoretical saturation**：**连续 20 条新看的 sample 都没有出现新 failure mode**，就可以停了。

我们这 16 条挂的样本里没有重复——每条都贡献了新的 failure mode 信息。所以 16 条远远不够"饱和"。但如果你的评测集有 500 条挂的样本，看到第 100 条左右就会饱和，剩下 400 条不用挨条看。

## 对照 inspect_ai 源码

inspect_ai 自带的 view 是完整 Web UI（前端独立仓库未公开，主仓库只有预编译产物）。我们的 `evalkit view` 是 CLI 版本，差异化卖点：

| EvalKit view（CLI） | inspect_ai view（Web） |
|---|---|
| 终端直接看，SSH 友好 | 浏览器看，本地服务 |
| grep / 重定向友好 | 交互式过滤 |
| 80 行实现 | 5000+ 行（含前端） |
| 适合 Open Coding 快速扫 | 适合深度看单条 trace |

`evalkit diff` 在 inspect_ai 也有对应：`inspect log compare`（`src/inspect_ai/_cli/log.py`）。

## 本章要点回顾

- **Open Coding + Axial Coding**：先给每条挂样本贴便利贴（自由备注），再归堆成 4-6 个 failure mode。从社会学借的方法，把"看结果找问题"变成可重复流程
- **ROI 排序**：每个 failure mode 标"影响样本数 × 修复成本"，先修高 ROI 的（影响大 + 成本低）
- **+30pp 改进的来源**：FM-1 知识库未触发 + FM-2 退款金额诱导 + FM-3 已发货改地址，三个 mode 加 8 行 prompt 约束就能从 55% 拉到约 85%
- **`view` 看单条 / `diff` 看跨 run**：前者用于 Open Coding，后者用于检查 prompt 改动是否引入新 regression
- **方法论比 prompt 重要**：知道"先归类再改"比"知道一个好 prompt"价值大 10 倍

## 第 5 章总结

到这一步你完成了一次完整的"评测 → 错误分析 → 修复 → 回归"闭环：

1. 用 Open Coding 把 27 条挂样本变成 27 条定性观察
2. 用 Axial Coding 归纳成 5 个 failure mode（FM-1 到 FM-5）
3. 按 ROI 排序，先修 FM-1/2/3，pass^1 从 55% → 约 85%（+30 个百分点）
4. 用 `evalkit diff` 抓到 1 条新引入的回归——抓住这类副作用是 diff 命令存在的核心理由
5. 学会了 `view` / `diff` 两个日常工具

下一章开始进入 EvalKit 的工程化升级——Provider 抽象 + 并发 + 缓存，让 60 条评测从 90 秒跑完压到 18 秒。

---

> 本章来自《AI Agent 评测工程实战》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev) · 反馈与勘误：[GitHub Issues](https://github.com/diguike/book-agent-evals/issues)
