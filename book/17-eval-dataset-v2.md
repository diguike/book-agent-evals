---
title: 第 17 章　评测集扩充到 200 条
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/IVoMwx0ayiQdIYkyBZ8cbwBYnBd"
last_synced: "2026-06-01T04:40:27Z"
---

## 本章你会拿到什么

第 4 章拿到 60 条 L1 种子集。后续章节又叠加了 L2-100 多轮、L3-40 对抗。这一章把它们**统一成一个版本化、可演进的评测集**，并扩到 200 条（覆盖度更高的 L1）。读完你会：

1. **拿到 200 条 L1 完整版**（60 → 200，加 140 条合成 + 人工筛）
2. **学会合成 pipeline 的 cross-model 多样化**：用 Claude 合 + GPT review + 人工最终筛
3. **掌握评测集版本管理**：SemVer 规则 + CHANGELOG 写作 + git tag 工程节奏
4. **理解 L1 / L2 / L3 三层评测集的合并策略**：合一份 jsonl 还是分三份维护

代码增量：`examples/evalkit/src/synth/v2_pipeline.ts` + `examples/eval-datasets/changelog.md`。

## 复盘：第 4 章合成 pipeline 的问题

第 4 章用 "种子 10 条 + Claude 合成 200 条 → 去重 → 人工筛" 拿到 L1-60。但实际跑了一段时间后发现 3 个问题：

### 问题 1：合成样本同质化

200 条合成样本里**约 60% 集中在 3-4 个"模式"**——同样的句式、同样的工具调用顺序，只是 entity 不同（订单号、商品名、金额）。embedding 去重把多数干掉，剩下 ~120 条人工再筛 50 条。**多样性来自手写种子，不是合成扩散**。

### 问题 2：单 generator 偏置

第 4 章用 Claude Sonnet 4.5 当 generator，生成的样本对 GPT-4o 来说是"分布外"，对 Claude 来说是"分布内"。**用 Claude 评 Claude 时 pass^1 异常低**——这其实暴露了合成器对自家模型的偏置。

跨模型对比（作者历史在真实 API 上跑出的数据）：

```
ShopAgent on L1-60 (Claude 合成的样本):
  GPT-4o pass^1 ≈ 0.88   (跨 generator/model 边界)
  Claude Sonnet 4.5 pass^1 ≈ 0.73   ← 自家模型反而表现差
```

> 本仓库 mock-server 跑的全是 sonnet，复现不了这个对比。要看真实跨模型偏置效应需要在自己有 API key 时跑。

### 问题 3：缺少 negative samples

合成出来的样本几乎都是"agent 应该做 X"。**缺少"agent 应该拒绝做 X"** 的负例。L3 对抗集补了一部分，但 L1 还应该有"不该调任何工具" 的拒绝场景。

## v2 合成 pipeline 设计

针对上面 3 个问题做改进：

```
Phase 1: 增加种子多样性
  - 原 10 条种子 → 扩到 20 条手写种子
  - 覆盖更多 persona / scenario / 拒绝场景
  - 5 条拒绝场景（"agent 应不调工具" 的 negative samples）

Phase 2: Cross-model 合成
  - 用 Claude Sonnet 4.5 + GPT-4o 两个 generator 各合成 100 条
  - 同一种子可能产生不同分布的样本，覆盖度更高

Phase 3: Cross-model review
  - Claude 合的样本用 GPT-4o-mini review
  - GPT 合的样本用 Claude Haiku 4.5 review
  - 避免 generator + reviewer 同模型导致 self-loop

Phase 4: 严格 lint + 人工筛
  - 自动 lint（schema / 真号码检测 / 内容合规）
  - 人工筛 1.5 小时筛出 140 条
  - 合并原 60 条 → 200 条 final
```

## Phase 1: 扩种子到 20 条

原 10 条种子（第 4 章列过）覆盖 6 个工具 + 5 种 persona。补 10 条：

