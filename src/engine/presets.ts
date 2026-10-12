import { BIOME_AMPHIBIAN, BIOME_FRESHWATER, BIOME_OCEAN, type WorldSpec } from './types';

/**
 * 内置世界预设。数值经过能量学估算：
 * 默认参数下全场食物再生 ≈ 192 能量/tick，普通个体代谢 ≈ 0.08 能量/tick，
 * 环境承载力约 2000+ 个体，种群会在承载线附近震荡。
 */

function makeSpec(
  name: string,
  seed: number,
  over: Partial<WorldSpec> & { species: WorldSpec['species'] },
): WorldSpec {
  return {
    name,
    seed,
    width: 160,
    height: 160,
    food: { maxPerCell: 18, regrow: 0.015 },
    terrain: { obstacleRatio: 0.05, hazardRatio: 0.02 },
    rules: {
      mutationRate: 0.15,
      maxPopulation: 2500,
      sexualReproduction: true,
      disasters: { enabled: true, severity: 0.5 },
    },
    ...over,
  };
}

export interface PresetDef {
  id: string;
  title: string;
  desc: string;
  spec: (seed: number) => WorldSpec;
}

export const PRESETS: PresetDef[] = [
  {
    id: 'primordial',
    title: '原始汤',
    desc: '温和富饶的世界，两支食草种群为食物竞争，看谁先演化出优势。',
    spec: (seed) =>
      makeSpec('原始汤', seed, {
        species: [
          {
            name: '绿藻',
            color: '#4ade80',
            count: 140,
            genome: { speed: 0.45, sense: 7, aggression: 0, sociability: 0.5 },
            variance: { speed: 0.1, sense: 1 },
          },
          {
            name: '浮游者',
            color: '#38bdf8',
            count: 80,
            genome: { speed: 0.75, sense: 10, aggression: 0, sociability: 0.15 },
            variance: { speed: 0.15, sense: 1.5 },
          },
        ],
      }),
  },
  {
    id: 'arms-race',
    title: '猎食军备竞赛',
    desc: '猎手与猎物共存。速度、感知、体型与狡诈在生死之间军备竞赛。',
    spec: (seed) =>
      makeSpec('猎食军备竞赛', seed, {
        species: [
          {
            name: '食草者',
            color: '#a3e635',
            count: 180,
            genome: { speed: 0.7, sense: 9, size: 0.8, aggression: 0, fear: 0.85, sociability: 0.6 },
            variance: { speed: 0.12, sense: 1.5, fear: 0.1 },
          },
          {
            name: '游荡者',
            color: '#fbbf24',
            count: 60,
            genome: { speed: 0.6, sense: 11, size: 1.0, aggression: 0.05, fear: 0.5 },
            variance: { speed: 0.15 },
          },
          {
            name: '猎手',
            color: '#f87171',
            count: 24,
            genome: {
              speed: 1.05,
              sense: 13,
              size: 1.6,
              aggression: 0.95,
              fear: 0,
              sociability: 0.1,
              reproThreshold: 200,
              metabolism: 1.1,
            },
            variance: { speed: 0.12, sense: 1.5 },
          },
        ],
      }),
  },
  {
    id: 'garden',
    title: '和平花园',
    desc: '没有杀戮，只有种群与资源的拉锯。观察纯粹的竞争与共赢。',
    spec: (seed) =>
      makeSpec('和平花园', seed, {
        food: { maxPerCell: 24, regrow: 0.02 },
        terrain: { obstacleRatio: 0.03, hazardRatio: 0 },
        species: [
          {
            name: '花瓣',
            color: '#f472b6',
            count: 200,
            genome: { speed: 0.4, sense: 6, aggression: 0, fear: 0.2, sociability: 0.7 },
            variance: { hue: 30 },
          },
        ],
      }),
  },
  {
    id: 'desert',
    title: '荒漠试炼',
    desc: '贫瘠、危险、稀疏。只有最节俭高效的生命才能延续。',
    spec: (seed) =>
      makeSpec('荒漠试炼', seed, {
        width: 200,
        height: 200,
        food: { maxPerCell: 6, regrow: 0.004 },
        terrain: { obstacleRatio: 0.04, hazardRatio: 0.08 },
        rules: { mutationRate: 0.2, maxPopulation: 800 },
        species: [
          {
            name: '耐旱者',
            color: '#eab308',
            count: 80,
            genome: {
              speed: 0.35,
              sense: 12,
              size: 0.7,
              metabolism: 0.7,
              aggression: 0.1,
              reproThreshold: 80,
            },
            variance: { sense: 2, metabolism: 0.15 },
          },
          {
            name: '沙行者',
            color: '#fb923c',
            count: 50,
            genome: {
              speed: 0.6,
              sense: 10,
              size: 0.9,
              metabolism: 0.9,
              aggression: 0.4,
              reproThreshold: 100,
            },
            variance: { aggression: 0.2 },
          },
        ],
      }),
  },
  {
    id: 'boiling',
    title: '突变沸腾',
    desc: '高突变率、高承载力。演化加速运转，新物种层出不穷。',
    spec: (seed) =>
      makeSpec('突变沸腾', seed, {
        food: { maxPerCell: 22, regrow: 0.025 },
        rules: { mutationRate: 0.45, maxPopulation: 4000 },
        species: [
          {
            name: '始祖体',
            color: '#22d3ee',
            count: 300,
            genome: { speed: 0.5, sense: 8, aggression: 0.2 },
            variance: { speed: 0.2, sense: 2, aggression: 0.25, size: 0.3 },
          },
        ],
      }),
  },
  {
    id: 'lake-continent',
    title: '千湖大陆',
    desc: '湿润大陆湖泊星罗棋布。岸狼会追猎到水边、捕获贴岸的鱼，湖鲈也伏击岸边的陆生生物——每片湖都是独立的物种孵化器。',
    spec: (seed) =>
      makeSpec('千湖大陆', seed, {
        food: { maxPerCell: 20, regrow: 0.018 },
        biomes: { oceanRatio: 0.1, freshwater: 0.12 },
        species: [
          {
            name: '银鲢',
            color: '#7dd3fc',
            count: 120,
            habitat: BIOME_FRESHWATER,
            genome: { speed: 0.6, sense: 8, aggression: 0, sociability: 0.75 },
            variance: { speed: 0.1, sense: 1 },
          },
          {
            name: '岸羚',
            color: '#a3e635',
            count: 110,
            genome: { speed: 0.75, sense: 9, size: 0.85, aggression: 0, fear: 0.7, sociability: 0.5 },
            variance: { speed: 0.12, sense: 1.5, fear: 0.1 },
          },
          {
            name: '岸狼',
            color: '#f43f5e',
            count: 18,
            genome: {
              speed: 1.0,
              sense: 12,
              size: 1.35,
              aggression: 0.9,
              fear: 0,
              sociability: 0.15,
              reproThreshold: 190,
              metabolism: 1.05,
            },
            variance: { speed: 0.1, sense: 1.5 },
          },
          {
            name: '泽鳄',
            color: '#16a34a',
            count: 12,
            habitat: BIOME_AMPHIBIAN,
            genome: {
              speed: 0.85,
              sense: 11,
              size: 1.5,
              aggression: 0.85,
              fear: 0,
              reproThreshold: 200,
              metabolism: 1.0,
            },
            variance: { speed: 0.1, sense: 1.5 },
          },
          {
            name: '湖鲈',
            color: '#f87171',
            count: 22,
            habitat: BIOME_FRESHWATER,
            genome: {
              speed: 0.95,
              sense: 12,
              size: 1.4,
              aggression: 0.9,
              fear: 0,
              reproThreshold: 190,
            },
            variance: { speed: 0.1, sense: 1.5 },
          },
        ],
      }),
  },
  {
    id: 'archipelago',
    title: '群岛海域',
    desc: '汪洋中的岛链。海洋鱼群在礁间繁衍，陆上小种群被大海彻底隔离——看地理隔离如何催生新物种。',
    spec: (seed) =>
      makeSpec('群岛海域', seed, {
        food: { maxPerCell: 16, regrow: 0.016 },
        biomes: { oceanRatio: 0.4, freshwater: 0.02 },
        rules: {
          mutationRate: 0.18,
          maxPopulation: 2600,
          sexualReproduction: true,
          disasters: { enabled: true, severity: 0.5 },
        },
        species: [
          {
            name: '沙丁群',
            color: '#38bdf8',
            count: 200,
            habitat: BIOME_OCEAN,
            genome: { speed: 0.7, sense: 9, size: 0.7, aggression: 0, fear: 0.6, sociability: 0.85 },
            variance: { speed: 0.12, sense: 1.5 },
          },
          {
            name: '礁蟹',
            color: '#fb923c',
            count: 80,
            habitat: BIOME_OCEAN,
            genome: { speed: 0.4, sense: 7, size: 0.6, aggression: 0.3, metabolism: 0.8 },
            variance: { aggression: 0.2 },
          },
          {
            name: '岛民',
            color: '#facc15',
            count: 90,
            genome: { speed: 0.55, sense: 8, aggression: 0.1, sociability: 0.4 },
            variance: { speed: 0.1, sense: 1 },
          },
          {
            name: '海猎者',
            color: '#f87171',
            count: 16,
            habitat: BIOME_OCEAN,
            genome: {
              speed: 1.1,
              sense: 13,
              size: 1.5,
              aggression: 0.95,
              fear: 0,
              reproThreshold: 200,
              metabolism: 1.1,
            },
            variance: { speed: 0.1, sense: 1.5 },
          },
        ],
      }),
  },
];

