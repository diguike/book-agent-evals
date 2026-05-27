// `evalkit run <task-file>` —— tsx 加载 task 文件，调 runTask
// 用法：evalkit run path/to/eval.task.ts --model gpt-4o
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { runTask } from '../eval/runner.js';
import type { Task } from '../types.js';

interface RunCliOpts {
  model?: string;
  outputDir?: string;
  verbose?: boolean;
}

function isTask(v: unknown): v is Task {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Task).name === 'string' &&
    'dataset' in v &&
    'solver' in v &&
    'scorer' in v
  );
}

export async function runCli(taskFile: string, opts: RunCliOpts): Promise<void> {
  const abs = resolve(taskFile);
  if (!existsSync(abs)) {
    console.error(`[evalkit run] task 文件不存在：${abs}`);
    process.exit(1);
  }

  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  const task = mod.default ?? mod.task ?? Object.values(mod).find(isTask);
  if (!isTask(task)) {
    console.error(`[evalkit run] ${taskFile} 没有导出 Task（用 export default 或 export const task = defineTask(...)）`);
    process.exit(1);
  }

  await runTask(task, {
    model: opts.model ?? process.env.MODEL ?? 'gpt-4o',
    outputDir: opts.outputDir ?? process.env.EVALKIT_RUNS_DIR ?? 'runs',
    verbose: opts.verbose ?? true,
  });
}
