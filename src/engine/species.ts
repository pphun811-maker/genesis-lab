import { blendCentroid, geneticDistance } from './genome';
import { describeGenome } from './naming';
import { BIOME_LAND, type Genome, type SimEvent, type SpeciesInfo } from './types';

/**
 * 物种表：按遗传距离对新个体做增量聚类。
 *
 * 新生个体加入基因中心距离最近的现存物种；距离超过阈值则分化为新物种。
 * 物种全员灭绝且持续一段时间后标记灭绝并移出活跃表。
 * 物种栖息域（habitat）在建立时确定、分化时继承——硬隔离下个体永不跨圈，
 * 这是「海岛/湖泊=物种孵化器」的谱系学基础。
 */
export class SpeciesTable {
  /** 存续中的物种（不含已灭绝） */
  readonly active: SpeciesInfo[] = [];
  /** 全部物种（含已灭绝，供时间线展示） */
  readonly all: SpeciesInfo[] = [];
  private nextId = 1;
  private emptySince: Map<number, number> = new Map();

  constructor(
    private readonly joinThreshold: number = 0.14,
    private readonly extinctAfterTicks: number = 600,
    private readonly maxSpecies: number = 64,
  ) {}

  /** 初始化时为一支种群建立物种（栖息域随初始落点/模板确定） */
  found(name: string, color: string, centroid: Genome, tick: number, habitat: number = BIOME_LAND): SpeciesInfo {
    const desc = describeGenome(centroid, habitat);
    const info: SpeciesInfo = {
      id: this.nextId++,
      name,
      color,
      centroid: { ...centroid },
      foundedTick: tick,
      extinctTick: null,
      parentSpeciesId: null,
      habitat,
      tags: desc.tags,
      niche: desc.niche,
      latin: desc.latin,
      peakCount: 0,
    };
    this.active.push(info);
    this.all.push(info);
    return info;
  }

  /** 为新生个体分配物种；距离最近的物种太远时分化为新物种（栖息域继承父种） */
  assign(genome: Genome, tick: number, birthHabitat: number = BIOME_LAND): { species: SpeciesInfo; speciated: boolean; event?: SimEvent } {
    let best: SpeciesInfo | null = null;
    let bestDist = Infinity;
    for (const s of this.active) {
      // 栖息域隔离：异域物种不参与收编——海里出生的个体绝不会被
      // 归入陆生物种（否则物种属性会对自己成员的所在圈域撒谎）
      if ((s.habitat ?? BIOME_LAND) !== birthHabitat) continue;
      const d = geneticDistance(genome, s.centroid);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }

    if (best && (bestDist < this.joinThreshold || this.active.length >= this.maxSpecies)) {
      best.centroid = blendCentroid(best.centroid, genome, 0.02);
      return { species: best, speciated: false };
    }

    const parent = best;
    const habitat = parent ? (parent.habitat ?? birthHabitat) : birthHabitat;
    const desc = describeGenome(genome, habitat);
    const info: SpeciesInfo = {
      id: this.nextId,
      name: this.uniqueName(desc.name),
      color: genomeColor(genome.hue),
      centroid: { ...genome },
      foundedTick: tick,
      extinctTick: null,
      parentSpeciesId: parent ? parent.id : null,
      habitat,
      tags: desc.tags,
      niche: desc.niche,
      latin: desc.latin,
      peakCount: 1,
    };
    this.nextId++;
    this.active.push(info);
    this.all.push(info);
    const traitNote = desc.tags.length > 0 ? ` · 特征：${desc.tags.join('、')}` : '';
    return {
      species: info,
      speciated: true,
      event: {
        t: tick,
        kind: 'speciation',
        msg: parent
          ? `「${info.name}」（${desc.latin}）自「${parent.name}」中分化而出${traitNote}`
          : `「${info.name}」（${desc.latin}）凭空出现${traitNote}`,
        speciesId: info.id,
      },
    };
  }

  /**
   * 每 tick（或低频）调用：无存活个体的物种在宽限期后灭绝。
   * popById 由 sim 层统计传入。
   */
  prune(tick: number, popById: Map<number, number>): SimEvent[] {
    const events: SimEvent[] = [];
    for (let i = this.active.length - 1; i >= 0; i--) {
      const s = this.active[i];
      if ((popById.get(s.id) ?? 0) > 0) {
        this.emptySince.delete(s.id);
        continue;
      }
      const since = this.emptySince.get(s.id);
      if (since === undefined) {
        this.emptySince.set(s.id, tick);
        continue;
      }
      if (tick - since >= this.extinctAfterTicks) {
        s.extinctTick = tick;
        this.active.splice(i, 1);
        this.emptySince.delete(s.id);
        events.push({
          t: tick,
          kind: 'extinction',
          msg: `「${s.name}」灭绝了 · 存续 ${(tick - s.foundedTick).toLocaleString()} tick${
            s.peakCount ? ` · 巅峰 ${s.peakCount.toLocaleString()} 个体` : ''
          }`,
          speciesId: s.id,
        });
      }
    }
    return events;
  }

  /** 种名唯一化：与任何历史物种重名时追加「·2」「·3」序号 */
  private uniqueName(base: string): string {
    const taken = new Set(this.all.map((s) => s.name));
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base}·${n}`)) n++;
    return `${base}·${n}`;
  }

  /** 快照恢复时重建内部状态 */
  restore(all: SpeciesInfo[], nextId: number): void {
    this.all.length = 0;
    this.active.length = 0;
    for (const s of all) {
      this.all.push(s);
      if (s.extinctTick === null) this.active.push(s);
    }
    this.nextId = nextId;
    this.emptySince.clear();
  }

  get nextSpeciesId(): number {
    return this.nextId;
  }
}

/** 由色相生成物种代表色 */
export function genomeColor(hue: number): string {
  const h = ((Math.round(hue) % 360) + 360) % 360;
  const [r, g, b] = hslToRgbByte(h, 0.72, 0.6);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export function hslToRgbByte(h: number, s: number, l: number): [number, number, number] {
  // 标准 HSL → RGB（仅用于展示，不在模拟热路径中）
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}
