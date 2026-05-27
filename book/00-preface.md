---
title: 前言
feishu_url: ""
last_synced: ""
---

## 一个真实的周一

2026 年 1 月某个周一上午十点，我在工位上盯着监控大屏，胃里发紧。上周五合并的那个 PR 把 ShopAgent 的退款工具签名从 `(orderId, reason)` 改成了 `(orderId, amount, reason)`——一个看似无害的"加一个必填参数"。周一一早，客服后台累计 11 起异常工单：用户说自己"被退了 0 元"。

我们没有评测集。改 prompt 靠脑补，发布靠"在 staging 跑两个 case 看着没问题"，回归只检查那 5 条手写的 happy path。线上发现问题，永远是用户先发现。

那一刻我特别清楚地意识到：**做 AI Agent 这两年，我们把所有精力都花在让 agent 跑起来，几乎没花精力让它跑得稳**。改一行 prompt 不敢上线，换一个模型不敢换，加一个工具不敢加。每次发版都像赌博。

后来我花了三个月时间，把 ShopAgent 的评测体系从零搭起来：200 条评测集、CI 守门、LLM-as-Judge、pass^k 一致性、对抗集。再后来跟其他几个做 agent 的工程师聊，发现每个人都在自己造同一套轮子，每个人都在踩同一个坑。

这本书就是写给那一刻——那个盯着监控大屏胃里发紧的我，以及和那时的我一样的工程师。

## 这本书写给谁

适合你读，如果你是这种人：

- **应用层 LLM / Agent 工程师**，已经在用 Vercel AI SDK / LangChain.js / Mastra 之类的工具搭过 agent，但没系统做过评测
- **从模型训练转应用层的工程师**，熟悉 lm-evaluation-harness / OpenCompass 那套学术评测，但发现到了 agent 层根本对不上号
- **被老板要求"给 agent 出质量报告"** 但找不到入手点的工程师
- **想在公司内部建立评测体系** 但不知道从哪里开始的技术负责人
- **Node + TypeScript 全栈背景**——这本书的代码全部是 TS，与你日常的技术栈无缝对接

不适合你读，如果你是这种人：

- **纯模型训练 / RLHF / DPO 工程师**——本书侧重应用层评测，不深入后训练
- **完全没接触过 LLM API 调用的人**——你需要先会用 OpenAI SDK 之类的工具发一次 chat completion 请求
- **想要"现成 prompt 模板速查手册"的人**——本书强调方法论 + 工程实战，不是 cookbook
- **拒绝 TypeScript 的纯 Python 用户**——类比能跨语言，但代码读起来会吃力

**如果你还没搭过真正的 agent**：这本书的"前置门槛"不高，但如果你只用过 ChatGPT 没真的 import openai 写过代码，建议先花一两个晚上跑一下仓库的 ShopAgent (`cd examples/shopagent && npm run dev`)，发几条用户消息，看 agent 怎么调工具、返回什么——感性认识"被评测的对象"长什么样后，再开始读评测体系，节奏会顺很多。配套的 `examples/00-prereq/` 提供了 ShopAgent 的 30 分钟快速试驾脚本。

## 这本书覆盖什么 / 不覆盖什么

按重要性分三层：

| 层级 | 占比 | 内容 |
|------|------|------|
| **Agent 评测** | 80% | 任务完成率、trajectory、tool-use、multi-turn、judge、pass^k、safety、CI 回归 |
| **模型评测基础** | 15% | OpenCompass / lm-evaluation-harness，给模型选型做横评 |
| **产品评测** | 5% | Agent 评测指标怎么映射到 CSAT / 转化率等业务指标（附录 C） |

不覆盖：

- **Agent 开发本身**——本书的 ShopAgent 仓库里已经写好，作为"被评测的样本"使用。Agent 工程请看我之前的几本书：《Hermes Agent 源码解读》《OpenClaw 源码解析》《百万级 AI Agent 平台架构》《Agent Memory 工程实战》
- 模型预训练 / 后训练 / RLHF / DPO 的内部机制
- LLM 推理引擎实现
- Agent 编排框架本身的设计（LangGraph / CrewAI 已有专书）
- Prompt 工程入门——默认你已会

## 这本书怎么读

跟着两个真实可跑的载体走：

