#!/usr/bin/env node
// `evalkit` 命令入口
import { Command } from 'commander';
import { runCli } from './run.js';
import { viewCli } from './view.js';
import { diffCli } from './diff.js';
import { listCli } from './list.js';
import { ciCli } from './ci.js';

const program = new Command();
program.name('evalkit').description('EvalKit —— 书中教学用的评测脚手架').version('0.1.0');

program
  .command('run <task-file>')
  .description('跑一个 task 文件，输出 JSONL 日志')
  .option('-m, --model <model>', '模型名，默认环境变量 MODEL 或 gpt-4o')
  .option('-o, --output-dir <dir>', '日志输出目录，默认 runs/')
  .option('-q, --quiet', '不打印每条 sample 的实时进度', false)
  .action(
    async (
      taskFile: string,
      opts: { model?: string; outputDir?: string; quiet?: boolean },
    ) => {
      await runCli(taskFile, {
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.outputDir ? { outputDir: opts.outputDir } : {}),
        verbose: !opts.quiet,
      });
    },
  );

program
  .command('view <log>')
  .description('打印一份 JSONL 日志的汇总')
  .option('-s, --sample <id>', '只看某个 sample')
  .option('-f, --failed-only', '只看失败的 sample', false)
  .option('-t, --trajectory', '打印每条 sample 的 trajectory', false)
  .option('-n, --limit <n>', '只打印前 N 条', (v) => parseInt(v, 10))
  .action(
    (
      log: string,
      opts: { sample?: string; failedOnly?: boolean; trajectory?: boolean; limit?: number },
    ) => {
      viewCli(log, {
        ...(opts.sample ? { sample: opts.sample } : {}),
        failedOnly: opts.failedOnly ?? false,
        trajectory: opts.trajectory ?? false,
        ...(opts.limit ? { limit: opts.limit } : {}),
      });
    },
  );

program
  .command('diff <baseline> <candidate>')
  .description('对比两份日志，列出 regression / improvement')
  .option('-t, --trajectory', '打印 regression 的 trajectory 对比', false)
  .option('-r, --regression-only', '只打印 regression（不打 improvement）', false)
  .action(
    (
      baseline: string,
      candidate: string,
      opts: { trajectory?: boolean; regressionOnly?: boolean },
    ) => {
      diffCli(baseline, candidate, {
        showTrajectory: opts.trajectory ?? false,
        regressionOnly: opts.regressionOnly ?? false,
      });
    },
  );

program
  .command('list [dir]')
  .description('列出目录下所有 jsonl 日志（按时间倒序）')
  .action((dir?: string) => {
    listCli(dir ?? 'runs');
  });

program
  .command('ci <baseline> <candidate>')
  .description('CI 守门：对比两份日志，回归超阈值或显著退化时 exit 1')
  .option('--regression-threshold <n>', '允许的最大 regression 条数', (v) => parseInt(v, 10), 0)
  .option('--accuracy-drop <f>', '允许的最大 accuracy 下降', (v) => parseFloat(v), 0.02)
  .option('--no-significance', '关掉 McNemar 显著性检验')
  .option('--p-value <f>', 'McNemar p 阈值', (v) => parseFloat(v), 0.05)
  .action(
    (
      baseline: string,
      candidate: string,
      opts: {
        regressionThreshold: number;
        accuracyDrop: number;
        significance: boolean;
        pValue: number;
      },
    ) => {
      ciCli(baseline, candidate, {
        regressionThreshold: opts.regressionThreshold,
        accuracyDropThreshold: opts.accuracyDrop,
        significance: opts.significance,
        pValueThreshold: opts.pValue,
      });
    },
  );

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});