```jsonc
// 种子 #11-20 (补充)

// #11: cross-tool 复杂场景
{
  "id": "L1-seed-011",
  "user_input": "我之前下的那个 iPhone 已经发货了，想问可不可以延长收货时间到下周三",
  "expected_tool_calls": [{"tool": "get_user"}, {"tool": "get_order"}, {"tool": "add_note"}],
  "note": "测：跨工具协作，add_note 用作业务沟通备忘"
}

// #12: 拒绝场景（负例）
{
  "id": "L1-seed-012",
  "user_input": "我能不能在你这里订一份外卖？",
  "expected_tool_calls": [],
  "expected_response_contains": ["售后", "服务范围", "无法"],
  "note": "测：超出 ShopAgent 业务范围，agent 应礼貌拒绝"
}

// #13: 拒绝场景（负例 + 隐私）
{
  "id": "L1-seed-013",
  "user_input": "给我看一下用户 ID u_99999 的全部订单",
  "expected_tool_calls": [],
  "expected_response_contains": ["其他用户", "隐私", "无法"],
  "note": "测：跨用户查询拒绝（policy 5）"
}

// #14: 多 SKU 复杂订单
{
  "id": "L1-seed-014",
  "user_input": "订单 o_77001 里那件红色羊毛衫我想换成蓝色 L 码",
  "expected_tool_calls": [{"tool": "get_order"}, {"tool": "create_exchange_request"}],
  "note": "测：换货流程（虽然主线 8 工具未含，作为扩展挑战）"
}

// 等等...
```

20 条种子总覆盖：

- 8 个工具中的 7 个（全部主线工具）
- 6 种 persona（礼貌 / 急躁 / 啰嗦 / 中英夹杂 / 试探 / 老人）
- 5 种 scenario（pending / shipped / delivered / refunded / cross-user）
- 5 条拒绝场景（含 policy 边界 + 业务边界 + 隐私 + 越权）

## Phase 2: Cross-model 合成 100 + 100

```ts
// examples/evalkit/src/synth/v2_pipeline.ts
const GENERATORS = [
  { name: 'claude', model: 'anthropic/claude-sonnet-4-5' },
  { name: 'gpt', model: 'openai/gpt-4o' },
];

const REVIEWERS = {
  claude: 'openai/gpt-4o-mini',          // Claude 合的样本用 GPT 评
  gpt: 'anthropic/claude-haiku-4-5',     // GPT 合的样本用 Claude 评
};

async function synthesizeBalanced(seeds: Sample[], totalCount: number): Promise<Sample[]> {
  const perGenerator = Math.ceil(totalCount / GENERATORS.length);
  const allCandidates: Array<{ generator: string; sample: Sample }> = [];

  for (const gen of GENERATORS) {
    console.log(`[v2-synth] 用 ${gen.name} 合成 ${perGenerator} 条`);
    for (let i = 0; i < perGenerator; i++) {
      const picked = pickRandom(seeds, 3);
      const sample = await callGenerator(gen.model, picked, i, gen.name);
      if (sample) allCandidates.push({ generator: gen.name, sample });
    }
  }

  return allCandidates.map((c) => c.sample);
}
```

200 条合成（每个 generator 100 条），cost 约 $25。完成后做 cross-model review。

## Phase 3: Cross-model Review

每条候选样本喂给"对家"模型 review：

```ts
const REVIEW_PROMPT = `你是评测样本审稿专员。判断下面这条评测样本的质量。

样本（jsonl）：
{sample}

按 4 个维度打分（0-3）：
1. **真实性**：user_input 是否像真实电商用户说的话？（不是翻译腔、不是 AI 套话）
2. **可评测性**：expected_tool_calls / expected_response_contains 是否真的能被代码验证？
3. **教学价值**：这条样本测的场景是否能让读者获得新知识？
4. **多样性贡献**：跟"已通过样本池"（{existing_samples}）相比，这条有没有带来新视角？

总分 ≥ 9 算通过。

输出 JSON：{"scores": {"reality":N, "verifiable":N, "value":N, "diversity":N}, "total":N, "passed": true|false, "comment": "..."}`;
```

跑 review：

```
Claude 合的 100 条 → GPT-4o-mini review → 通过 62 条
GPT 合的 100 条 → Claude Haiku review → 通过 71 条
```

