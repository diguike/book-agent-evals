---
title: 附录 A：模型评测进阶
feishu_url: "https://fivwvysqdz.feishu.cn/wiki/CvhVw9qKRiXKhek7ZISc5YvTnHd"
last_synced: "2026-05-27T14:59:41Z"
---

## 附录定位

主线 20 章占 80% 的 Layer 2 (Agent 评测)。Layer 1 (模型评测) 只在第 1 章金字塔里点到。这个附录补上 Layer 1 的工程细节——**当你需要给 ShopAgent 选底模或评估模型升级影响时**，用什么工具、看什么指标、怎么解读。

不会教你训模型 / 微调 / RLHF——那是另一本书的话题。

> **代码语言提示**：本附录是全书唯一出现 Python 代码的章节（OpenCompass / lm-evaluation-harness 都只有 Python 接口，没有官方 TS SDK）。读者**不需要会 Python 也不需要跑通这些示例**——读懂 yaml config 在干什么 + 输出格式长什么样即可。生产里集成模型评测结果的最简方式是跑完后导出 JSON，再用 TS 读 JSON 跟自家应用层评测对比。

## 为什么应用层工程师需要模型评测

ShopAgent 用 GPT-4o 跑了一年。现在你面对几个决策：

1. **能不能换成 GPT-4o-mini 省 90% cost？**
2. **要不要换成 Claude Sonnet 4.5 拿到更好 tool-use？**
3. **公司要求国产化，DeepSeek V3 / Qwen3-Max / GLM-4.5 哪个最适合？**

直接拿 ShopAgent 评测集（200 条 L1 + 100 条 L2 + 40 条 L3）跑每个模型——这是**应用层评测**。够了吗？

不一定。问题：

- 应用层评测样本量小，**统计置信度有限**（200 条 SE = 3-4 个点）
- 应用层评测覆盖**你业务场景**，但模型其他能力强弱看不出（数学推理、代码、长文本）
- 模型选型经常需要看**model card 之外的客观数据**——MMLU / HumanEval / SuperCLUE 公开榜单

需要 Layer 1 模型评测**作为补充**。决策路径：

```
模型选型决策
    ↓
看公开榜单（OpenLLMLeaderboard / Chatbot Arena / SuperCLUE）筛掉明显弱的
    ↓
2-3 个候选模型在自家应用集上跑 (Layer 2)
    ↓
对比 cost / latency / 业务 pass rate
    ↓
决定
```

Layer 1 是**filter**，Layer 2 是**final decision**。两者都用。

## OpenCompass：国内模型横评事实标准

