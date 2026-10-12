import { describe, expect, it } from 'vitest';
import { describeGenome } from '../../src/engine/naming';
import { Simulation } from '../../src/engine/sim';
import { SpeciesTable } from '../../src/engine/species';
import {
  BIOME_FRESHWATER,
  BIOME_LAND,
  BIOME_OCEAN,
  DEFAULT_GENOME,
  TERRAIN_FRESH,
  TERRAIN_NORMAL,
  TERRAIN_OBSTACLE,
  TERRAIN_OCEAN,
  habitatOfTerrain,
  type Genome,
  type SpeciesTemplate,
  type WorldSpec,
} from '../../src/engine/types';
import { World } from '../../src/engine/world';
import { stateFingerprint, testSpec } from './helpers';

/** 复合地图世界：海洋 20% + 湖泊 10%，三支陆生初始种群 */
function waterSpec(seed = 7): WorldSpec {
  const base = testSpec(seed);
  return {
    ...base,
    biomes: { oceanRatio: 0.2, freshwater: 0.1 },
  };
}

/** 三圈世界：湖鱼/海鱼/陆兽各一支，验证投放落域与硬隔离 */
function triSpec(seed = 11): WorldSpec {
  return {
    name: '三圈试验场',
    seed,
    width: 160,
    height: 160,
    food: { maxPerCell: 18, regrow: 0.015 },
    terrain: { obstacleRatio: 0.03, hazardRatio: 0 },
    biomes: { oceanRatio: 0.25, freshwater: 0.1 },
    rules: { mutationRate: 0.1, maxPopulation: 2000 },
    species: [
      { name: '湖鱼', color: '#38bdf8', count: 40, habitat: BIOME_FRESHWATER, genome: {} },
      { name: '海鱼', color: '#22d3ee', count: 40, habitat: BIOME_OCEAN, genome: {} },
      { name: '陆兽', color: '#a3e635', count: 40, habitat: BIOME_LAND, genome: {} },
    ] as SpeciesTemplate[],
  };
}

describe('生态圈地形生成', () => {
  it('旧 spec（无 biomes 字段）保持纯陆地：地形只有 0/1/2，物种栖息域全为陆地', () => {
    const world = new World(testSpec(42));
    for (let i = 0; i < world.n; i++) {
      expect(world.terrain[i]).toBeLessThanOrEqual(2);
    }
    const sim = new Simulation(testSpec(42));
    for (const s of sim.species.all) expect(s.habitat ?? BIOME_LAND).toBe(BIOME_LAND);
  });

  it('分类确定性：同 seed 两次生成地形逐字节一致', () => {
    const a = new World(waterSpec(99));
    const b = new World(waterSpec(99));
    expect(Array.from(b.terrain)).toEqual(Array.from(a.terrain));
    expect(Array.from(b.fertility)).toEqual(Array.from(a.fertility));
  });

  it('海洋/湖泊占比接近 spec 配置', () => {
    const world = new World(waterSpec(7));
    let ocean = 0;
    let fresh = 0;
    for (let i = 0; i < world.n; i++) {
      if (world.terrain[i] === TERRAIN_OCEAN) ocean++;
      if (world.terrain[i] === TERRAIN_FRESH) fresh++;
    }
    const oceanFrac = ocean / world.n;
    const freshFracOfLand = fresh / (world.n - ocean);
    expect(oceanFrac).toBeGreaterThan(0.16);
    expect(oceanFrac).toBeLessThan(0.25);
    expect(freshFracOfLand).toBeGreaterThan(0.07);
    expect(freshFracOfLand).toBeLessThan(0.14);
  });

  it('障碍只落在陆地，水面不产石头', () => {
    const world = new World(waterSpec(7));
    for (let i = 0; i < world.n; i++) {
      if (world.terrain[i] === TERRAIN_OBSTACLE) {
        expect(habitatOfTerrain(world.terrain[i])).toBe(BIOME_LAND);
      }
    }
  });

  it('passableFor 硬隔离：各栖息域只能进自己的格，障碍对谁都是墙', () => {
    const world = new World(waterSpec(7));
    let oceanCell = -1;
    let freshCell = -1;
    let landCell = -1;
    let obstacleCell = -1;
    for (let i = 0; i < world.n; i++) {
      if (world.terrain[i] === TERRAIN_OCEAN && oceanCell < 0) oceanCell = i;
      if (world.terrain[i] === TERRAIN_FRESH && freshCell < 0) freshCell = i;
      if (world.terrain[i] === TERRAIN_NORMAL && landCell < 0) landCell = i;
      if (world.terrain[i] === TERRAIN_OBSTACLE && obstacleCell < 0) obstacleCell = i;
    }
    expect(oceanCell).toBeGreaterThanOrEqual(0);
    expect(freshCell).toBeGreaterThanOrEqual(0);
    expect(landCell).toBeGreaterThanOrEqual(0);
    expect(obstacleCell).toBeGreaterThanOrEqual(0);
    const at = (i: number): [number, number] => [i % world.width, Math.floor(i / world.width)];

    // 陆地生物：可走陆地，进不了任何水域
    expect(world.passableFor(BIOME_LAND, ...at(landCell))).toBe(true);
    expect(world.passableFor(BIOME_LAND, ...at(oceanCell))).toBe(false);
    expect(world.passableFor(BIOME_LAND, ...at(freshCell))).toBe(false);
    // 淡水生物：只待淡水
    expect(world.passableFor(BIOME_FRESHWATER, ...at(freshCell))).toBe(true);
    expect(world.passableFor(BIOME_FRESHWATER, ...at(landCell))).toBe(false);
    expect(world.passableFor(BIOME_FRESHWATER, ...at(oceanCell))).toBe(false);
    // 海洋生物：只待海洋
    expect(world.passableFor(BIOME_OCEAN, ...at(oceanCell))).toBe(true);
    expect(world.passableFor(BIOME_OCEAN, ...at(landCell))).toBe(false);
    // 障碍对所有栖息域都是真墙
    expect(world.passableFor(BIOME_LAND, ...at(obstacleCell))).toBe(false);
    expect(world.passableFor(BIOME_FRESHWATER, ...at(obstacleCell))).toBe(false);
    expect(world.passableFor(BIOME_OCEAN, ...at(obstacleCell))).toBe(false);
  });
});