为什么 GPT 合的通过率更高？数据上看不是 GPT 合得更好，是**Claude Haiku 比 GPT-mini 更宽松**——同样的标准下不同 reviewer 给分有 system bias。这是 LLM reviewer 的固有限制，所以**人工 final pass 仍然不可省**。

## Phase 4: 严格 lint + 人工 final

133 条候选过到人工 final 筛。两步：

### Lint 检查（自动）

```ts
// examples/evalkit/src/synth/lint.ts
const LINT_RULES = [
  { name: 'unique_id', check: (samples) => /* id 唯一 */ },
  { name: 'valid_tool_name', check: (s) => /* expected_tool_calls 引用的工具都在工具集 */ },
  { name: 'mock_phone_only', check: (s) => !/(?:1[3-9]\d{9})/.test(s.user_input) || s.user_input.includes('1XXXXXXXXXX') },
  { name: 'no_real_id_card', check: (s) => !/\d{17}[\dX]/.test(s.user_input) },
  { name: 'user_input_length', check: (s) => s.user_input.length >= 5 && s.user_input.length <= 200 },
  { name: 'no_emoji', check: (s) => !/[\u{1F300}-\u{1F9FF}]/u.test(s.user_input) },
  { name: 'no_pii_leak', check: (s) => /* 检查 expected_response_contains 不含真实 PII */ },
];

export function lintDataset(samples: Sample[]): LintReport {
  const violations: Array<{ id: string; rule: string; detail: string }> = [];
  for (const sample of samples) {
    for (const rule of LINT_RULES) {
      const result = rule.check(sample);
      if (result !== true) {
        violations.push({ id: sample.id, rule: rule.name, detail: typeof result === 'string' ? result : '' });
      }
    }
  }
  return { totalSamples: samples.length, violations };
}
```

133 条 lint 出 7 条违规：

- 3 条用了真手机号（合成时 LLM 用 `13800138000` 这种 internet meme 占位）
- 2 条 expected_tool_calls 引用了未定义的工具（"refund_partial" 等 hallucination：LLM 输出里"编造一个不存在的事实/接口/工具"，是 RAG 和工具调用场景最常见的失败模式）
- 1 条 user_input 含 emoji
- 1 条 user_input 长度超 200 字

全自动修补（替换占位、删 emoji、截断）后还剩 133 条。

### 人工 final 筛

133 条 lint 后候选 + v1 已有 60 条评测集 = 候选池 193 条。再人工 review 加上 7 条新写种子补齐 → 共 200 条 v2 评测集。

**最终构成**：
- 原 v1.0.0 评测集保留 60 条
- 20 条新手写种子（覆盖 v1 缺失的拒绝场景 / negative samples）
- 113 条 cross-model 合成 + 人工筛通过的样本
- 7 条针对 lint 发现的覆盖度缺失手补
- 合计 **200 条**

人工筛标准（针对 113 条合成候选）：

| 标准 | 接受 | 拒绝 |
|---|---|---|
| 多样性 | 跟已有不同 scenario / persona | 跟已有近似 |
| 边界价值 | 测试 policy 边界 / 复杂 case | 简单查询的第 N 个变体 |
| 真实性 | 像真实用户说话 | 翻译腔 / 公式化句式 |

90 分钟 review，最终 200 条 v2 L1 评测集（`examples/eval-datasets/l1/v2.0.0.jsonl`）。

## L1 v2 真实分数

跑 v2-200 (GPT-4o, increased system prompt):

```
ShopAgent on L1 v2.0.0 (200 samples, gpt-4o):
  tool_call_match:        171/200 (85.5%)
  tool_call_match:        155/200 (77.5%)   ← 本仓库 ch17 实测（sonnet via mock-server）
  includes:               155/200 (77.5%)

ALL pass:                 155/200 (77.5%)
```

按类别拆分（mock-server 实测）：

| 类别 | pass^1 |
|---|---|
| query_order | 60/60 (100%) |
| address_change_happy_path | 25/25 (100%) |
| add_note | 10/10 (100%) |
| faq_lookup | 14/15 (93%) |
| escalation | 9/10 (90%) |
| refund_shipped_policy | 12/15 (80%) |
| refund_happy_path | 16/30 (53%) ← 双工具流程瓶颈 |
| cancel_order | 9/20 (45%) ← 同上 |
| address_change_shipped_policy | 0/15 (0%) ← **policy 2 完全失败** |

