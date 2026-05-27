// 同一份种子化 RNG，让数据集生成结果可复现
export class Rng {
  private state: number;
  constructor(seed = 42) {
    this.state = seed;
  }
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x;
    return Math.abs(x) / 2 ** 31;
  }
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
  pick<T>(arr: T[]): T {
    return arr[this.int(0, arr.length - 1)] as T;
  }
}
