# @inferloop/evalkit

书中教学用的评测脚手架，从第 3 章 v1 骨架开始演进，每章在仓库的一次有意义 commit 上长出新模块。

不是产品，不在 npm 发布。读者通过 npm workspaces 直接引用本地源码。

配套书：见 `book/03-evalkit-skeleton.md` 及后续各章。

## 模块导航

| 章节 | 模块 |
|---|---|
| ch03 | `types` / `dataset` / `solver` / `scorer` / `eval` / `log` 骨架 |
| ch06 | `provider/` 真实 LLM 调用 + 并发池 + cache |
| ch07 | `log/` Zod schema + `cli view/diff` 真实实现 |
| ch08 | `scorer/rag/` |
| ch09 | `solver/user_simulator.ts` |
| ch10 | `solver/multi_turn.ts` + `scorer/session_*` |
| ch11 | `scorer/trajectory_*` |
| ch12 | `scorer/tool_use/*` |
| ch13-14 | `scorer/judge/*` + `stats/*` |
| ch15 | `eval/multi_trial.ts` |
| ch19 | `cli/ci.ts` + 自适应并发 |

## 跑

```bash
npm install     # 在仓库根
npm run build -w @inferloop/evalkit
```