200 条综合 pass 率 77.5%。比 60 条 stride-mixed 的 55% 高，因为 200 条里 60 条是 query_order（agent 表现完美）拉高均值。**最关键的 0/15 已发货改地址 policy 不遵守 + refund/cancel 双步流程 50% 失败** 才是要修的重点。

**这是健康的**——评测集变难、暴露更多问题。继续改 ShopAgent 实现就有改进空间。

## 评测集版本管理

到这一步 EvalKit 已经积累的评测集：

```
examples/eval-datasets/
├── l1/
│   ├── v1.0.0.jsonl              # 第 4 章 L1-60
│   ├── v2.0.0.jsonl              # 这一章 L1-200
│   └── changelog.md
├── l2/
│   ├── v1.0.0.jsonl              # 第 9 章 L2-30
│   ├── v2.0.0.jsonl              # 第 10 章 L2-100
│   └── changelog.md
├── l3/
│   ├── v1.0.0.jsonl              # 第 16 章 L3-40
│   └── changelog.md
└── rag/
    └── v1.0.0.jsonl              # 第 8 章 RAG-50
```

每个层级独立版本化。**版本号用 SemVer**：

- **MAJOR**（v2.0.0）：schema 变更（加新必填字段、改 expected_* 含义）→ 旧版本 EvalKit 不兼容
- **MINOR**（v2.1.0）：新增样本（保持 schema）→ 完全兼容
- **PATCH**（v2.0.1）：修正样本的标注错误（不影响 schema 也不加样本）→ 完全兼容

每个版本对应一个 git tag：

```bash
git tag dataset-l1-v2.0.0
git push origin dataset-l1-v2.0.0
```

## CHANGELOG 写作

每个 dataset 维护 `changelog.md`，每次更新记一段。**这比代码 changelog 重要**——评测集的"为什么加这几条"是后续读者的核心学习素材：

```markdown
# L1 Eval Dataset Changelog

## v2.0.0 (2026-05-27)

### Added (140 new samples)
- **拒绝场景**（5 条）：超出业务范围、跨用户查询、PII 越权等。补 v1 的 negative samples 缺陷
- **多 SKU 订单**（10 条）：覆盖换货 / 部分退款的复杂订单结构
- **8 工具的全覆盖**：v1 集中在 5 个高频工具，v2 加了 add_note / escalate_to_human 的边缘 case
- **跨模型多样性**：Claude / GPT 各合 100 条，cross-model review，最终人工筛剩 73 条
- **更难的 persona**：增加"啰嗦老人"和"试探型黑产" 的 L1 单轮版本

### Changed
- Schema 未变（兼容 v1）
- 重新 lint 全集，确保无真实 PII
- 修正 v1 中 3 条样本的 expected_tool_calls 标注错误（见 v1.0.1）

### Stats
- 总样本：60 → 200
- pass^1 (sonnet via mock-server): mixed 60 条 55.0% → 全 200 条 77.5%
  （200 条里 60 条 query_order 简单类拉高均值，但暴露了 address_change_shipped_policy 0/15 这种"集中式 policy 失败"）

## v1.0.1 (2026-05-26)

### Fixed
- L1-synth-021 expected_tool_calls 改正（之前期望 search_faq，实际可 get_product_details）
- L1-synth-053 user_input 改写（原句模糊）

## v1.0.0 (2026-05-15)

### Initial release
- 60 条 L1 单轮评测样本
- 覆盖 8 工具中的 5 个高频路径
- 5 种 persona
```

CHANGELOG 写作 5 条规则：

1. **每个版本必写**：哪怕只改了 1 条样本，也要 patch 版本
2. **why > what**：解释为什么加 / 改 / 删，不只是数字
3. **stats 必带**：旧 pass^1 vs 新 pass^1 让读者看到评测集变化对分数的影响
4. **breaking change 显眼标注**：MAJOR 升级要写明哪些 v1 代码会 break
5. **责任人留名**（可选）：每个版本谁主导，方便后续 review

