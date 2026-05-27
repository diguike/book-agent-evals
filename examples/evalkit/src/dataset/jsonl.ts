// JSONL 数据集加载器
// 对照 inspect_ai: src/inspect_ai/dataset/_sources/json.py
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Dataset, FieldMap, Sample, Target } from '../types.js';

interface JsonlOpts {
  /** 数据集列名 ↔ Sample 字段映射；默认假设字段名跟 Sample 一致 */
  fieldMap?: FieldMap;
  /** 数据集名字，落到 EvalLog */
  name?: string;
  /** 跳过空行（默认 true） */
  skipBlank?: boolean;
  /** 限制只取前 N 条 */
  limit?: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pickField<T>(row: Record<string, unknown>, primary: string, alias?: string): T | undefined {
  if (alias && alias in row) return row[alias] as T;
  if (primary in row) return row[primary] as T;
  return undefined;
}

/** 把任意一行 JSON 转成 Sample */
export function rowToSample(row: Record<string, unknown>, fieldMap: FieldMap = {}, index = 0): Sample {
  const idRaw = pickField<string | number>(row, 'id', fieldMap.id);
  const id = idRaw !== undefined ? String(idRaw) : `sample-${index}`;

  const input = pickField<Sample['input']>(row, 'input', fieldMap.input);
  if (input === undefined) {
    throw new Error(`Sample ${id} 缺少 input 字段（fieldMap.input=${fieldMap.input ?? 'input'}）`);
  }

  const target = pickField<Target>(row, 'target', fieldMap.target);

  // metadata 的解析逻辑：
  // 1. 如果 fieldMap.metadata 显式指向某列，用那一列作为 metadata 字典
  // 2. 否则用 row 里除 id/input/target 外的所有键作为 metadata
  let metadata: Record<string, unknown> | undefined;
  if (fieldMap.metadata) {
    const m = row[fieldMap.metadata];
    if (isPlainObject(m)) metadata = m;
  } else {
    const reservedKeys = new Set<string>(['id', 'input', 'target', fieldMap.id, fieldMap.input, fieldMap.target].filter(Boolean) as string[]);
    const remaining: Record<string, unknown> = {};
    let hasAny = false;
    for (const [k, v] of Object.entries(row)) {
      if (reservedKeys.has(k)) continue;
      remaining[k] = v;
      hasAny = true;
    }
    metadata = hasAny ? remaining : undefined;
  }

  const sample: Sample = { id, input };
  if (target !== undefined) sample.target = target;
  if (metadata !== undefined) sample.metadata = metadata;
  return sample;
}

export function jsonlDataset(path: string, opts: JsonlOpts = {}): Dataset {
  const absPath = resolve(path);
  const raw = readFileSync(absPath, 'utf-8');
  const skipBlank = opts.skipBlank ?? true;

  const samples: Sample[] = [];
  let lineNo = 0;
  for (const rawLine of raw.split('\n')) {
    lineNo += 1;
    const line = rawLine.trim();
    if (!line) {
      if (skipBlank) continue;
      throw new Error(`${path}:${lineNo} 空行（关 skipBlank 后不允许）`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`${path}:${lineNo} JSON 解析失败：${(err as Error).message}`);
    }
    if (!isPlainObject(parsed)) {
      throw new Error(`${path}:${lineNo} 顶层必须是对象`);
    }
    samples.push(rowToSample(parsed, opts.fieldMap, samples.length));
    if (opts.limit && samples.length >= opts.limit) break;
  }

  return {
    name: opts.name ?? path,
    samples,
    size: samples.length,
  };
}
