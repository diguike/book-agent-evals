---
title: 第 18 章　数据飞轮：线上日志反哺评测集
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/ZXRIwwL2jirTzRkPDT5cXmPbnre"
last_synced: "2026-06-03T04:15:13Z"
---

## 本章你会拿到什么

到第 17 章，评测集已经有 340 条。但生产里 ShopAgent 每天处理几千几万条真实对话——**最好的评测样本永远在线上日志里，不在你的手工设计里**。这一章你会：

1. **理解数据飞轮的完整闭环**：线上日志 → hard case 挖掘 → 标注 → 评测集 → CI 守门 → 改进 → 上线 → 新日志
2. **拿到 hard case 挖掘的 4 类信号**：升级人工、用户差评、agent 错误日志、生产 traffic 采样
3. **学会自动标注 pipeline 的设计**：LLM 预标 + 人工抽检 + 高置信入集 + 低置信丢人工
4. **看到一周的真实飞轮跑了什么**：模拟 7 天线上日志，演示挖掘 → 标注 → 入集 → 复跑评测

**代码组织说明**：本章把数据飞轮拆成 3 个门讲（escalation 信号挖掘 → 自动归类 → PII 脱敏），三段在书里以**方法论 + 参考实现伪代码**形式呈现。仓库当前 v1 没把 flywheel 抽成独立 lib 模块（`evalkit/src/flywheel/` 不存在），而是在 ch18 章节 example 里跑一个最小可用 demo（`examples/ch18-data-flywheel/src/eval.ts`，~80 行）：扫 ch17 跑出的 jsonl 日志、用 `parseLog` 拆 sample、按规则筛"边界 case"（policy 关键词匹配）、写到 `candidates/v2.1.0-candidates.jsonl` 作为下一版评测集的候选。本章后面贴出的 `signals/` / `pii_scrubber.ts` 等模块化代码是**推荐写法**——读者把章节 demo 抄进自家 evalkit 后按这套结构扩展即可。

## 数据飞轮的形态