/** 世界创建器的默认起点（空白 + 一支种群） */
export function blankSpec(seed: number): WorldSpec {
  return makeSpec('新世界', seed, {
    species: [
      {
        name: '始祖体',
        color: '#34d399',
        count: 100,
        genome: { aggression: 0.1 },
        variance: { speed: 0.1, sense: 1 },
      },
    ],
  });
}

/** 供 LLM / 规则生成使用的完整默认值（在部分字段缺失时补齐） */
export function normalizeSpec(raw: Partial<WorldSpec> & { species?: WorldSpec['species'] }, seed: number): WorldSpec {
  const base = blankSpec(seed);
  return {
    name: raw.name?.slice(0, 40) || base.name,
    seed,
    width: clampInt(raw.width ?? base.width, 40, 280),
    height: clampInt(raw.height ?? base.height, 40, 280),
    food: {
      maxPerCell: clampNum(raw.food?.maxPerCell ?? base.food.maxPerCell, 2, 60),
      regrow: clampNum(raw.food?.regrow ?? base.food.regrow, 0.001, 0.1),
    },
    terrain: {
      obstacleRatio: clampNum(raw.terrain?.obstacleRatio ?? base.terrain.obstacleRatio, 0, 0.3),
      hazardRatio: clampNum(raw.terrain?.hazardRatio ?? base.terrain.hazardRatio, 0, 0.2),
    },
    // 生态圈透传（不注入默认水——预设是否带水由预设自己决定，旧世界保持纯陆地）
    biomes: raw.biomes
      ? {
          oceanRatio: clampNum(raw.biomes.oceanRatio ?? 0, 0, 0.45),
          freshwater: clampNum(raw.biomes.freshwater ?? 0, 0, 0.25),
        }
      : undefined,
    species:
      raw.species && raw.species.length > 0
        ? raw.species.slice(0, 6).map((s, i) => ({
            name: s.name?.slice(0, 12) || `物种 #${i + 1}`,
            color: /^#[0-9a-f]{6}$/i.test(s.color ?? '') ? s.color : base.species[i % base.species.length].color,
            count: clampInt(s.count ?? 100, 1, 600),
            genome: { ...base.species[0].genome, ...s.genome },
            variance: { ...(s.variance ?? {}) },
            habitat: clampInt(s.habitat ?? 0, 0, 3),
          }))
        : base.species,
    rules: {
      mutationRate: clampNum(raw.rules?.mutationRate ?? base.rules.mutationRate, 0, 0.6),
      maxPopulation: clampInt(raw.rules?.maxPopulation ?? base.rules.maxPopulation, 100, 20000),
      // 预设覆写 rules 时未提及的字段沿用默认，避免整体替换丢字段
      sexualReproduction: raw.rules?.sexualReproduction ?? base.rules.sexualReproduction,
      disasters: raw.rules?.disasters
        ? {
            enabled: !!raw.rules.disasters.enabled,
            severity: clampNum(raw.rules.disasters.severity ?? 0.5, 0.1, 1),
          }
        : base.rules.disasters,
    },
  };
}

function clampNum(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function clampInt(v: number, min: number, max: number): number {
  return Math.round(clampNum(v, min, max));
}
