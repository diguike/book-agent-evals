// CSV 数据集加载器 —— 极简实现，只支持标准 CSV（带表头 / 双引号转义）
// 不支持嵌套对象（CSV 天生不擅长）。target 是 JSON 时填字符串，loader 不做 deserialize
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Dataset, FieldMap, Sample } from '../types.js';
import { rowToSample } from './jsonl.js';

interface CsvOpts {
  fieldMap?: FieldMap;
  name?: string;
  limit?: number;
  /** 分隔符，默认 ',' */
  delimiter?: string;
}

/** 解析一行 CSV：处理双引号包裹和转义 */
function parseCsvLine(line: string, delim: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          // 转义的双引号
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === delim) {
        cells.push(cur);
        cur = '';
      } else if (ch === '"' && cur === '') {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  cells.push(cur);
  return cells;
}

export function csvDataset(path: string, opts: CsvOpts = {}): Dataset {
  const absPath = resolve(path);
  const raw = readFileSync(absPath, 'utf-8');
  const delim = opts.delimiter ?? ',';
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { name: opts.name ?? path, samples: [], size: 0 };
  }
  const header = parseCsvLine(lines[0]!, delim);

  const samples: Sample[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]!, delim);
    const row: Record<string, unknown> = {};
    for (let c = 0; c < header.length; c++) {
      row[header[c]!] = cells[c] ?? '';
    }
    samples.push(rowToSample(row, opts.fieldMap, samples.length));
    if (opts.limit && samples.length >= opts.limit) break;
  }

  return { name: opts.name ?? path, samples, size: samples.length };
}