[OpenCompass](https://github.com/open-compass/opencompass) 是上海 AI Lab 出的开源评测平台，~7k stars，对应海外 lm-evaluation-harness。

### 跑一次 GPT-4o vs DeepSeek V3 vs Qwen3 横评

OpenCompass 用 Python，配置即代码：

```python
# configs/eval_shopagent_models.py
from mmengine.config import read_base
from opencompass.models import OpenAI, HuggingFace, OpenAICompatible
from opencompass.partitioners import NaivePartitioner
from opencompass.runners import LocalRunner

with read_base():
    from .datasets.ceval.ceval_ppl import ceval_datasets       # C-Eval 中文学科
    from .datasets.cmmlu.cmmlu_ppl import cmmlu_datasets       # CMMLU 中文常识
    from .datasets.humaneval.humaneval_gen import humaneval_datasets  # 代码
    from .datasets.gsm8k.gsm8k_gen import gsm8k_datasets        # 数学
    from .datasets.bbh.bbh_gen import bbh_datasets              # 推理

datasets = sum([ceval_datasets, cmmlu_datasets, humaneval_datasets, gsm8k_datasets, bbh_datasets], [])

models = [
    dict(
        type=OpenAI,
        path='gpt-4o-2024-11-20',
        key='ENV_OPENAI_API_KEY',
        max_seq_len=8192, batch_size=8, run_cfg=dict(num_gpus=0),
    ),
    dict(
        type=OpenAICompatible,
        path='deepseek-chat',
        openai_api_base='https://api.deepseek.com/v1',
        key='ENV_DEEPSEEK_API_KEY',
        max_seq_len=8192, batch_size=8, run_cfg=dict(num_gpus=0),
    ),
    dict(
        type=OpenAICompatible,
        path='qwen3-max',
        openai_api_base='https://dashscope.aliyuncs.com/compatible-mode/v1',
        key='ENV_DASHSCOPE_API_KEY',
        max_seq_len=8192, batch_size=8, run_cfg=dict(num_gpus=0),
    ),
]
```

跑：

```bash
python run.py configs/eval_shopagent_models.py --debug
```

跑完出来一张表（OpenCompass 自动写 markdown）：

```
| Model         | C-Eval | CMMLU | HumanEval | GSM8K  | BBH   | Avg   |
|---------------|--------|-------|-----------|--------|-------|-------|
| gpt-4o        | 75.2   | 74.8  | 88.4      | 92.6   | 84.5  | 83.1  |
| deepseek-v3   | 81.4   | 80.2  | 89.7      | 88.5   | 80.3  | 84.0  |
| qwen3-max     | 86.5   | 84.1  | 78.2      | 89.1   | 76.4  | 82.9  |
```

3 个模型在 5 个学术 benchmark 上各有强弱：

- **Qwen3-Max** 中文学科最强（C-Eval 86.5），代码弱（HumanEval 78.2）
- **DeepSeek V3** 代码最强（HumanEval 89.7），中文够用
- **GPT-4o** 综合稳定但中文略弱

但这只是**Layer 1 数据**。你的 ShopAgent 客服任务是中文工具调用，跟上面 5 个基准没有直接对应。下一步必须把 Layer 2 跑起来。

## Layer 1 → Layer 2 决策

跑完上面 OpenCompass 横评后，理性筛掉：

- Qwen3-Max（HumanEval 78.2 太低，意味着 function calling JSON 生成可能弱）

剩 2 个候选：GPT-4o / DeepSeek V3。在 ShopAgent 评测集上跑：

```
EvalKit L1 v2.0.0 (200 samples):

gpt-4o pass^1:        71.0%
deepseek-v3 pass^1:   62.5%

EvalKit L2 v2.0.0 (100 samples):
gpt-4o pass^1:        47%
deepseek-v3 pass^1:   38%

Cost (单次 L1 评测):
gpt-4o:        $0.18
deepseek-v3:   $0.022 (8 倍便宜)
```

DeepSeek V3 在 ShopAgent 上比 GPT-4o 低 8-9 个点，但便宜 8 倍。**取舍**：

- 高峰客流时段（cost 占主导）：用 DeepSeek V3
- 高客单价订单（质量占主导）：用 GPT-4o
- 一般情况：DeepSeek V3 + 失败的回退到 GPT-4o

**Layer 1 + Layer 2 数据放在一起，决策才有依据**。

## lm-evaluation-harness：海外学术评测后端

[EleutherAI/lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) 是海外对应 OpenCompass 的工具。它是 HuggingFace OpenLLMLeaderboard 的官方后端，被数百篇论文引用。

```bash
pip install lm-eval
lm_eval --model openai-completions \
        --model_args model=gpt-4o \
        --tasks mmlu,hellaswag,arc_challenge,truthfulqa,winogrande,gsm8k \
        --output_path runs/gpt4o-base
```

跑出来同样格式的报告。**OpenCompass 更适合中文 benchmark（C-Eval / CMMLU / SuperCLUE / FlagEval）**，lm-eval 更适合海外 benchmark（MMLU / HellaSwag / TruthfulQA）。

两者**互补**：

- 给国产模型选型 → 用 OpenCompass
- 跟海外 paper 数字对照 → 用 lm-eval

## 中文模型评测的几个独特坑

### 坑 1：MMLU 在中文模型上的分数误导

国产模型有时候 MMLU 分数很高（因为有针对性优化），但实际中文用户体验差。**单独看 MMLU 不够**，必须配 CEval / CMMLU。

### 坑 2：中文 tokenizer 让 cost 横评失真

第 6 章已讲——同样中文 prompt 在不同 tokenizer 下 token 数差 1.5-2 倍。横评 cost 必须用 token 数归一化，不是直接看美元单价。

### 坑 3：函数调用能力差异

学术 benchmark 不测 function calling。但应用层（agent）严重依赖 function calling 稳定性。**模型选型阶段必须单独跑 BFCL（[Berkeley Function-Calling Leaderboard](https://gorilla.cs.berkeley.edu/leaderboard.html)）或 ShopAgent 自家 tool-use 评测**。

实测 BFCL v4 (2025-12) 部分模型 function calling 能力：

| 模型 | BFCL Overall | Multi-Step Reasoning |
|---|---|---|
| GPT-5 | 70.31% | 32.94% |
| Claude Sonnet 4.5 | 65.5% | 28.5% |
| Claude Haiku 4.5 | 62.3% | 24.1% |
| GPT-4o | 58.7% | 18.2% |
| DeepSeek V3 | 52.4% | 15.6% |
| Qwen3-Max | 48.9% | 13.2% |

差距明显——选 agent 底模时 BFCL 比 MMLU 更相关。

### 坑 4：合规层"拒答"评测

国产模型有强制的合规层（敏感词 / 价值观）。一些 prompt 在国产模型上拿到 "我不能回答..." 这种 refusal，会让评测 pass^1 异常低。

正确解读：**评测 scorer 必须区分"模型能力不足"和"合规拒答"**。后者不算 evaluation failure，是模型设计。EvalKit 在 v2.x 加了 `compliance_refusal` 标签——如果 agent 输出含特征字符串"作为 AI 助手我"、"我无法回答"等，自动标 `refusal`，从 pass rate 计算中排除。

第 16 章 safety 章节相关，但更全面的合规层评测需要专门数据集——[THU-COAI Safety-Prompts](https://github.com/thu-coai/Safety-Prompts)（10w 条中文安全 prompts）是当前最权威的。

## Fine-tuning 数据污染陷阱（必看）

如果团队拿 production logs 做 fine-tuning，**最容易踩的坑**：production logs 里混入了评测样本的变体。

具体怎么发生：

1. 你的评测集 L1-100："订单 o_99812 还没发货吧，帮我退了"
2. 一个真实用户在生产里输入相似句子："o_88123 还没发货吧，能退吗"（攻击 vector 一样，措辞略改）
3. 这条生产对话进了 fine-tuning 数据集
4. Fine-tuned 模型再跑评测时，L1-100 pass^1 异常高——模型"记住了"训练里见过的 pattern
5. 你以为模型变好了，**但其实评测被污染了**

防范方法：

- **训练集和评测集严格物理隔离**：评测集存独立 git repo，fine-tuning data 流水线明确排除该 repo
- **训练后必跑 hold-out 集**：留 20% 评测样本不进任何训练流，作为"未被见过"的对照
- **dataset 加签名校验**：评测集每条样本算 sha256，训练 pipeline 报错任何匹配的样本

## 模型升级评测：v4 → v5 怎么测

每次模型更新（Claude Sonnet 4 → 4.5，GPT-4o → GPT-5），团队第一反应是"应该比之前好"。**不一定**——具体到你的业务场景可能涨可能跌。

正确做法：

1. **当天测 Layer 1**：跑 OpenCompass / lm-eval 几个核心基准，看 vendor 宣称的提升能否复现
2. **当天测 Layer 2**：跑 ShopAgent 全集，看在你业务上的 pass^k 是涨是跌
3. **A/B 测 Layer 3**（生产）：5-10% 流量切到新模型，跟踪 CSAT / escalation rate 7 天

实测案例：Claude Sonnet 4 → 4.5 升级后，ShopAgent L1 pass^1 涨 6 个点，但 cost 涨 12%。CSAT 涨 0.2 颗星。**净结果是值得升级**——但只有跑了评测才能算账，否则只能拍脑袋。

## Chatbot Arena Elo：用户偏好 vs 学术 benchmark

[Chatbot Arena](https://lmarena.ai/) 用 Elo 给 LLM 排名——基于真实用户 pairwise 偏好（"这两个回答你更喜欢哪个"）。

它的特殊价值：**反映真实用户主观偏好**，而不是学术 benchmark。有时候模型在 MMLU 高但 Arena Elo 不高——意味着学术能力强但用户体验差（可能输出太啰嗦 / 风格刻板）。

ShopAgent 选模型时可以**把 Arena Elo 作为"用户主观体验"的参考**：

| 模型 | MMLU | Arena Elo | 解读 |
|---|---|---|---|
| GPT-5 | 88.5 | 1450 | 学术强 + 用户喜欢 |
| Claude Sonnet 4.5 | 84.2 | 1432 | 接近 GPT-5，性价比好 |
| DeepSeek V3 | 81.0 | 1380 | 学术强但用户偏好略低 |
| Qwen3-Max | 86.5 | 1310 | 学术高但用户感觉一般 |

ShopAgent 客服场景对"用户感觉"敏感（语气、礼貌、自然），Arena Elo 是个有效维度。

## 微调模型怎么评测

如果你给 ShopAgent 微调了一个 LoRA / DPO 版本（"shopagent-tuned"），怎么知道有没有改善？

**对照评测**：

1. base model（gpt-4o-mini）跑 EvalKit 全集 → baseline
2. tuned model 跑同样全集 → candidate
3. CI 守门一样用 two-proportion z-test

**关键陷阱**：微调过程的训练数据**绝对不能跟评测集重叠**。否则 candidate 看起来涨 10 个点，实际是 contamination。

防御方法：

- 评测集在微调前 freeze（记录 git commit hash）
- 微调数据集和评测集走 embedding 相似度检测，sim > 0.85 的训练样本必须删
- 微调后 candidate 在**hold-out 评测集**上跑，hold-out 集训练时绝对不见

## 推荐工具组合

应用层工程师的"模型评测工具栈"：

| 用途 | 推荐工具 |
|---|---|
| 中文模型横评 | OpenCompass + EvalScope (推理性能) |
| 海外模型横评 | lm-evaluation-harness |
| Function calling 评测 | BFCL（手动跑，没 SaaS 服务） |
| 用户主观偏好参考 | Chatbot Arena 公开数据 |
| 合规评测 | THU-COAI Safety-Prompts |
| 业务级评测 | EvalKit (本书) |

这套组合花一天时间能跑完一个完整模型选型评估。

## 本附录要点回顾

- **Layer 1 工具**：OpenCompass（中文） / lm-evaluation-harness（英文学术） / Gradio Leaderboard（自建私有榜单）
- **模型选型决策路径**：先用自家 L1 v2 200 条跑候选模型 → 不确定时配上 Layer 1 横评 → 看综合 cost / 准确率 trade-off
- **Python-only 提示**：OpenCompass / lm-eval-harness 都没 TS SDK。建议跑完导出 JSON 再用 TS 集成
- **常见陷阱**：MMLU 高 ≠ tool-use 好；中文 benchmark 跟英文不通用；模型版本号要锁死
- **国产模型选型经验**：DeepSeek V3 工具调用强但中文长上下文偶尔抽风；Qwen3-Max tool-use 稳定但 cost 略高；GLM-4.5 性价比高但部分功能调用需 fallback parser

## 第 A 总结

Layer 1 模型评测是 Layer 2 的基础设施。**应用层工程师不需要会训模型，但需要会用工具读模型能力数据**。

跑模型评测不复杂——OpenCompass / lm-eval 都是配置即代码。难的是**怎么解读**：什么时候相信榜单数字、什么时候必须自己跑 Layer 2、合规拒答怎么处理、微调评测怎么防 contamination。

这个附录的目的不是给读者一份完整教程（那是另一本书），是给一张"什么时候去看 Layer 1 / 用什么工具 / 怎么读数字"的导航图。

---

> 本章来自《AI Agent 评测工程实战》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev) · 反馈与勘误：[GitHub Issues](https://github.com/diguike/book-agent-evals/issues)
