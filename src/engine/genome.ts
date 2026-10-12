import type { Rng } from './rng';
import {
  DEFAULT_GENOME,
  GENE_KEYS,
  GENE_RANGE,
  maxEnergyOf,
  type GeneKey,
  type Genome,
  type SpeciesTemplate,
} from './types';

/** 由物种模板生成一个完整基因组（模板缺失字段取默认值，加上初始抖动） */
export function genomeFromTemplate(tpl: SpeciesTemplate, rng: Rng): Genome {
  const g: Genome = { ...DEFAULT_GENOME, ...tpl.genome };
  const variance = tpl.variance ?? {};
  for (const key of GENE_KEYS) {
    const v = variance[key] ?? 0;
    if (v > 0) g[key] = g[key] + rng.gauss() * v;
  }
  if (tpl.color) {
    g.hue = hexToHue(tpl.color);
  }
  clampGenome(g);
  return g;
}

/** 将基因钳制到合法区间，并保证派生量一致（能量上限 / 繁殖阈值） */
export function clampGenome(g: Genome): void {
  for (const key of GENE_KEYS) {
    const [min, max] = GENE_RANGE[key];
    if (!(g[key] >= min)) g[key] = min;
    if (g[key] > max) g[key] = max;
  }
  const maxE = maxEnergyOf(g.size);
  const cap = maxE * 0.9;
  if (g.reproThreshold > cap) g.reproThreshold = cap;
}

/**
 * 突变：每个基因以 mutationRate 概率被高斯扰动。
 * 幅度与基因区间宽度成比例，保证不同量纲的基因漂变速率可比。
 */
export function mutateGenome(src: Genome, mutationRate: number, rng: Rng): Genome {
  const g: Genome = { ...src };
  for (const key of GENE_KEYS) {
    if (rng.chance(mutationRate)) {
      const [min, max] = GENE_RANGE[key];
      const span = max - min;
      g[key] = g[key] + rng.gauss() * span * 0.06;
    }
  }
  clampGenome(g);
  return g;
}

/**
 * 有性繁殖的基因交叉：每个基因等概率取自父本或母本（均匀交叉），
 * 随后由调用方执行突变。纯函数、确定性。
 */
export function crossoverGenome(a: Genome, b: Genome, rng: Rng): Genome {
  const g = {} as Genome;
  for (const key of GENE_KEYS) {
    g[key] = rng.next() < 0.5 ? a[key] : b[key];
  }
  clampGenome(g);
  return g;
}

/** 各基因在遗传距离中的权重 */
const DIST_WEIGHTS: Record<GeneKey, number> = {
  speed: 1,
  sense: 1,
  size: 1.5,
  metabolism: 1,
  aggression: 2,
  fear: 0.5,
  sociability: 1,
  reproThreshold: 1,
  hue: 0.7,
};

const PRE_NORM: Record<GeneKey, number> = (() => {
  const out = {} as Record<GeneKey, number>;
  for (const key of GENE_KEYS) {
    const [min, max] = GENE_RANGE[key];
    out[key] = max - min;
  }
  return out;
})();

/** 归一化加权欧氏距离，值域约 [0, 1]。hue 按环形距离处理。 */
export function geneticDistance(a: Genome, b: Genome): number {
  let sum = 0;
  let wsum = 0;
  for (const key of GENE_KEYS) {
    const w = DIST_WEIGHTS[key];
    let d: number;
    if (key === 'hue') {
      d = Math.abs(a.hue - b.hue);
      if (d > 180) d = 360 - d;
      d = d / 180;
    } else {
      d = (a[key] - b[key]) / PRE_NORM[key];
    }
    sum += w * d * d;
    wsum += w;
  }
  return Math.sqrt(sum / wsum);
}

/** 两个基因组的指数滑动平均（物种中心更新用） */
export function blendCentroid(centroid: Genome, genome: Genome, alpha: number): Genome {
  const out = {} as Genome;
  for (const key of GENE_KEYS) {
    if (key === 'hue') {
      // 环形均值
      let d = genome.hue - centroid.hue;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      let h = centroid.hue + d * alpha;
      if (h < 0) h += 360;
      if (h >= 360) h -= 360;
      out.hue = h;
    } else {
      out[key] = centroid[key] + (genome[key] - centroid[key]) * alpha;
    }
  }
  return out;
}

/** #rrggbb → 色相 0..360（仅用于初始个体着色） */
export function hexToHue(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return DEFAULT_GENOME.hue;
  const v = parseInt(m[1], 16);
  const r = ((v >> 16) & 255) / 255;
  const g = ((v >> 8) & 255) / 255;
  const b = (v & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}
