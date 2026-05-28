# SUMMARY

全书 20 章正文 + 5 附录，章节即文件平铺在 `book/` 下。

## 前言

- [前言](book/00-preface.md)

## 第一部分　基础与快速上手

- [第 1 章　评测金字塔与 ShopAgent 接口](book/01-eval-pyramid-and-shopagent.md)
- [第 2 章　跑通第一个评测](book/02-hello-world-eval.md)
- [第 3 章　搭建 EvalKit 评测框架](book/03-evalkit-skeleton.md)

## 第二部分　从 0 构建评测集

- [第 4 章　构建评测集种子（60 条 L1）](book/04-eval-dataset-seed.md)
- [第 5 章　错误分析与失败模式归类](book/05-error-analysis.md)

## 第三部分　EvalKit 进阶

- [第 6 章　Provider 抽象与并发调度](book/06-provider-and-concurrency.md)
- [第 7 章　EvalLog 设计与跨次结果对比](book/07-evallog-and-view-diff.md)
- [第 8 章　RAG 子模块评测](book/08-rag-evaluation.md)
- [第 9 章　用户行为模拟器](book/09-user-simulator.md)
- [第 10 章　多轮对话评测](book/10-multi-turn-eval.md)

## 第四部分　Agent 评测核心维度

- [第 11 章　调用轨迹与数据库状态校验](book/11-trajectory-and-state.md)
- [第 12 章　工具调用评测](book/12-tool-use-eval.md)
- [第 13 章　搭建 LLM-as-Judge 评判器](book/13-llm-as-judge-basics.md)
- [第 14 章　Judge 校准与显著性检验](book/14-judge-calibration.md)
- [第 15 章　pass^k 与多次运行稳定性](book/15-pass-k-consistency.md)
- [第 16 章　Red Team 与安全评测](book/16-red-team-and-safety.md)

## 第五部分　数据飞轮与工程化

- [第 17 章　评测集扩充到 200 条](book/17-eval-dataset-v2.md)
- [第 18 章　数据飞轮：线上日志反哺评测集](book/18-data-flywheel.md)
- [第 19 章　CI 集成与回归守门](book/19-ci-and-regression.md)
- [第 20 章　Dashboard 与生产部署](book/20-dashboard-and-production.md)

## 附录

- [附录 A　模型评测进阶](book/appendix-a-model-eval.md)
- [附录 B　多 Agent 评测](book/appendix-b-multi-agent.md)
- [附录 C　与业务指标对齐](book/appendix-c-business-metrics.md)
- [附录 D　ShopAgent 扩展版](book/appendix-d-shopagent-extended.md)
- [附录 E　业务知识补充阅读](book/appendix-e-business-context.md)