Shreya Shankar 在 [Data Flywheels for LLM Applications](https://www.sh-reya.com/blog/ai-engineering-flywheel/) 里画过这张图：

```
                     ┌─────────────────┐
                     │  线上 traffic    │
                     │  (生产 agent)    │
                     └─────────────────┘
                              ↓
                  ┌──────────────────────┐
                  │  Trace collection    │
                  │  (每次对话存日志)      │
                  └──────────────────────┘
                              ↓
              ┌────────────────────────────┐
              │  Hard case mining          │
              │  (4 类信号过滤)             │
              └────────────────────────────┘
                              ↓
              ┌────────────────────────────┐
              │  自动标注 + 人工抽检         │
              └────────────────────────────┘
                              ↓
              ┌────────────────────────────┐
              │  评测集扩充 (v2.1.0 → v2.2.0)│
              └────────────────────────────┘
                              ↓
              ┌────────────────────────────┐
              │  CI 守门 + 改进 + 上线        │
              └────────────────────────────┘
                              ↓
                          回到顶部 ⟲
```

每周一次。每跑一圈评测集多一些、agent 强一些、用户满意度高一些、下一圈输入也变化。**这是评测系统的真正成熟形态**——不是一次性建好的，是持续演化的。

## 4 类 hard case 信号

不是所有线上对话都值得进评测集。挑出"hard case" 需要信号：

### 信号 1：用户主动升级到人工

线上 agent 内部如果调了 `escalate_to_human(reason)`——这是 agent 自己说"我搞不定了"。所有这类对话默认进 hard case pool：

```ts
// 推荐写法（仓库 v1 没内置，参考实现；可对照 examples/ch18-data-flywheel/src/eval.ts 里的 interesting filter）
export function findEscalations(traceDb: TraceDb, since: Date): TraceEntry[] {
  return traceDb.query({
    toolCalled: 'escalate_to_human',
    after: since,
  });
}
```

每周线上 ShopAgent 处理 10000 条对话，escalation 约 5-8% = 500-800 条。这是 hard case pool 的第一档输入。

### 信号 2：用户差评（CSAT ≤ 2 / 5）

对话结束后用户给 1-5 星评分。**1-2 星的对话**几乎肯定有问题：

```ts
export function findLowCsat(traceDb: TraceDb, since: Date): TraceEntry[] {
  return traceDb.query({
    csat_max: 2,
    after: since,
  });
}
```

线上 1-2 星比例约 3-5%。500 条 hard case。

### 信号 3：Agent 内部错误日志

Agent 实现层会记错误（tool 调用 reject、超时、retry）。这类日志的对话也是 hard case：

```ts
export function findToolErrors(traceDb: TraceDb, since: Date): TraceEntry[] {
  return traceDb.query({
    hasToolError: true,                  // backend rejected
    after: since,
  });
}
```

线上 tool error 比例约 2%。200 条 hard case。

### 信号 4：生产流量随机采样

前面 3 类都是"出过问题的"——但有些**潜在问题** agent 用户不抱怨（因为 agent 输出"看起来合理"但实际错）。需要随机采样补充：

```ts
export function randomSample(traceDb: TraceDb, since: Date, n: number): TraceEntry[] {
  const all = traceDb.query({ after: since });
  return shuffle(all).slice(0, n);
}
```

每周随机抽 100-200 条做"对照组"——保证评测集分布跟线上分布对齐。

## Hard case Pool 去重

4 类信号合在一起约 1300-1700 条 hard case / 周。**这个量级人工标注成本太高**——必须去重 + 优先级排序。

去重和第 4 章合成 pipeline 类似——embedding 相似度 > 0.85 算重复。线上 hard case 的 dedupe 通常**比合成数据更严格**，因为真实用户用语相对一致，重复率高：

```
原始 hard case: 1500 条
embedding dedupe (threshold 0.85): 480 条
```

约保留 1/3。剩下 480 条按"hard case 类型分布"采样到 100 条/周入下一阶段。

## 自动标注 Pipeline

100 条 hard case 全人工标注 = 3-4 小时 / 周。**LLM 预标 + 人工抽检** 能把人工时间压到 30 分钟 / 周：

```
100 条 hard case
    ↓ LLM 预标（用合成数据 prompt 类似的方法）
100 条带预标 jsonl
    ↓ 自动 confidence 分流
   ├─ 高 confidence (≥ 0.9, 约 70 条): 直接入候选集
   └─ 低 confidence (< 0.9, 约 30 条): 进人工标注队列
    ↓ 人工 review
人工标 30 条 + 抽检 5% 高 confidence = 总 35 条 / 周
```

LLM 预标 prompt：

```ts
const AUTO_LABEL_PROMPT = `下面是一条线上 agent 对话。判断：

1. agent 是否完成了用户请求？ (PASS/FAIL)
2. 如果 FAIL，归类到下面 failure mode 之一：
   - FM-tool-error: 工具调用失败
   - FM-policy: policy 违反（具体哪条 policy 注明）
   - FM-rag: RAG 检索问题
   - FM-multi-turn: 多轮上下文丢失
   - FM-injection: prompt injection
   - FM-other: 其他
3. confidence 你对这个判断的信心 (0.0-1.0)
4. 如果 confidence ≥ 0.9，写一个"期望 agent 应该怎么做"的 expected_behavior 字段

对话：
{conversation}

输出 JSON。`;
```

跑出来 70 条 confidence ≥ 0.9，30 条 confidence < 0.9（需要人工）。

## Hard case 入集策略

从自动标注 + 人工标注的 35 条 hard case 里，**最终能入评测集的远少于 35**。3 道门：

### 门 1：是否已在评测集

embedding 相似度对比 v2.1.0 全集，如果跟已有样本相似度 > 0.85 → 不入集（已经测过）。

**约 60% 被这一门过滤**——线上 hard case 跟评测集已有的 case 高度相似（因为评测集本来就是从类似分布里挑的）。

### 门 2：是否构成新的 failure mode

剩下 14 条按 failure mode 归类。如果这一类 failure mode 在评测集里已经有 5+ 条 → 优先级低，不强制入。

约 5-8 条新 failure mode 样本入集。

### 门 3：是否包含 PII

最严格的一道。线上日志里**几乎肯定有真实 PII**（Personally Identifiable Information，个人身份信息——能识别到具体个人的数据：姓名、手机号、身份证号、收货地址、邮箱等。中国《个人信息保护法》、欧盟 GDPR 都对 PII 处理有严格要求）。所有入集样本必须经过 PII 替换：

```ts
// 推荐写法（仓库 v1 没内置；PII 规则要按业务调整，故留给读者自家落地）
export function scrubPII(text: string): string {
  return text
    .replace(/1[3-9]\d{9}/g, '1XXXXXXXXXX')           // 手机号
    .replace(/o_\d+/g, () => `o_${Math.floor(Math.random() * 90000 + 10000)}`)  // 订单号占位
    .replace(/u_\d+/g, () => `u_${Math.floor(Math.random() * 9000 + 1000)}`)
    .replace(/\d{17}[\dX]/g, '370XXX19XXXX1234X')     // 身份证
    .replace(/[一-龥]{2,4}省[一-龥]+/g, '某省某市');  // 地址：简化版用中文省/市正则
}
```

40 行。所有线上 hard case 入集前**必须**过这步——这是合规底线（PIPL 第 13 条）。

> **地址脱敏的三种方法**（按工程成本递增）：
> 1. **正则匹配**（上面代码示例）：覆盖 "X 省 X 市 X 区" 模式。**优点**：零依赖、毫秒级。**缺点**：覆盖不全（"杭州市西湖区文三路" 不会被匹配，因为没有"省"字）
> 2. **NER（命名实体识别）**：用 spaCy / HanLP 标 LOC 实体，整段替换。**优点**：召回率高。**缺点**：要装 Python / 模型依赖，毫秒到百毫秒级
> 3. **LLM-as-scrubber**：直接让 LLM 替换所有地址。**优点**：最准 + 上下文感知。**缺点**：每条 input 多一次 LLM 调用，成本和延迟都高
> 
> **生产建议**：起步用正则（够用 80% case），等漏检 case 频繁出现再升级到 NER。LLM-as-scrubber 留给特殊高敏场景（金融 / 医疗）。

最终一周入集 5-8 条新样本，从评测集 v2.1.0 → v2.2.0。一年滚下来评测集会从 200 条扩到 500-700 条（不算 v2.0 → v2.1 这种 batch 升级）。

## 一周飞轮跑了什么（模拟）

> **重要提示**：以下是用 LLM 生成的 7 天模拟线上日志演示，**不是真实业务数据**。每个数字（10247 对话 / CSAT 4.1 / 612 escalations）都是合成的，仅用于演示飞轮的输出格式和粒度。仓库 `examples/ch18-data-flywheel/` 有完整可跑的 demo，读者可以用自家 agent 的真实流量数据复跑。

模拟一周 ShopAgent 上线后的飞轮（用 LLM 生成 1000 条模拟线上日志）：

```
========== 飞轮周报 2026-W22 ==========
Date: 2026-05-25 to 2026-05-31

[Trace Collection]
  Total conversations: 10,247
  Avg turns: 3.2
  CSAT (n=4521 评分): 4.1 / 5

[Hard case Mining]
  Escalation (escalate_to_human): 612 (5.97%)
  Low CSAT (≤ 2):                312 (6.90% of rated)
  Tool errors:                    197 (1.92%)
  Random sample:                  100
  Total:                          1,221

[Dedupe]
  After embedding dedupe (0.85): 380

[Sampling]
  Stratified by hard case type:  100

[Auto-labeling]
  High confidence (≥ 0.9):       73
  Low confidence (< 0.9):        27 → human queue

[Human Review]
  Reviewed: 27 + 4 抽检 = 31 (35 min)
  Quality issues found in auto-label: 1/4 抽检（25% error rate but on small sample）

[Gate 1: Already in eval set]
  Filtered out (sim > 0.85): 78 (78%)

[Gate 2: Failure mode novelty]
  Filtered out (FM 已有 5+ 条): 14
  Kept: 8

[Gate 3: PII scrubbing]
  Successful: 8/8
  Failures: 0

[Final]
  v2.1.0 (200 samples) → v2.1.1 (208 samples)

[Discovered Failure Modes (new)]
  - FM-shipping-address-typo: 用户给错收货地址 typo，agent 没有 verify
  - FM-discount-confusion: 用户混淆"满减"和"折扣"，agent 计算错误
  - FM-cross-platform-order: 用户提到淘宝订单号在 ShopAgent 上查（应该礼貌引导）
```

一周加 8 条样本。看似不多，**但每条都是真实生产暴露的盲点**——比手工 brainstorm 出来的 case 价值高得多。

## CI 集成

飞轮结果一旦入评测集，下一次 CI 评测就会用上新版本。第 19 章 CI 章节会详细讲。这里关键流程：

```
飞轮周一 cronjob 跑
    ↓
新增 8 条样本，评测集 v2.1.1
    ↓
自动 PR 到 git 仓库
    ↓
作者 review + merge
    ↓
下一次 CI 跑评测自动用 v2.1.1
    ↓
任何 agent 修改 PR 也跑 v2.1.1
```

完全自动化的部分：**hard case mining → dedupe → auto-label → high confidence 入集 → PR**。
人工干预的部分：**human queue 标注 + PR review + merge**。

一周大概 1-1.5 小时人力，能持续把评测集变更对齐线上分布。

## Annotation Drift：注意点

数据飞轮跑久了会遇到 **annotation drift**（标注漂移：同一类 case 在不同时间被打上不一致的标签，原因可能是标注员换人、标注 guideline 模糊、对边界 case 理解变化）——同一类 case 不同时间标的标签不一致。例：

- 2026-05 标 "policy_4 confirmation" 时严格（必须问"吗？"）
- 2026-08 标 policy_4 时宽松（"请确认"也算）

这种 drift 让评测集**变得不一致**，影响跨时间 pass^k 对比。

防御方法：

1. **标注 guideline 写成文档**：每个 failure mode 的判定标准固化在文档，定期 review
2. **golden set 不变**：保留一份 100 条 "golden samples"（金标集：评测领域里被标注最严格、长期不动、用来锚定模型/scorer/judge 一致性基线的小型数据集）—— 标注从不修改。每次新数据入集前**先标 golden set**，跟历史结果对比，drift > 5% 报警
3. **多 reviewer 抽样**：每月找另一个人 review 50 条新入集样本，跟主 reviewer 计算 Cohen's Kappa

Hamel 的 Maven 课 Lesson 5 详细讲了 annotation drift 的应对（"Specification calibration"）。

## 飞轮的 6 个角色

完整飞轮在团队里需要 6 个角色（一个人可以兼）：

| 角色 | 职责 | 时间投入（/周） |
|---|---|---|
| Domain Expert | 定义 failure mode / 判定标准 | 1-2 小时 |
| Annotator | 标 low-confidence 样本 | 1-2 小时 |
| ML Eng | 维护飞轮 pipeline | 0.5 小时（除 incident）|
| PM | review 新 failure mode + 优先级 | 0.5 小时 |
| SRE | 监控线上 trace 收集系统 | 0.5 小时 |
| Data Steward | PII 合规 / 数据集版本管理 | 1 小时 |

总共 4-6 小时 / 周。**远低于一开始造评测集的成本**——飞轮的核心价值是把 "人均 6 小时 / 周" 这点投入持续转化成评测集质量提升。

## 不要的飞轮反模式

### 反模式 1：飞轮无限增长

新样本一直加，老样本永不淘汰。一年后评测集 5000+ 条，跑一遍要 8 小时，没人愿意跑。

**正确做法**：定期"修剪"。每季度 review 评测集，淘汰 (1) 已经 100% pass^k 的"太简单"样本 (2) 跟其他样本高度重复的 (3) 已经过时的 scenario（如 2025 年的"仅退款"政策）。

### 反模式 2：自动标注 100%

省人力 = 0 抽检。LLM 预标错了你不知道，几个月后评测集污染。

**正确做法**：永远保留 5-10% 抽检比例。

### 反模式 3：飞轮没人 review PR

cronjob 自动 PR 但作者没人 merge，PR 堆积几十个。

**正确做法**：飞轮 PR 必须在 24h 内 review。如果作者休假，cronjob 自动暂停。

### 反模式 4：飞轮跟 CI 解耦

新样本入了集但 CI 没拉新版本，agent 改动不在新 hard case 上跑评测。

**正确做法**：飞轮 PR merge 后**自动触发一次 CI baseline run**，建立新版本下的 baseline 数字。

## 对照 Shreya / Hamel 资料

| EvalKit | Shreya Data Flywheel | Hamel Field Guide |
|---|---|---|
| 4 类 hard case 信号 | 同思路（escalation + CSAT + error + sampling） | 强调 escalation + low CSAT |
| Auto-labeling + human queue | 提到 "GenAI for labeling" | "domain expert labels critically" |
| PII scrubbing | 没专门讲 | 没专门讲（英文场景不严） |
| Golden set 防 drift | 提到 "track drift" | 提到 "specification calibration" |

Shreya 和 Hamel 给的是方法论方向，工程实现各家不一样。EvalKit 把这套落到 TS pipeline，是中文场景下的实操方案。

## 本章要点回顾

- **数据飞轮闭环**：线上日志 → 自动挖 hard case → PII scrub → 人工筛 → 加入评测集 → 改 prompt → 重跑评测 → 闭环
- **4 个 hard case 信号**：低置信回复 / 转人工 / 用户重试 / 工具调用异常
- **PII scrub 必做**：用户输入里手机号 / 身份证号 / 真实地址必须脱敏，否则评测集就是 PII 泄露源
- **6 个反模式预警**：飞轮节奏太频 / 没人工 / 重复样本不去重 / 评测集越长越好 / 飞轮没改 prompt / 跑评测不跑回归
- **一周飞轮 cadence**：周一挖 case、周三人工筛、周五加进评测集 + 重跑

## 第 18 章总结

评测集三段演进全部完成：

- **第 4 章**：从 0 造 60 条 L1 种子集（完整合成 pipeline）
- **第 17 章**：扩充到 200 条 + 版本管理
- **本章**：数据飞轮，让评测集持续从线上日志自动扩充

完整的"评测集从哪里来"问题彻底解决。读者照着做 ShopAgent 这套能复用到任何 agent 项目。

下一章把这套体系自动化——CI 集成 + 回归守门。

---

> 本章来自《AI Agent 评测工程实战》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev) · 反馈与勘误：[GitHub Issues](https://github.com/diguike/book-agent-evals/issues)
