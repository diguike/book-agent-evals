# AI Agent 评测工程实战 —— 从 0 用 TypeScript 构建你的评测平台

> 评测工具如何构造、评测数据如何构造、评测标准是什么、评测流程如何落地。一本只讲评测的书。

## 这本书解决什么问题

每个做 AI Agent 的工程师都遇到过同一个问题：写完一版 agent / skill，**没有现成的数据去验证它的效果是否稳定、是否比上一版有所提升**。改一行 prompt 不敢上线，换一个模型不敢换。问题不在于不知道有 evaluation 这件事，而在于没有一套端到端可落地的评测体系——既缺评测集，也缺评测方法论，更缺把它们串起来的工程实现。

这本书带你跟着把一套完整的评测体系从 0 长出来：

- **EvalKit** — 一个用 TypeScript 写的轻量级 AI Agent 评测框架，对标 UK AISI 的 [inspect_ai](https://github.com/UKGovernmentBEIS/inspect_ai) 但只保留教学必要的核心抽象。**第 2 章末就能跑出第一个评测真实数字**，读者跟着书一章一章把它完善，最终拥有一套可在生产使用的 Agent 评测框架
- **200 条评测集 + 用户模拟器 + LLM-as-Judge + CI 集成 + 极简 Dashboard**——评测体系的全套零件，每一件都跟着书的章节做出来。评测集分两段构造：第二部分先造 60 条 L1 种子集，第五部分扩充到 200 条 + 数据飞轮

被评测的对象是 **ShopAgent** —— 一个电商售后客服 Agent，仓库里已经写好。本书**不讲它怎么开发**，只把它当作"现成的被评测样本"。它故意保持简化（8 个工具 + 5 条 policy），读者不需要先学懂电商业务就能开始评测。想玩深度评测的读者可以用仓库 `examples/shopagent-extended/` 里的 12 工具进阶版。

读完后，你能把这套评测框架和方法论直接搬到自己公司的 Agent 项目上。

## 这本书覆盖什么

按重要性分三层：

| 层级 | 占比 | 内容 |
|------|------|------|
| Agent 评测 | 80% | 任务完成率、trajectory、tool-use、multi-turn、judge、pass^k、safety、CI 回归 |
| 模型评测基础 | 15% | OpenCompass / lm-evaluation-harness，给模型选型做横评 |
| 产品评测 | 5% | Agent 评测指标怎么映射到 CSAT / 转化率等业务指标（附录） |

**重点章节**：数据集构造和数据飞轮单独拎出两章重点讲——回到工程师的根本痛点：评测集到底从哪里来？

## 这本书不覆盖什么

- **Agent 开发本身**——ShopAgent 仓库里已经写好，本书不介绍它怎么搭。Agent 工程请看作者其他书：《Hermes Agent 源码解读》《OpenClaw 源码解析》《百万级 AI Agent 平台架构》《Agent Memory 工程实战》
- 模型预训练 / 后训练 / RLHF / DPO 的 reward modeling 内部机制
- LLM 基础推理引擎实现
- Agent 编排框架本身的设计（LangGraph / CrewAI 已有专书）
- Prompt 工程入门（默认读者已会）

## 怎么读这本书

- **快速上手路线**（5-7 天）：第一部分（基础与快速上手）3 章 → 第二部分（评测集种子构造）2 章，读到这里你已经有 60 条评测集 + 能直接跑的 EvalKit 可以回公司用
- **系统学习路线**（3-4 周）：按章节顺序读，每章动手做配套 example。读到第五部分时拿到完整 200 条评测集 + 数据飞轮闭环
- **深入源码路线**：每章末「对照 inspect_ai 源码」小节，把书里的 TS 实现指回 inspect_ai 对应文件，建立双向地图

## 目录

全书 20 章正文 + 5 附录。点击章节标题直接跳转。

**前言**

- [前言](book/00-preface.md)

**第一部分　基础与快速上手**

- [第 1 章　评测金字塔与 ShopAgent 接口](book/01-eval-pyramid-and-shopagent.md)
- [第 2 章　跑通第一个评测](book/02-hello-world-eval.md)
- [第 3 章　搭建 EvalKit 评测框架](book/03-evalkit-skeleton.md)

**第二部分　从 0 构建评测集**

- [第 4 章　构建评测集种子（60 条 L1）](book/04-eval-dataset-seed.md)
- [第 5 章　错误分析与失败模式归类](book/05-error-analysis.md)

**第三部分　EvalKit 进阶**

- [第 6 章　Provider 抽象与并发调度](book/06-provider-and-concurrency.md)
- [第 7 章　EvalLog 设计与跨次结果对比](book/07-evallog-and-view-diff.md)
- [第 8 章　RAG 子模块评测](book/08-rag-evaluation.md)
- [第 9 章　用户行为模拟器](book/09-user-simulator.md)
- [第 10 章　多轮对话评测](book/10-multi-turn-eval.md)

**第四部分　Agent 评测核心维度**

- [第 11 章　调用轨迹与数据库状态校验](book/11-trajectory-and-state.md)
- [第 12 章　工具调用评测](book/12-tool-use-eval.md)
- [第 13 章　搭建 LLM-as-Judge 评判器](book/13-llm-as-judge-basics.md)
- [第 14 章　Judge 校准与显著性检验](book/14-judge-calibration.md)
- [第 15 章　pass^k 与多次运行稳定性](book/15-pass-k-consistency.md)
- [第 16 章　Red Team 与安全评测](book/16-red-team-and-safety.md)

**第五部分　数据飞轮与工程化**

- [第 17 章　评测集扩充到 200 条](book/17-eval-dataset-v2.md)
- [第 18 章　数据飞轮：线上日志反哺评测集](book/18-data-flywheel.md)
- [第 19 章　CI 集成与回归守门](book/19-ci-and-regression.md)
- [第 20 章　Dashboard 与生产部署](book/20-dashboard-and-production.md)

**附录**

- [附录 A　模型评测进阶](book/appendix-a-model-eval.md)
- [附录 B　多 Agent 评测](book/appendix-b-multi-agent.md)
- [附录 C　与业务指标对齐](book/appendix-c-business-metrics.md)
- [附录 D　ShopAgent 扩展版](book/appendix-d-shopagent-extended.md)
- [附录 E　业务知识补充阅读](book/appendix-e-business-context.md)

## 配套仓库

- 本书源码 + 评测数据集 + ShopAgent 实现，全部在仓库 `examples/` 下
- EvalKit 框架增量提交，每一章对应一次 commit，可 git log 看演进
- 配套 GitHub Actions CI，读者 fork 后可直接看到评测在 CI 中运行的样子

## 没 API Key 也能跑 —— mock LLM server

如果你订了 Claude Code Max plan 但没有 OpenAI / Anthropic API key，仓库提供了一个把 Claude Code CLI 包装成 OpenAI 兼容 API 的 mock server：

```bash
# 终端 1：起 mock server（用你的 Max 配额跑后端）
cd examples/mock-llm-server && npm run start

# 终端 2：评测脚本指向 mock
cd examples/ch02-hello-world
OPENAI_BASE_URL=http://localhost:3030/v1 OPENAI_API_KEY=mock npm run eval
```

详见 [`examples/mock-llm-server/README.md`](examples/mock-llm-server/README.md)。

要跑真实评测数字，把 `OPENAI_BASE_URL` 指向任一 OpenAI 兼容端点即可，国内可用[阿里云百炼](https://www.aliyun.com/benefit/ai/aistar?userCode=okjhlpr5)。全量回归很烧 token，建议排到夜里跑——[百炼的 Credits 抵扣计划](https://www.aliyun.com/benefit/client/cross?userCode=okjhlpr5)在 22:00–08:00 时段有折扣。

## 关于作者

[diguike](https://github.com/diguike) — Agent 工程师，全栈工程师出身，做 Agent 自进化、长程 Agent、AI 资产建设与团队 AI 体系搭建。AI Agent 工程系列作者，相关书籍：

- 《Hermes Agent 源码解读》
- 《OpenClaw 源码解析》
- 《Agent Memory 工程实战》
- 《AI Token 中转站实战》
- 《百万级 AI Agent 平台架构》
