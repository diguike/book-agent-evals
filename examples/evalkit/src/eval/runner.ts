// runTask —— EvalKit 主调度
// ch06 起支持并发；ch15 起支持 epochs（pass^k）；ch19 起支持自适应并发
import { JsonlRecorder } from '../log/jsonl_recorder.js';
import type {
  GenerateFn,
  Sample,
  Score,
  Scorer,
  Solver,
  Task,
  TaskState,
} from '../types.js';
import { createTaskState } from './state.js';
import { defaultGenerate } from '../solver/generate.js';
import { pmap } from '../provider/concurrency.js';

export interface RunOptions {
  model: string;
  outputDir?: string;
  /** 并发上限，默认 1（串行）；ch06 起评测里通常配 4-8 */
  concurrency?: number;
  /** 自定义 GenerateFn（包 agent 框架时常用） */
  generate?: GenerateFn;
  /** 同一 sample 跑几次（pass^k），默认 1 */
  epochs?: number;
  verbose?: boolean;
}

export interface SampleRunResult {
  sampleId: string;
  epoch: number;
  state: TaskState;
  scores: Score[];
  timingMs: number;
}

export interface RunResult {
  taskName: string;
  model: string;
  samples: SampleRunResult[];
  metrics: { accuracy: number; total: number; correct: number };
  startedAt: string;
  completedAt: string;
  logPath: string;
}

async function runOneSampleOneEpoch(
  sample: Sample,
  epoch: number,
  solvers: Solver[],
  scorers: Scorer[],
  generate: GenerateFn,
  task: Task,
): Promise<SampleRunResult> {
  let state = createTaskState(sample, task.config);
  state.epoch = epoch;

  for (const solver of solvers) {
    state = await solver(state, generate);
    if (state.completed) break;
  }

  const scores: Score[] = [];
  for (const scorer of scorers) {
    const t = sample.target ?? '';
    scores.push(await scorer(state, t));
  }

  return {
    sampleId: sample.id,
    epoch,
    state,
    scores,
    timingMs: 0,
  };
}

function formatSampleLine(r: SampleRunResult, epochs: number): string {
  const allPass = r.scores.every((s) => s.value === 'C');
  const mark = allPass ? '✓' : '✗';
  const reasons = r.scores
    .filter((s) => s.value !== 'C' && s.explanation)
    .map((s) => s.explanation as string);
  const tail = reasons.length > 0 ? ` ${reasons.join('; ')}` : '';
  const ep = epochs > 1 ? `[ep${r.epoch}]` : '';
  return `${mark} ${r.sampleId}${ep} (${r.timingMs}ms)${tail}`;
}

export async function runTask(task: Task, opts: RunOptions): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const solvers = Array.isArray(task.solver) ? task.solver : [task.solver];
  const scorers = Array.isArray(task.scorer) ? task.scorer : [task.scorer];
  const generate = opts.generate ?? defaultGenerate(opts.model, task.config);
  const verbose = opts.verbose ?? true;
  const epochs = Math.max(1, opts.epochs ?? task.config?.epochs ?? 1);
  const concurrency = Math.max(1, opts.concurrency ?? 1);

  const recorder = new JsonlRecorder(opts.outputDir ?? 'runs', task.name, opts.model);
  recorder.writeHeader({
    taskName: task.name,
    model: opts.model,
    datasetSize: task.dataset.size,
    startedAt,
    ...(task.metadata ? { metadata: { ...task.metadata, epochs, concurrency } } : { metadata: { epochs, concurrency } }),
  });

  if (verbose) {
    console.log(
      `[evalkit] ${task.name} | model=${opts.model} | n=${task.dataset.size} | epochs=${epochs} | concurrency=${concurrency}`,
    );
  }

  // 把 (sample, epoch) 展开成任务列表
  const jobs: { sample: Sample; epoch: number }[] = [];
  for (const sample of task.dataset.samples) {
    for (let e = 0; e < epochs; e++) {
      jobs.push({ sample, epoch: e });
    }
  }

  const sampleResults = await pmap(jobs, concurrency, async (job) => {
    const t0 = Date.now();
    const result = await runOneSampleOneEpoch(
      job.sample,
      job.epoch,
      solvers,
      scorers,
      generate,
      task,
    );
    result.timingMs = Date.now() - t0;
    recorder.writeSample({
      sampleId: result.sampleId,
      state: result.state,
      scores: result.scores,
      timingMs: result.timingMs,
      epoch: result.epoch,
    });
    if (verbose) console.log(formatSampleLine(result, epochs));
    return result;
  });

  // 汇总：pass^1 = sample 完整对的占比（多 epoch 时，按"任一 epoch 对"算？还是"全 epoch 都对"？
  // 默认按"所有 epoch 都对算 sample 对"也就是 pass^k；ch15 会进一步拆分
  const bySample = new Map<string, SampleRunResult[]>();
  for (const r of sampleResults) {
    const arr = bySample.get(r.sampleId) ?? [];
    arr.push(r);
    bySample.set(r.sampleId, arr);
  }
  let correctSamples = 0;
  for (const [, runs] of bySample) {
    const allPass = runs.every((r) => r.scores.every((s) => s.value === 'C'));
    if (allPass) correctSamples += 1;
  }
  const total = bySample.size;
  const accuracy = total === 0 ? 0 : correctSamples / total;
  const metrics = { accuracy, total, correct: correctSamples };
  const completedAt = new Date().toISOString();

  recorder.writeFooter({ metrics, completedAt });

  if (verbose) {
    console.log(
      `\n[evalkit] ${task.name} pass^${epochs} = ${accuracy.toFixed(3)} (${correctSamples}/${total})`,
    );
    console.log(`[evalkit] log: ${recorder.path}`);
  }

  return {
    taskName: task.name,
    model: opts.model,
    samples: sampleResults,
    metrics,
    startedAt,
    completedAt,
    logPath: recorder.path,
  };
}
