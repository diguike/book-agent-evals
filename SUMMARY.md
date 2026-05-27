# SUMMARY

全书 20 章正文 + 5 附录，章节即文件平铺在 `book/` 下。

## 前言

- [前言](book/00-preface.md)

## 第一部分　基础与快速上手

- [第 1 章 评测金字塔与 ShopAgent 速览](book/01-eval-pyramid-and-shopagent.md)
- [第 2 章 Hello World 评测](book/02-hello-world-eval.md)
- [第 3 章 EvalKit 骨架 v1](book/03-evalkit-skeleton.md)

## 第二部分　评测集 v1：动手造

- [第 4 章 评测集种子构造（招牌菜 1A）](book/04-eval-dataset-seed.md)
- [第 5 章 错误分析：Open-Axial Coding](book/05-error-analysis.md)

## 第三部分　EvalKit 进阶

- [第 6 章 Provider 抽象与并发](book/06-provider-and-concurrency.md)
- [第 7 章 EvalLog 设计与跨 run 对比](book/07-evallog-and-view-diff.md)
- [第 8 章 RAG 子模块评测](book/08-rag-evaluation.md)
- [第 9 章 用户模拟器构造](book/09-user-simulator.md)
- [第 10 章 Multi-turn 多轮评测](book/10-multi-turn-eval.md)

## 第四部分　Agent 评测核心维度

- [第 11 章 Trajectory 与 DB state delta](book/11-trajectory-and-state.md)
- [第 12 章 Tool-use 评测](book/12-tool-use-eval.md)
- [第 13 章 LLM-as-Judge 入门](book/13-llm-as-judge-basics.md)
- [第 14 章 Judge 校准与统计推断](book/14-judge-calibration.md)
- [第 15 章 pass^k 可靠性与一致性](book/15-pass-k-consistency.md)
- [第 16 章 Red Team 与 Safety](book/16-red-team-and-safety.md)

## 第五部分　数据飞轮与工程化

- [第 17 章 评测集 v2 扩到 200 条（招牌菜 1B）](book/17-eval-dataset-v2.md)
- [第 18 章 数据飞轮（招牌菜 2）](book/18-data-flywheel.md)
- [第 19 章 CI 集成与回归守门](book/19-ci-and-regression.md)
- [第 20 章 Dashboard 与上生产桥梁](book/20-dashboard-and-production.md)

## 附录

- [附录 A 模型评测进阶](book/appendix-a-model-eval.md)
- [附录 B 多 Agent 评测](book/appendix-b-multi-agent.md)
- [附录 C 与业务指标对齐](book/appendix-c-business-metrics.md)
- [附录 D ShopAgent 扩展版](book/appendix-d-shopagent-extended.md)
- [附录 E 业务知识补充阅读](book/appendix-e-business-context.md)
