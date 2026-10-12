import type { Rng } from './rng';
import type { World } from './world';
import type { SpatialHash } from './spatial';
import { maxEnergyOf, type Agent } from './types';

/**
 * 行为：感知 → 按基因权重决策 → 输出转向。
 *
 * 优先级：逃逸 > 捕猎 > 觅食（含记忆）> 群聚 > 游荡。
 * 所有向量运算只用算术与平方根；热路径零分配（结果写入复用对象）。
 */

export interface BehaviorContext {
  world: World;
  hash: SpatialHash;
  rng: Rng;
  tick: number;
  /** 本 tick 的有效感知半径上限（密度自适应收缩，min(基因 sense, senseCap) 为实际半径） */
  senseCap: number;
}

export interface SteerResult {
  dirX: number;
  dirY: number;
  /** 希望达到的速度比例（0..1），逃逸/捕猎全力，觅食略省力 */
  effort: number;
  /** 行为意图（0 游荡 1 逃逸 2 追捕 3 觅食 4 归群），供检查器展示 */
  intent: number;
  /** 感知到的最近猎物（同 tick 内由调用方立即消费，供攻击判定复用，免去二次扫描） */
  prey: Agent | null;
  /** 猎物距离平方（猎物为 null 时无意义） */
  preyD2: number;
}

/** 行为意图常量 */
export const INTENT_WANDER = 0;
export const INTENT_FLEE = 1;
export const INTENT_HUNT = 2;
export const INTENT_FORAGE = 3;
export const INTENT_HERD = 4;

const THREAT_RATIO = 1.15; // 对方体型大于我方 1.15 倍视为威胁
const PREY_RATIO = 0.85; // 对方体型小于我方 0.85 倍视为猎物
const AGGRECTION_HUNT = 0.3; // 攻击性低于此不主动狩猎
const FOOD_SEEK_SAMPLES = 6; // 觅食时在感知圈内随机采样点数
const MEMORY_TICKS = 300; // 进食记忆有效期
const KIN_SAMPLE_CAP = 12;

// 复用的结果对象：调用方在同 tick 内立即消费字段，不得持有引用
const result: SteerResult = { dirX: 1, dirY: 0, effort: 0.5, intent: 0, prey: null, preyD2: 0 };

