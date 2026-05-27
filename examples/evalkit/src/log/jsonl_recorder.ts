// JSONL 流式日志写入器 —— 每跑完一条 sample 立刻落盘，挂了不丢已跑数据
// 对照 inspect_ai: src/inspect_ai/log/_recorders/json.py (lazy-write)
//
// 文件格式（JSONL）：
//   第 1 行：{type: 'header', ...}
//   第 2..N 行：{type: 'sample', ...}
//   最后 1 行：{type: 'footer', ...}
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import type { TaskState, Score } from '../types.js';

export interface JsonlHeader {
  type: 'header';
  taskName: string;
  model: string;
  datasetSize: number;
  startedAt: string;
  metadata?: Record<string, unknown>;
}

export interface JsonlSampleEntry {
  type: 'sample';
  sampleId: string;
  /** ch15 起：同一 sample 多次跑（pass^k）用 epoch 区分 */
  epoch?: number;
  scores: Score[];
  timingMs: number;
  /** 跑完后的最终 messages */
  messages: TaskState['messages'];
  /** 工具调用序列 */
  toolCalls: TaskState['toolCalls'];
  /** 模型最终输出 */
  output?: TaskState['output'];
  metadata?: Record<string, unknown>;
}

export interface JsonlFooter {
  type: 'footer';
  metrics: Record<string, number>;
  completedAt: string;
}

export interface SampleRunResult {
  sampleId: string;
  state: TaskState;
  scores: Score[];
  timingMs: number;
  epoch?: number;
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export class JsonlRecorder {
  readonly path: string;

  constructor(outputDir: string, taskName: string, model: string) {
    const absDir = resolve(outputDir);
    if (!existsSync(absDir)) mkdirSync(absDir, { recursive: true });
    const fname = `${timestampSlug()}_${taskName}_${model}.jsonl`;
    this.path = join(absDir, fname);
  }

  writeHeader(header: Omit<JsonlHeader, 'type'>): void {
    const entry: JsonlHeader = { type: 'header', ...header };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(entry) + '\n');
  }

  writeSample(result: SampleRunResult): void {
    const entry: JsonlSampleEntry = {
      type: 'sample',
      sampleId: result.sampleId,
      ...(result.epoch !== undefined ? { epoch: result.epoch } : {}),
      scores: result.scores,
      timingMs: result.timingMs,
      messages: result.state.messages,
      toolCalls: result.state.toolCalls,
      ...(result.state.output ? { output: result.state.output } : {}),
      ...(Object.keys(result.state.metadata).length > 0
        ? { metadata: result.state.metadata }
        : {}),
    };
    appendFileSync(this.path, JSON.stringify(entry) + '\n');
  }

  writeFooter(footer: Omit<JsonlFooter, 'type'>): void {
    const entry: JsonlFooter = { type: 'footer', ...footer };
    appendFileSync(this.path, JSON.stringify(entry) + '\n');
  }
}