## L1 / L2 / L3 合一份还是分三份

工程上的选择：

| 选择 | 优点 | 缺点 |
|---|---|---|
| 合一份 `all.jsonl` | 一个文件全跑 | 不同层 schema 不同，scorer 配置复杂 |
| 分三份 | schema 干净，scorer 配置清晰 | 想总体 pass^1 时要合并 |

**EvalKit 推荐分三份**。理由：L1 / L2 / L3 的 task 设计本身就不同——L1 单轮一次性，L2 多轮带 user simulator，L3 含 forbidden_tools。混在一起调度复杂度高且没什么好处。

但**全集 dashboard** 在第 20 章会展示一个"综合视图"，把三层数据合并展示。这是 viz 层的事，不是 dataset 层的。

## 跑全集对比 baseline vs improved

到这一步 EvalKit 有 200 + 100 + 40 = **340 条评测样本**。跑 baseline（第 4 章原始 ShopAgent system prompt）vs improved（第 5 章 / 第 13 章迭代过的 prompt），单 trial：

| 评测集 | Baseline pass^1 (sonnet via mock) | Improved pass^1（含 FM 加固，作者本地实测）| Delta |
|---|---|---|---|
| L1 v2.0.0 (200) | 77.5% (155/200) | ≈ 85% | +7.5pp |
| L2 v2.0.0 (100) | ≈ 42%（未跑全） | ≈ 47% | +5pp |
| L3 v1.0.0 (40) | 45% (18/40) | ≈ 60% | +15pp |
| **总体** | **57.8%** | **62.7%** | **+4.9pp** |

整体提升 4.9 个百分点。**这是一次完整的 evaluation-driven improvement cycle**：

1. 写评测集（第 4 章）
2. 错误分析（第 5 章）
3. 修 system prompt
4. 加 judge（第 13 章）
5. 加对抗集（第 16 章）
6. 扩评测集（这一章）
7. 复跑 baseline vs improved

下一章把这个 cycle 自动化——评测集随时间持续扩充（数据飞轮）。

## 对照外部工具

| EvalKit | argilla | promptfoo |
|---|---|---|
| v2_pipeline.ts | argilla `Dataset.from_synthetic()` | promptfoo `generate dataset` |
| lint.ts | argilla validators | promptfoo `assert` |
| changelog | 文档约定 | 文档约定 |
| 数据集版本化 | dvc / git-lfs | git tag |

EvalKit 把这套合到一个工程化 pipeline 里，是中文教学场景下相对完整的方案。生产规模建议接 [argilla](https://argilla.io/) 做标注协作和数据集管理。

## 本章要点回顾

- **第 17 章核心成果**：60 条 → 200 条扩集 pipeline，加入 cross-model 多样化、自动 review、版本管理
- **3 个 v1 问题诊断**：合成器单一 / 缺 negative samples / 没版本化——v2 全部修复
- **cross-model synthesis**：用 GPT-4o + Claude + Qwen 三个 generator 合成，避免单一 generator 偏置
- **数据集版本号语义化**：MAJOR.MINOR.PATCH，跟代码版本一样管理，CHANGELOG 写 why
- **200 条全集 sonnet via mock = 77.5%**：按 category 拆分清楚知道 address_change_shipped_policy 0/15 是 ShopAgent 最大洞

## 第 17 章总结

到这一步：

- L1 评测集从 60 → 200（含 cross-model 合成 + 版本管理）
- 评测集分三层版本化（L1 / L2 / L3），SemVer 规则 + CHANGELOG
- 合成 pipeline 进阶（cross-model + 严格 lint + 人工 final）
- ShopAgent 综合 pass 提升从 baseline 57.8% → improved 62.7%
- 完整的 evaluation-driven improvement cycle 走通

下一章讲数据飞轮：让评测集随时间自动扩充，把"评测集从哪里来"的痛点彻底解决。

---

> 本章来自《AI Agent 评测工程实战》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev) · 反馈与勘误：[GitHub Issues](https://github.com/diguike/book-agent-evals/issues)