export function steer(self: Agent, ctx: BehaviorContext): SteerResult {
  const { world, hash, rng, tick } = ctx;
  const g = self.genome;
  // 实际感知半径：基因 sense 被密度上限收缩（拥挤干扰视线）
  const sense = Math.min(g.sense, ctx.senseCap);
  const r2 = sense * sense;
  const maxE = maxEnergyOf(g.size);
  const sizeThreat = g.size * THREAT_RATIO;
  const sizePrey = g.size * PREY_RATIO;
  const wantKin = g.sociability > 0.05;

  // ---- 单遍感知：威胁 / 猎物 / 同类质心 ----
  // forEachNear 的回调会被 V8 内联；实测改数组/SoA 形态均无收益（候选以同类居多，
  // 短路访问比全量解包便宜），维持闭包形态。热路径零分配（结果写入复用对象）。
  let threatDX = 0;
  let threatDY = 0;
  let threatD2 = Infinity;
  let preyRef: Agent | null = null;
  let preyDX = 0;
  let preyDY = 0;
  let preyD2 = Infinity;
  let kinCount = 0;
  let kinX = 0;
  let kinY = 0;
  let kinScanned = 0;

  hash.forEachNear(self.x, self.y, sense, (other) => {
    if (other === self || !other.alive) return;
    if (other.speciesId === self.speciesId) {
      if (!wantKin || kinScanned >= KIN_SAMPLE_CAP) return;
      const dx = other.x - self.x;
      if (dx > sense || dx < -sense) return;
      const dy = other.y - self.y;
      if (dy > sense || dy < -sense) return;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) return;
      kinScanned++;
      kinCount++;
      kinX += other.x;
      kinY += other.y;
      return;
    }
    const dx = other.x - self.x;
    if (dx > sense || dx < -sense) return;
    const dy = other.y - self.y;
    if (dy > sense || dy < -sense) return;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) return;
    const os = other.genome.size;
    if (os > sizeThreat) {
      if (d2 < threatD2) {
        threatD2 = d2;
        threatDX = dx;
        threatDY = dy;
      }
    } else if (os < sizePrey) {
      if (d2 < preyD2) {
        preyD2 = d2;
        preyDX = dx;
        preyDY = dy;
        preyRef = other;
      }
    }
  });

  // ---- 决策 ----
  // 1) 逃逸
  if (threatD2 < Infinity && g.fear > 0.05) {
    const d = Math.sqrt(threatD2) || 1;
    const jitter = rng.gauss() * 0.2;
    const r = rotateJitter(-threatDX / d, -threatDY / d, jitter, 1);
    r.intent = INTENT_FLEE;
    return r;
  }

  // 2) 捕猎
  if (preyRef !== null && preyD2 < Infinity && g.aggression > AGGRECTION_HUNT && self.energy < maxE * 0.85) {
    const d = Math.sqrt(preyD2) || 1;
    result.dirX = preyDX / d;
    result.dirY = preyDY / d;
    result.effort = 1;
    result.intent = INTENT_HUNT;
    result.prey = preyRef;
    result.preyD2 = preyD2;
    return result;
  }

  // 3) 觅食（当前格食物充足时不移动方向偏好）
  let fx = 0;
  let fy = 0;
  let foodFound = false;
  let found = false;

  const cx = clampCell(self.x, world.width);
  const cy = clampCell(self.y, world.height);
  if (world.food[world.cellIndex(cx, cy)] < 1) {
    // 进食记忆
    if (tick - self.memoryTick < MEMORY_TICKS && self.memoryX >= 0) {
      const mx = self.memoryX - self.x;
      const my = self.memoryY - self.y;
      const md2 = mx * mx + my * my;
      const memReach = sense * 1.5;
      if (md2 > 1 && md2 < memReach * memReach) {
        const d = Math.sqrt(md2);
        fx = mx / d;
        fy = my / d;
        found = true;
        foodFound = true;
      }
    }
    // 随机采样感知圈内的食物浓度（方形采样 + 圆外丢弃，确定性等价拒绝法）
    let bestFood = 0.5;
    for (let i = 0; i < FOOD_SEEK_SAMPLES; i++) {
      const ox = rng.range(-sense, sense);
      const oy = rng.range(-sense, sense);
      if (ox * ox + oy * oy > r2) continue;
      const sx = clampCell(self.x + ox, world.width);
      const sy = clampCell(self.y + oy, world.height);
      const idx = world.cellIndex(sx, sy);
      if (world.terrain[idx] !== 0) continue;
      const f = world.food[idx];
      if (f > bestFood) {
        bestFood = f;
        const d = Math.sqrt(ox * ox + oy * oy) || 1;
        fx = ox / d;
        fy = oy / d;
        found = true;
        foodFound = true;
      }
    }
  }

  // 4) 群聚
  if (kinCount > 0 && wantKin) {
    const gx = kinX / kinCount - self.x;
    const gy = kinY / kinCount - self.y;
    const d = Math.sqrt(gx * gx + gy * gy);
    if (d > 1) {
      const wgt = (g.sociability * 0.5) / d;
      fx += gx * wgt;
      fy += gy * wgt;
      found = true;
    }
  }

  if (found) {
    const len = Math.sqrt(fx * fx + fy * fy) || 1;
    result.dirX = fx / len;
    result.dirY = fy / len;
    result.effort = 0.85;
    result.intent = foodFound ? INTENT_FORAGE : INTENT_HERD;
    result.prey = null;
    result.preyD2 = 0;
    return result;
  }

  // 5) 游荡：保持朝向并随机小幅转向
  const r = rotateJitter(self.dirX, self.dirY, rng.gauss() * 0.3, 0.5);
  r.intent = INTENT_WANDER;
  return r;
}

function rotateJitter(dx: number, dy: number, angle: number, effort: number): SteerResult {
  // 小角旋转的线性近似：(x,y) → (x - a·y, y + a·x)，避免三角函数
  const nx = dx - angle * dy;
  const ny = dy + angle * dx;
  const len = Math.sqrt(nx * nx + ny * ny) || 1;
  result.dirX = nx / len;
  result.dirY = ny / len;
  result.effort = effort;
  result.prey = null;
  result.preyD2 = 0;
  return result;
}

export function clampCell(v: number, max: number): number {
  let i = v | 0;
  if (i < 0) i = 0;
  if (i >= max) i = max - 1;
  return i;
}
