import { Rng } from './rng';
import {
  BIOME_AMPHIBIAN,
  BIOME_FRESHWATER,
  BIOME_LAND,
  BIOME_OCEAN,
  TERRAIN_FRESH,
  TERRAIN_HAZARD,
  TERRAIN_NORMAL,
  TERRAIN_OBSTACLE,
  TERRAIN_OCEAN,
  type WorldSpec,
} from './types';

/**
 * 世界：网格地形 + 食物能量场。
 *
 * - fertility：每格肥沃度（0..1），陆域由值噪声生成，水域按浮游生物公式赋值，
 *   决定食物上限与再生速度。
 * - terrain：普通 / 障碍（不可通行、不产食物）/ 危险（停留持续掉能量）/
 *   淡水（TERRAIN_FRESH）/ 海洋（TERRAIN_OCEAN）。水陆由高度+湿度双噪声确定性分类。
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

    // 生态圈分类（海洋/淡水湖泊）：必须先于障碍物放置，障碍物只落陆地。
    // 只消耗值噪声，不消耗 rng —— 无水世界随机数流与历史版本完全一致。
    this.classifyBiomes(spec);

    // 障碍：低肥沃度聚集成片（只在陆地上放置；水域是海岸线，不做石头）
    const obstacleRatio = Math.min(0.3, Math.max(0, spec.terrain.obstacleRatio));
    if (obstacleRatio > 0) {
      const landFert: number[] = [];
      for (let i = 0; i < this.n; i++) {
        if (this.terrain[i] === TERRAIN_NORMAL) landFert.push(this.fertility[i]);
      }
      landFert.sort((a, b) => a - b);
      const threshold = quantileSorted(landFert, obstacleRatio);
      for (let i = 0; i < this.n; i++) {
        if (this.terrain[i] === TERRAIN_NORMAL && this.fertility[i] <= threshold) {
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

    // 初始食物：按肥沃度随机铺（普通格 + 两类水面都产食物）
    for (let i = 0; i < this.n; i++) {
      const t = this.terrain[i];
      if (t !== TERRAIN_NORMAL && t !== TERRAIN_FRESH && t !== TERRAIN_OCEAN) continue;
      if (rng.next() < 0.4) {
        this.food[i] = rng.next() * this.fertility[i] * this.maxPerCell;
      }
    }
  }

  /**
   * 生态圈分类：海洋 = 高度最低的 oceanRatio 占比；淡水湖泊 = 剩余陆地中
   * 湿度最高的 freshwater 占比。只消耗值噪声（不消耗 rng），无水世界
   * 不改变任何随机数流，保证旧 spec 的轨迹逐字节一致。
   */
  private classifyBiomes(spec: WorldSpec): void {
    const oceanRatio = Math.min(0.45, Math.max(0, spec.biomes?.oceanRatio ?? 0));
    const freshwater = Math.min(0.25, Math.max(0, spec.biomes?.freshwater ?? 0));
    if (oceanRatio <= 0 && freshwater <= 0) return;

    const elevNoise = makeValueNoise(spec.seed ^ 0x5f356495);
    const moistNoise = makeValueNoise(spec.seed ^ 0x1e8d3b9d);
    const elev = new Float32Array(this.n);
    const moist = new Float32Array(this.n);
    for (let y = 0; y < this.height; y++) {
      const ny = y / this.height;
      for (let x = 0; x < this.width; x++) {
        const nx = x / this.width;
        const i = y * this.width + x;
        elev[i] = elevNoise(nx, ny, 5) * 0.62 + elevNoise(nx, ny, 11) * 0.38;
        moist[i] = moistNoise(nx, ny, 4) * 0.6 + moistNoise(nx, ny, 9) * 0.4;
      }
    }

    // 海洋：按高度分位数取最低 oceanRatio 占比
    if (oceanRatio > 0) {
      const sortedElev = Array.from(elev).sort((a, b) => a - b);
      const seaLevel = quantileSorted(sortedElev, oceanRatio);
      for (let i = 0; i < this.n; i++) {
        if (elev[i] <= seaLevel) this.terrain[i] = TERRAIN_OCEAN;
      }
    }

    // 淡水湖泊：非海洋格中湿度最高的 freshwater 占比（湿地成片，天然形成湖盆）
    if (freshwater > 0) {
      const landMoist: number[] = [];
      for (let i = 0; i < this.n; i++) {
        if (this.terrain[i] !== TERRAIN_OCEAN) landMoist.push(moist[i]);
      }
      landMoist.sort((a, b) => a - b);
      const wetLevel = quantileSorted(landMoist, 1 - freshwater);
      for (let i = 0; i < this.n; i++) {
        if (this.terrain[i] !== TERRAIN_OCEAN && moist[i] >= wetLevel) {
          this.terrain[i] = TERRAIN_FRESH;
        }
      }
    }

    // 水域肥沃度：海洋稀薄（浮游生物），淡水富营养（湖泊=营养陷阱）
    for (let i = 0; i < this.n; i++) {
      if (this.terrain[i] === TERRAIN_OCEAN) this.fertility[i] = 0.08 + 0.3 * moist[i];
      else if (this.terrain[i] === TERRAIN_FRESH) this.fertility[i] = 0.45 + 0.4 * moist[i];
    }
  }

  /** 是否可通行（仅障碍判定；栖息域判定用 passableFor） */
  passable(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    return this.terrain[y * this.width + x] !== TERRAIN_OBSTACLE;
  }

  /**
   * 栖息域通行判定（硬隔离的核心）：陆域生物可走普通格与危险区，
   * 淡水生物只能待在淡水格，海洋生物只能待在海洋格；
   * 两栖生物可走陆地与淡水（不能下海）；障碍格对所有生物都是墙。
   */
  passableFor(habitat: number, x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    const t = this.terrain[y * this.width + x];
    if (t === TERRAIN_OBSTACLE) return false;
    if (habitat === BIOME_LAND) return t === TERRAIN_NORMAL || t === TERRAIN_HAZARD;
    if (habitat === BIOME_FRESHWATER) return t === TERRAIN_FRESH;
    if (habitat === BIOME_OCEAN) return t === TERRAIN_OCEAN;
    if (habitat === BIOME_AMPHIBIAN) {
      return t === TERRAIN_NORMAL || t === TERRAIN_HAZARD || t === TERRAIN_FRESH;
    }
    return false;
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
      const t = terrain[i];
      // 障碍与危险区不产食物；普通格 + 两类水面按肥沃度再生
      if (t === TERRAIN_OBSTACLE || t === TERRAIN_HAZARD) continue;
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
      const t = this.terrain[i];
      if (t === TERRAIN_OBSTACLE || t === TERRAIN_HAZARD) continue;
      sum += this.fertility[i] * this.maxPerCell;
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
