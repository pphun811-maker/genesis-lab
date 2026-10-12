import { Rng } from './rng';
import {
  TERRAIN_HAZARD,
  TERRAIN_NORMAL,
  TERRAIN_OBSTACLE,
  type WorldSpec,
} from './types';

/**
 * 世界：网格地形 + 食物能量场。
 *
 * - fertility：每格肥沃度（0..1），由值噪声生成，决定食物上限与再生速度。
 * - terrain：普通 / 障碍（不可通行、不产食物）/ 危险（停留持续掉能量）。
 * - food：每格当前食物能量。
 */
export class World {
  readonly width: number;
  readonly height: number;
  readonly n: number;
  readonly fertility: Float32Array;
  readonly terrain: Uint8Array;
  readonly food: Float32Array;
  private maxPerCell: number;
  private regrow: number;
  /** 旱灾：此 tick 之前再生倍率生效（0 = 无旱灾） */
  private droughtUntilTick = 0;
  private droughtMult = 1;

  constructor(spec: WorldSpec) {
    this.width = spec.width;
    this.height = spec.height;
    this.n = spec.width * spec.height;
    this.maxPerCell = spec.food.maxPerCell;
    this.regrow = spec.food.regrow;
    this.fertility = new Float32Array(this.n);
    this.terrain = new Uint8Array(this.n);
    this.food = new Float32Array(this.n);
    this.generate(spec);
  }

  private generate(spec: WorldSpec): void {
    const rng = new Rng(spec.seed);
    // 值噪声（2 个倍频）：只使用整数哈希 + 算术插值，保证确定性
    const noise = makeValueNoise(spec.seed);

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = y * this.width + x;
        const nx = x / this.width;
        const ny = y / this.height;
        const f = noise(nx, ny, 6) * 0.7 + noise(nx, ny, 14) * 0.3;
        this.fertility[i] = Math.min(1, Math.max(0.02, f));
      }
    }

    // 障碍：低肥沃度聚集成片
    const obstacleRatio = Math.min(0.3, Math.max(0, spec.terrain.obstacleRatio));
    if (obstacleRatio > 0) {
      const threshold = quantileSorted(
        Array.from(this.fertility).sort((a, b) => a - b),
        obstacleRatio,
      );
      for (let i = 0; i < this.n; i++) {
        if (this.fertility[i] <= threshold) {
          this.terrain[i] = TERRAIN_OBSTACLE;
          this.fertility[i] = 0;
        }
      }
    }

    // 危险区：稀疏噪声热点
    const hazardRatio = Math.min(0.2, Math.max(0, spec.terrain.hazardRatio));
    if (hazardRatio > 0) {
      const placed = Math.floor(this.n * hazardRatio);
      let tries = 0;
      let placedCount = 0;
      while (placedCount < placed && tries < placed * 30) {
        tries++;
        const cx = rng.int(this.width);
        const cy = rng.int(this.height);
        const r = 1 + rng.int(3);
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const x = cx + dx;
            const y = cy + dy;
            if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
            const i = y * this.width + x;
            if (this.terrain[i] === TERRAIN_NORMAL && dx * dx + dy * dy <= r * r) {
              this.terrain[i] = TERRAIN_HAZARD;
              placedCount++;
            }
          }
        }
      }
    }

    // 初始食物：按肥沃度随机铺
    for (let i = 0; i < this.n; i++) {
      if (this.terrain[i] !== TERRAIN_NORMAL) continue;
      if (rng.next() < 0.4) {
        this.food[i] = rng.next() * this.fertility[i] * this.maxPerCell;
      }
    }
  }

  /** 是否可通行 */
  passable(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    return this.terrain[y * this.width + x] !== TERRAIN_OBSTACLE;
  }

  cellIndex(x: number, y: number): number {
    return y * this.width + x;
  }

  /** 某格的食物承载上限（肥沃度 × 每格上限；障碍格为 0） */
  foodCap(i: number): number {
    return this.fertility[i] * this.maxPerCell;
  }

  /** 食物再生：为控制开销，每 4 tick 全场执行一次、一次补足 4 份 */
  regrowFood(tick: number): void {
    const food = this.food;
    const fert = this.fertility;
    const terrain = this.terrain;
    const mult = tick < this.droughtUntilTick ? this.droughtMult : 1;
    const amount = this.regrow * 4 * mult;
    for (let i = 0; i < this.n; i++) {
      if (terrain[i] !== TERRAIN_NORMAL) continue;
      const cap = fert[i] * this.maxPerCell;
      let f = food[i] + amount * fert[i];
      if (f > cap) f = cap;
      food[i] = f;
    }
  }

  /** 开启旱灾：到 untilTick 前食物再生倍率降为 mult */
  beginDrought(duration: number, mult: number, nowTick: number): void {
    this.droughtUntilTick = nowTick + duration;
    this.droughtMult = mult;
  }

  droughtActive(tick: number): boolean {
    return tick < this.droughtUntilTick;
  }

  /** 快照恢复旱灾状态（分叉/续跑保持一致） */
  restoreDrought(untilTick: number, mult: number): void {
    this.droughtUntilTick = untilTick;
    this.droughtMult = mult;
  }

  droughtState(): { untilTick: number; mult: number } {
    return { untilTick: this.droughtUntilTick, mult: this.droughtMult };
  }

  /** 更新可热编辑的规则参数 */
  updateRules(patch: { foodRegrow?: number }): void {
    if (patch.foodRegrow !== undefined) this.regrow = patch.foodRegrow;
  }

  /** 场上食物总能量 */
  totalFood(): number {
    let sum = 0;
    for (let i = 0; i < this.n; i++) sum += this.food[i];
    return sum;
  }

  /** 全场食物能量容量（Σ 肥沃度×每格上限；地形与肥沃度恒定，故容量恒定） */
  totalCapacity(): number {
    let sum = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.terrain[i] === TERRAIN_NORMAL) sum += this.fertility[i] * this.maxPerCell;
    }
    return sum;
  }
}

// ---------------------------------------------------------------------------
// 确定性值噪声
// ---------------------------------------------------------------------------

function hash2(seed: number, xi: number, yi: number): number {
  // 整数哈希 → [0,1)
  let h = (seed ^ Math.imul(xi, 374761393) ^ Math.imul(yi, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function makeValueNoise(seed: number): (nx: number, ny: number, cells: number) => number {
  return (nx: number, ny: number, cells: number) => {
    const fx = nx * cells;
    const fy = ny * cells;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = smooth(fx - x0);
    const ty = smooth(fy - y0);
    const v00 = hash2(seed + cells, x0, y0);
    const v10 = hash2(seed + cells, x0 + 1, y0);
    const v01 = hash2(seed + cells, x0, y0 + 1);
    const v11 = hash2(seed + cells, x0 + 1, y0 + 1);
    const a = v00 + (v10 - v00) * tx;
    const b = v01 + (v11 - v01) * tx;
    return a + (b - a) * ty;
  };
}

function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx];
}
