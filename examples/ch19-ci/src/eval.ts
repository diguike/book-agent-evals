// ch19 demo —— CI 守门：跑两次评测当 baseline / candidate，对比
// 这个 demo 不真跑评测（避免双倍 token 消耗），假设用户已经有两份 jsonl
// 用法：npm run eval -- baseline.jsonl candidate.jsonl
import { ciCli } from '@inferloop/evalkit/cli/ci';

const [, , baseline, candidate] = process.argv;
if (!baseline || !candidate) {
  console.log('[ch19] 用法：npx tsx src/eval.ts <baseline.jsonl> <candidate.jsonl>');
  console.log('       或：npx evalkit ci <baseline> <candidate> --regression-threshold 0');
  process.exit(0);
}

ciCli(baseline, candidate, {
  regressionThreshold: parseInt(process.env.MAX_REGRESSION ?? '0', 10),
  accuracyDropThreshold: parseFloat(process.env.MAX_ACC_DROP ?? '0.02'),
});