- **EvalKit** —— 一个用 TypeScript 写的轻量级 Agent 评测框架，对标 UK AISI 的 [inspect_ai](https://github.com/UKGovernmentBEIS/inspect_ai)，但只保留教学必要的核心抽象。**第 2 章末你就能跑出第一个评测的真实数字**，之后跟着书一章一章把它长出来
- **ShopAgent** —— 一个电商售后客服 Agent，仓库里已经写好。本书不讲它怎么开发，只把它当作"现成的被评测对象"。它故意保持简化：8 个工具 + 5 条 policy，让你不需要先变成电商专家就能开始评测

三条推荐路线，按时间预算挑：

- **快速上手路线（5-7 天）**：第一部分 3 章 → 第二部分 2 章，读到这里你已经有 60 条评测集 + EvalKit minimal 骨架可以回公司用。**为什么这么挑**：前 5 章覆盖"评测的最小心智模型 + 第一份能跑的评测集"，是周末两天能消化的最小单元。下周一回公司就能开始给自家 agent 造评测集。后面的章节都是这套基础上的工程化扩展，不影响当下能干活
- **系统学习路线（3-4 周）**：按章节顺序读，每章动手做配套 example。读到第五部分时你会拿到完整 200 条评测集 + 数据飞轮闭环，能给团队建一套真正的工程化评测体系。**为什么这么挑**：评测是一套互相咬合的系统（评测集 → CI → 飞轮 → judge → pass^k），断开任何一环效果都打折。3-4 周对应每周 1 个晚上 + 周末半天的节奏，跟着仓库代码动手做，是把书"内化"成肌肉记忆的最短路径
- **深入源码路线**：每章末「对照 inspect_ai 源码」小节，把书里的 TS 实现指回 inspect_ai 对应的 Python 文件，建立"我写的 200 行 ≈ 人家的哪个文件"的双向地图。**为什么这么挑**：如果你需要给公司搭一套自研评测平台（langfuse / Braintrust 价格太贵或数据合规不允许上云），你需要知道每个核心抽象在生产级框架里是怎么实现的——inspect_ai 是英国 AISI 在评测 Claude / GPT-4 安全性的实际工具，工程质量经过 frontier model lab 验证，是最好的参照系

读完这本书你能干什么：

- 给任何 agent 项目造一套 200 条 L1 + 100 条 L2 + 40 条 L3 评测集（4-6 周工程量）
- 把评测接入 GitHub Actions CI，每个 PR 自动跑 + 显著性检验，30 分钟从 0 接通
- 写出一个跟人工标注 Cohen's Kappa κ ≥ 0.6 的 LLM-as-Judge，policy 维度可信
- 跑数据飞轮把线上日志反哺评测集，每周新增 5-10 条 hard case
- 给老板写一份能站得住脚的"AI Agent 质量报告"——业务指标、可靠性、安全性三个维度都有数据支撑

## 关于书里的几个选择

**为什么是 TypeScript？** 因为 2026 年的应用层 Agent 事实上是 TS 主场——Vercel AI SDK、LangChain.js、Mastra、Bun runtime，这一波生态的工程师都在用 TS。但同领域的权威英文书（Hamel Husain & Shreya Shankar 的 O'Reilly《Evals for AI Engineers》）100% 是 Python 生态。这是我决定写这本书的最直接动因之一——填上这个空白。

**为什么是电商客服场景？** 因为它的评测维度覆盖度最高：多轮对话、工具调用、RAG 检索、policy 约束、不可逆操作、对抗用户全都有。一个场景把所有评测方法都装下，省得你来回切场景上下文。中文电商客服又是国内最普遍的 Agent 落地形态——智能客服市场 2025 年 650 亿+，几乎所有 B2C 公司都在做。从书里学到的方法论可以直接搬到自己公司，不需要转译。

**为什么 ShopAgent 故意保持简化？** 因为读者买这本书是学评测，不是学电商业务。如果把仅退款历史、跨境单、PIPL 合规、黑产对抗都塞进主线，读完会觉得"我得先变成电商专家才能学评测"——这是绝对错误的信号。所以主线版只有 8 工具 + 5 policy，仅覆盖讲清评测维度所需。想深挖业务的读者可以翻附录 D（ShopAgent 扩展版 12 工具）和附录 E（业务知识补充阅读）。

**为什么对照 inspect_ai 源码？** 因为 inspect_ai 是英国 AISI 在做 frontier model safety eval 的事实标准框架，Task / Dataset / Solver / Scorer 四件套已经是行业通用词汇表。读懂它你不只是会用 EvalKit，而是能读懂任何主流评测平台。每章末的「对照源码」小节会标出我们的 TS 实现对应 inspect_ai 的哪个 Python 文件、哪几行，让你建立可迁移的心智模型。

## 配套资源

- **代码仓库**：[github.com/diguike/book-agent-evals](https://github.com/diguike/book-agent-evals)（书的源码、ShopAgent 完整实现、EvalKit 框架增量提交、200 条评测集、CI 配置全部在这里）
- **doctor 脚本**：仓库根 `npm run doctor` 自动检查环境（Node 版本、API key、workspace 配置）。如果它通过了，每章 example 就能直接 `npm run eval` 跑通
- **章节配套数据**：每章 `examples/ch<NN>-<slug>/` 下放当章独立可跑的评测脚本和评测集样本
- **inspect_ai 源码引用**：建议先 `git clone https://github.com/UKGovernmentBEIS/inspect_ai _references/inspect_ai`，书里所有源码引用都按这个相对路径

## 致谢

感谢英国 AISI 团队开源 inspect_ai，让评测框架有了行业事实标准的参照。感谢 Sierra 团队的 τ-bench / τ²-bench / τ³-bench，让 agent eval 范式有了可借鉴的基线。感谢 Hamel Husain 和 Shreya Shankar 公开他们的方法论框架——Three Gulfs、Open-Axial Coding、LLM-as-Judge 7 步法、judgy 统计校正——这本书在方法论层面对他们的工作有大量致敬引用，每一处都注明出处。

感谢和我聊过 agent 评测、踩过同样坑的所有同行。如果这本书帮你少踩几个坑，就值了。

最后，如果你和那个周一的我一样，胃里发紧，盯着监控大屏不知道下一步该怎么走——希望这本书能让你慢慢松一口气。下一次发布前你会有 200 条评测集、CI 守门、pass^k 看可靠性、judge 看 policy 遵守、对抗集看安全。还是会有事故，但你不再是赌博。

—— diguike，2026 年于上海

---

> 本章来自《AI Agent 评测工程实战》开源版 · 作者「递归客」  
> 在线阅读完整书系：[inferloop.dev](https://inferloop.dev) · 反馈与勘误：[GitHub Issues](https://github.com/diguike/book-agent-evals/issues)
