import type { Agent } from './types';

/**
 * 空间哈希：固定桶网格，用于感知范围内的邻居查询。
 * 每 tick 重建。桶边长 10 格；查询半径 ≤ 20 时最多扫 2 圈。
 */
export class SpatialHash {
  private readonly bw: number;
  private readonly bh: number;
  private readonly buckets: Agent[][];

  constructor(
    readonly bucketSize: number,
    worldWidth: number,
    worldHeight: number,
  ) {
    this.bw = Math.ceil(worldWidth / bucketSize);
    this.bh = Math.ceil(worldHeight / bucketSize);
    this.buckets = new Array(this.bw * this.bh);
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i] = [];
  }

  clear(): void {
    for (const b of this.buckets) b.length = 0;
  }

  insert(a: Agent): void {
    const bx = Math.min(this.bw - 1, Math.max(0, (a.x / this.bucketSize) | 0));
    const by = Math.min(this.bh - 1, Math.max(0, (a.y / this.bucketSize) | 0));
    this.buckets[by * this.bw + bx].push(a);
  }

  /**
   * 遍历以 (x, y) 为圆心、半径 r 内所有桶中的个体（含少量超出圆周者，
   * 由调用方按距离过滤）。不保证按距离排序。
   */
  forEachNear(x: number, y: number, r: number, fn: (a: Agent) => void): void {
    const bx0 = Math.max(0, ((x - r) / this.bucketSize) | 0);
    const bx1 = Math.min(this.bw - 1, ((x + r) / this.bucketSize) | 0);
    const by0 = Math.max(0, ((y - r) / this.bucketSize) | 0);
    const by1 = Math.min(this.bh - 1, ((y + r) / this.bucketSize) | 0);
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const bucket = this.buckets[by * this.bw + bx];
        for (let i = 0; i < bucket.length; i++) fn(bucket[i]);
      }
    }
  }
}
