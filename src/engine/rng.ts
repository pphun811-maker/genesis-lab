/**
 * 种子化伪随机数生成器（mulberry32）。
 *
 * 确定性要求：所有随机性都必须经过本类，且只使用 IEEE 754 严格规定的
 * 运算（+、-、*、/、sqrt），不使用 Math.sin/cos/exp/log/pow/hypot 等
 * 允许实现差异的函数，保证同状态在任何 JS 引擎上产生完全相同的序列。
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** 返回 [0, 1) 均匀分布 */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 返回 [min, max) 均匀分布 */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** 返回 [0, n) 的整数 */
  int(n: number): number {
    return (this.next() * n) | 0;
  }

  /** 以概率 p 返回 true */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /**
   * 近似标准正态分布：3 个均匀变量之和的平移缩放（Irwin–Hall）。
   * 值域 (-3, 3)，标准差 1，只使用算术运算。
   */
  gauss(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 2;
  }

  /** 单位圆内均匀采样的偏移（拒绝法，只用算术与平方根） */
  disc(radius: number): [number, number] {
    for (;;) {
      const x = this.range(-radius, radius);
      const y = this.range(-radius, radius);
      if (x * x + y * y <= radius * radius) return [x, y];
    }
  }

  /** 均匀方向单位向量 */
  direction(): [number, number] {
    // 均匀圆盘采样后归一化，避免三角函数
    let x = 0;
    let y = 0;
    let len2 = 0;
    do {
      x = this.range(-1, 1);
      y = this.range(-1, 1);
      len2 = x * x + y * y;
    } while (len2 > 1 || len2 < 1e-6);
    const inv = 1 / Math.sqrt(len2);
    return [x * inv, y * inv];
  }

  get state(): number {
    return this.s >>> 0;
  }

  set state(v: number) {
    this.s = v >>> 0;
  }
}