describe('栖息域投放与硬隔离（模拟级）', () => {
  it('初始个体全部落在各自栖息域的水面/陆地上', () => {
    const sim = new Simulation(triSpec());
    const w = sim.world;
    for (const a of sim.agents) {
      const hab = sim.species.all.find((s) => s.id === a.speciesId)!.habitat ?? BIOME_LAND;
      const t = w.terrain[w.cellIndex(a.x | 0, a.y | 0)];
      if (hab === BIOME_FRESHWATER) expect(t).toBe(TERRAIN_FRESH);
      else if (hab === BIOME_OCEAN) expect(t).toBe(TERRAIN_OCEAN);
      else expect(t === TERRAIN_NORMAL || t === 2).toBe(true);
    }
  });

  it('跑 800 tick 无一体越域（真阻挡在实战中生效）', () => {
    const sim = new Simulation(triSpec());
    const w = sim.world;
    for (let t = 0; t < 800; t++) {
      sim.tickOnce();
      sim.drainEvents();
      sim.drainMetrics();
    }
    expect(sim.agents.length).toBeGreaterThan(0);
    for (const a of sim.agents) {
      const hab = sim.species.all.find((s) => s.id === a.speciesId)!.habitat ?? BIOME_LAND;
      const cellHab = habitatOfTerrain(w.terrain[w.cellIndex(a.x | 0, a.y | 0)]);
      expect(cellHab).toBe(hab);
      expect(Number.isFinite(a.energy)).toBe(true);
    }
  });

  it('含水世界的快照往返：恢复后与连续运行的轨迹逐字节一致', () => {
    const a = new Simulation(waterSpec(31));
    for (let t = 0; t < 400; t++) {
      a.tickOnce();
      a.drainEvents();
      a.drainMetrics();
    }
    const snap = a.toState();
    expect(snap.terrain.some((t) => t >= 3)).toBe(true);
    const b = Simulation.fromState(snap);
    for (let t = 0; t < 300; t++) {
      a.tickOnce();
      a.drainEvents();
      a.drainMetrics();
      b.tickOnce();
      b.drainEvents();
      b.drainMetrics();
    }
    expect(stateFingerprint(b)).toBe(stateFingerprint(a));
  });
});

