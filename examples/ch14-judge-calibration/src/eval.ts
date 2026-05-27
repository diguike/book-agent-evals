// ch14 demo —— judge 校准：跟"人类标注"对比，算 Cohen's kappa + judgy 偏置
import { cohensKappa, judgy } from '@inferloop/evalkit';

// mock 数据：假设人类标了 30 条
const humanLabels: ('C' | 'I')[] = [
  'C','C','I','C','C','I','I','C','C','C',
  'I','C','C','I','C','C','I','C','C','I',
  'C','C','C','I','C','I','C','C','C','I',
];
// judge 模型的标注（部分偏 false positive）
const judgeLabels: ('C' | 'I')[] = [
  'C','C','I','C','C','C','I','C','C','C',
  'C','C','C','I','C','C','I','C','C','I',
  'C','C','C','C','C','I','C','C','C','C',
];

const kappa = cohensKappa({
  rater1: humanLabels as unknown as string[],
  rater2: judgeLabels as unknown as string[],
});
console.log('[ch14] Cohen\'s kappa: ' + kappa.kappa.toFixed(3));
console.log('  observed agreement: ' + kappa.agreement.toFixed(3));
console.log('  expected agreement: ' + kappa.expectedAgreement.toFixed(3));
console.log('  n: ' + kappa.n);

const jResult = judgy({ truth: humanLabels, judge: judgeLabels });
console.log('\n[ch14] Judgy: TPR=' + jResult.tpr.toFixed(3) + ' TNR=' + jResult.tnr.toFixed(3));
console.log('  balanced accuracy: ' + jResult.balancedAccuracy.toFixed(3));
console.log('  raw accuracy: ' + jResult.accuracy.toFixed(3));
console.log('  confusion: ' + JSON.stringify(jResult.confusion));

// 解读：
if (kappa.kappa < 0.4) console.log('\n[ch14] kappa 太低，judge 不够一致，不要直接用');
else if (kappa.kappa < 0.6) console.log('\n[ch14] kappa 中等，judge 有用但需结合人工抽检');
else if (kappa.kappa < 0.8) console.log('\n[ch14] kappa 较强，judge 可用');
else console.log('\n[ch14] kappa 极强，judge 接近人类水平');

if (jResult.tpr < 0.7) console.log('[ch14] TPR < 0.7：judge 漏掉太多正例（false negative 多）');
if (jResult.tnr < 0.7) console.log('[ch14] TNR < 0.7：judge 误判太多（false positive 多）');
