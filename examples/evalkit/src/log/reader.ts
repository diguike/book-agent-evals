// EvalLog 读取 —— ch07 引入；view / diff / list CLI 用
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  LogEntrySchema,
  type LogEntry,
  type HeaderEntry,
  type SampleEntry,
  type FooterEntry,
} from './schema.js';

export interface ParsedLog {
  header: HeaderEntry;
  samples: SampleEntry[];
  footer?: FooterEntry;
}

export function parseLog(path: string): ParsedLog {
  const abs = resolve(path);
  const lines = readFileSync(abs, 'utf-8').trim().split('\n');
  let header: HeaderEntry | undefined;
  let footer: FooterEntry | undefined;
  const samples: SampleEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (err) {
      throw new Error(`${path}:${i + 1} JSON parse 失败：${(err as Error).message}`);
    }
    const parsed = LogEntrySchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`${path}:${i + 1} schema 校验失败：${parsed.error.message}`);
    }
    const entry: LogEntry = parsed.data;
    if (entry.type === 'header') header = entry;
    else if (entry.type === 'sample') samples.push(entry);
    else if (entry.type === 'footer') footer = entry;
  }

  if (!header) throw new Error(`${path} 缺少 header`);
  return { header, samples, ...(footer ? { footer } : {}) };
}

export interface LogFileInfo {
  path: string;
  taskName: string;
  model: string;
  mtime: Date;
  sampleCount: number;
  accuracy?: number;
}

/** 列出目录下所有 .jsonl 日志，按 mtime 倒序 */
export function listLogs(dir: string): LogFileInfo[] {
  const abs = resolve(dir);
  const out: LogFileInfo[] = [];
  for (const name of readdirSync(abs)) {
    if (!name.endsWith('.jsonl')) continue;
    const full = join(abs, name);
    const stat = statSync(full);
    try {
      const log = parseLog(full);
      out.push({
        path: full,
        taskName: log.header.taskName,
        model: log.header.model,
        mtime: stat.mtime,
        sampleCount: log.samples.length,
        ...(log.footer ? { accuracy: log.footer.metrics.accuracy } : {}),
      });
    } catch {
      // 解析失败的日志跳过
    }
  }
  out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return out;
}
