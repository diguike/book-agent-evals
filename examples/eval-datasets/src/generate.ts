// 跑这个脚本生成 4 个 jsonl 文件
// cd examples/eval-datasets && npm run generate
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateL1 } from './gen_l1.js';
import { generateL2 } from './gen_l2.js';
import { generateL3 } from './gen_l3.js';
import { generateRag } from './gen_rag.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function writeJsonl(path: string, items: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = items.map((it) => JSON.stringify(it));
  writeFileSync(path, lines.join('\n') + '\n');
  console.log(`[gen] ${path}：${items.length} 条`);
}

function main(): void {
  writeJsonl(resolve(root, 'l1/v2.0.0.jsonl'), generateL1());
  writeJsonl(resolve(root, 'l2/v2.0.0.jsonl'), generateL2());
  writeJsonl(resolve(root, 'l3/v1.0.0.jsonl'), generateL3());
  writeJsonl(resolve(root, 'rag/v1.0.0.jsonl'), generateRag());
}

main();