describe('栖息域继承（谱系学基础）', () => {
  it('分化新物种继承父物种栖息域（同域出生 + 远基因组 → 分化，域随父种）', () => {
    const table = new SpeciesTable();
    const parent = table.found('祖种', '#34d399', { ...DEFAULT_GENOME }, 0, BIOME_FRESHWATER);
    // 极端基因组：与父种中心距离足够远，触发分化
    const child: Genome = {
      speed: 2.4, sense: 20, size: 3.0, metabolism: 2.0,
      aggression: 1, fear: 1, sociability: 1, reproThreshold: 320, hue: 300,
    };
    const r = table.assign(child, 10, BIOME_FRESHWATER);
    expect(r.speciated).toBe(true);
    expect(r.species.parentSpeciesId).toBe(parent.id);
    expect(r.species.habitat).toBe(BIOME_FRESHWATER);
  });

  it('异域出生不收编：海洋出生的个体绝不归入淡水物种，而是自立新种', () => {
    const table = new SpeciesTable();
    table.found('湖种', '#34d399', { ...DEFAULT_GENOME }, 0, BIOME_FRESHWATER);
    const near: Genome = { ...DEFAULT_GENOME, speed: 0.56 };
    const r = table.assign(near, 10, BIOME_OCEAN);
    expect(r.speciated).toBe(true);
    expect(r.species.parentSpeciesId).toBeNull();
    expect(r.species.habitat).toBe(BIOME_OCEAN);
  });

  it('含水世界高突变跑 4000 tick：所有带父种的物种栖息域都与父种一致', () => {
    const base = waterSpec(53);
    const spec: WorldSpec = {
      ...base,
      rules: { ...base.rules, mutationRate: 0.45 },
      species: base.species.map((s) => ({ ...s, count: Math.round(s.count / 2) })),
    };
    const sim = new Simulation(spec);
    for (let t = 0; t < 4000; t++) {
      sim.tickOnce();
      sim.drainEvents();
      sim.drainMetrics();
    }
    const byId = new Map(sim.species.all.map((s) => [s.id, s]));
    for (const s of sim.species.all) {
      if (s.parentSpeciesId === null) continue;
      const parent = byId.get(s.parentSpeciesId);
      if (!parent) continue; // 祖先已从 all 列表裁剪的情形不存在（all 全保留），防御式跳过
      expect(s.habitat ?? BIOME_LAND).toBe(parent.habitat ?? BIOME_LAND);
    }
  });
});

describe('分域物种命名规则', () => {
  it('默认基因组：陆地=绿狐（历史不变），淡水=绿鲫，海洋=绿鲹', () => {
    expect(describeGenome({ ...DEFAULT_GENOME }).name).toBe('绿狐');
    expect(describeGenome({ ...DEFAULT_GENOME }, BIOME_FRESHWATER).name).toBe('绿鲫');
    expect(describeGenome({ ...DEFAULT_GENOME }, BIOME_OCEAN).name).toBe('绿鲹');
  });

  it('大型凶猛个体：陆地=尖牙虎，淡水=尖牙鲶，海洋=尖牙鲨（拉丁属名分域）', () => {
    const g: Genome = { ...DEFAULT_GENOME, size: 2.4, aggression: 0.9 };
    expect(describeGenome(g).latin).toBe('Panthera ferox');
    expect(describeGenome(g, BIOME_FRESHWATER).name).toBe('尖牙鲶');
    expect(describeGenome(g, BIOME_FRESHWATER).latin).toBe('Silurus ferox');
    expect(describeGenome(g, BIOME_OCEAN).name).toBe('尖牙鲨');
    expect(describeGenome(g, BIOME_OCEAN).latin).toBe('Carcharias ferox');
  });

  it('水域物种标签以栖息域开头，陆地物种标签保持历史行为', () => {
    const g: Genome = { ...DEFAULT_GENOME, size: 2.4, aggression: 0.9 };
    // TAG_RULES 顺序：size 规则先于 aggression → 巨躯在前
    expect(describeGenome(g, BIOME_OCEAN).tags.slice(0, 2)).toEqual(['海洋', '巨躯']);
    expect(describeGenome(g, BIOME_OCEAN).tags).toContain('凶猛');
    expect(describeGenome({ ...DEFAULT_GENOME }).tags).toEqual(['均衡']);
  });

  it('快者/感知强者分域各有其名：疾鳟/疾鲔、大眼鳜/大眼章鱼', () => {
    const fast: Genome = { ...DEFAULT_GENOME, speed: 2.0 };
    expect(describeGenome(fast, BIOME_FRESHWATER).name).toBe('疾鳟');
    expect(describeGenome(fast, BIOME_OCEAN).name).toBe('疾鲔');
    const seer: Genome = { ...DEFAULT_GENOME, sense: 16 };
    expect(describeGenome(seer, BIOME_FRESHWATER).name).toBe('大眼鳜');
    expect(describeGenome(seer, BIOME_OCEAN).name).toBe('大眼章鱼');
  });
});
