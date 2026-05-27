// Elo —— ch14：pairwise 比较的在线版（Chatbot Arena 同款）
// 每场比较实时更新两个模型的分；不需要先攒满矩阵

export interface EloOpts {
  /** 初始分，默认 1000 */
  initial?: number;
  /** K 因子，默认 32（高=反应快但抖动大） */
  k?: number;
}

export class EloRating {
  private scores: Map<string, number>;
  private readonly initial: number;
  private readonly k: number;

  constructor(opts: EloOpts = {}) {
    this.initial = opts.initial ?? 1000;
    this.k = opts.k ?? 32;
    this.scores = new Map();
  }

  get(name: string): number {
    if (!this.scores.has(name)) this.scores.set(name, this.initial);
    return this.scores.get(name) as number;
  }

  /** A vs B，winner='A'|'B'|'TIE' */
  update(a: string, b: string, winner: 'A' | 'B' | 'TIE'): void {
    const ra = this.get(a);
    const rb = this.get(b);
    const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
    const eb = 1 - ea;
    const sa = winner === 'A' ? 1 : winner === 'B' ? 0 : 0.5;
    const sb = 1 - sa;
    this.scores.set(a, ra + this.k * (sa - ea));
    this.scores.set(b, rb + this.k * (sb - eb));
  }

  ranking(): { model: string; score: number }[] {
    return Array.from(this.scores.entries())
      .map(([model, score]) => ({ model, score }))
      .sort((a, b) => b.score - a.score);
  }
}
