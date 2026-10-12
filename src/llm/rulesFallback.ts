import { blankSpec, normalizeSpec } from '../engine/presets';
import {
  BIOME_FRESHWATER,
  BIOME_LAND,
  BIOME_OCEAN,
  DEFAULT_GENOME,
  GENE_KEYS,
  GENE_RANGE,
  type GeneKey,
  type Genome,
  type SpeciesTemplate,
  type WorldSpec,
} from '../engine/types';

/**
 * 离线规则兜底：完全不依赖模型服务，用关键词匹配（中英文均支持）直接调制
 * blankSpec(seed)，生成一个主题化、合法、可玩的世界定义。
 *
 * 流程：识别主题标志并调制世界参数 → 组建物种名单（基础种 / 猎手 / 填充种）
 * → 施加基因级调制 → 按主题命名配色 → GENE_RANGE 钳制 → normalizeSpec 补全钳制。
 *
 * 返回 applied 数组（中文），逐条描述生效的规则，供 UI 展示。
 * 注意：normalizeSpec 不钳制基因组，因此基因值在这里单独做 GENE_RANGE 钳制。
 */

/** 主题的命名与配色素材 */
interface ThemeStyle {
  /** 主题色相基准（0..360） */
  hue: number;
  /** 温顺物种候选名（按序取用，超出后循环） */
  prey: string[];
  /** 猎手物种候选名（可为空，空时回退到 neutral 主题） */
  hunter: string[];
}

const THEME_STYLES: Record<string, ThemeStyle> = {
  desert: { hue: 48, prey: ['耐旱者', '沙行者', '石居者', '旱地龟'], hunter: ['沙蝎', '沙暴猎手'] },
  ocean: { hue: 205, prey: ['浮游者', '滤食鱼', '灯鱼', '环流者'], hunter: ['深海猎手', '利齿鱼'] },
  hot: { hue: 25, prey: ['烈日行者', '耐热者', '灼背兽', '旱獭'], hunter: ['炎牙', '烈日猛禽'] },
  cold: { hue: 195, prey: ['耐寒者', '霜皮兽', '冰原漫步者', '雪绒'], hunter: ['冰狼', '雪原猎手'] },
  peace: { hue: 330, prey: ['花瓣', '歌鸣者', '绒球', '游鱼'], hunter: [] },
  neutral: { hue: 140, prey: ['始祖体', '原初体', '漂泊者', '拾荒者'], hunter: ['猎手', '掠食者'] },
};

/** 命名主题 → 世界名（未命中任何主题时沿用 blankSpec 的「新世界」） */
const WORLD_NAMES: Record<string, string> = {
  desert: '荒漠世界',
  ocean: '海洋世界',
  hot: '炎热世界',
  cold: '冰封世界',
  peace: '和平花园',
  barren: '荒芜之地',
  fertile: '富饶之地',
};

/** 同主题不同物种的色相偏移（保持同色系又互有区分，最大偏移 ±20） */
const HUE_OFFSETS = [0, 10, 20, -10, -20, 5];

/** 把某个基因乘以系数（字段缺省时以 DEFAULT_GENOME 为基准） */
function scaleGene(g: Partial<Genome>, key: GeneKey, factor: number): void {
  g[key] = (g[key] ?? DEFAULT_GENOME[key]) * factor;
}

/** 把基因值钳制到 GENE_RANGE 合法区间（只保留显式给出的字段） */
function clampGenome(g: Partial<Genome>): Partial<Genome> {
  const out: Partial<Genome> = {};
  for (const key of GENE_KEYS) {
    const v = g[key];
    if (v === undefined) continue;
    const [lo, hi] = GENE_RANGE[key];
    out[key] = Math.min(hi, Math.max(lo, v));
  }
  return out;
}

/** HSL → #rrggbb（用于按主题生成物种代表色） */
function hslToHex(h: number, s: number, l: number): string {
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
  const to255 = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}

/**
 * 离线规则解析：以 blankSpec(seed) 为基底，按关键词调制出一个完整 WorldSpec。
 *
 * @param nl   用户的自然语言描述（中英文关键词均可）
 * @param seed 世界随机种子
 */
export function generateWorldSpecByRules(nl: string, seed: number): { spec: WorldSpec; applied: string[] } {
  const text = nl.toLowerCase();
  const has = (...words: string[]): boolean => words.some((w) => text.includes(w));

  // 以 blankSpec 为基底展开可变草稿
  const base = blankSpec(seed);
  const food = { ...base.food };
  const terrain = { ...base.terrain };
  const rules = { ...base.rules };
  let width = base.width;
  let height = base.height;
  const species: SpeciesTemplate[] = base.species.map((s) => ({
    ...s,
    genome: { ...s.genome },
    variance: { ...s.variance },
  }));

  const applied: string[] = [];
  const colorThemes: string[] = []; // 命中的色彩主题（先到先得）
  const nameThemes: string[] = []; // 命中的命名主题（先到先得）

  // ---- 地貌 / 气候主题 ----
  if (has('沙漠', '干旱', 'desert', 'arid')) {
    food.maxPerCell *= 0.35;
    terrain.hazardRatio += 0.06;
    colorThemes.push('desert');
    nameThemes.push('desert');
    applied.push('沙漠/干旱主题：食物上限 ×0.35，危险区占比 +0.06，色系偏黄');
  }
  if (has('海洋', '大海', '海底', 'ocean')) {
    food.maxPerCell *= 1.3;
    terrain.obstacleRatio = 0.02;
    colorThemes.push('ocean');
    nameThemes.push('ocean');
    applied.push('海洋主题：食物上限 ×1.3，障碍物占比 0.02，物种色相偏蓝');
  }

  // ---- 生态圈（水域复合地图）：群岛 > 海洋 > 湖泊 的优先级决定栖息域 ----
  let biomes: WorldSpec['biomes'];
  let waterMode: 'islands' | 'ocean' | 'fresh' | null = null;
  if (has('群岛', '岛屿', '岛链', 'archipelago', 'islands')) {
    biomes = { oceanRatio: 0.4, freshwater: 0.02 };
    waterMode = 'islands';
    applied.push('群岛/岛屿：海洋占地 40%，第一支种群留岛、其余下海');
  } else if (has('海洋', '大海', '海底', 'ocean')) {
    biomes = { oceanRatio: 0.35, freshwater: 0.02 };
    waterMode = 'ocean';
    applied.push('海洋世界：海洋占地 35%，物种栖居咸水海域');
  } else if (has('湖泊', '淡水', '湿地', 'lake', 'freshwater')) {
    biomes = { oceanRatio: 0.05, freshwater: 0.12 };
    waterMode = 'fresh';
    applied.push('湖泊/淡水：湖泊占陆地 12%，物种栖居淡水水域');
  }
  const hot = has('高温', '炎热', '热带', '酷热', 'hot', 'tropical', 'scorching');
  const cold = has('寒冷', '冰', '极地', '冻', 'cold', 'arctic', 'polar', 'frozen', 'ice');
  if (hot) {
    colorThemes.push('hot');
    nameThemes.push('hot');
    applied.push('高温/炎热/热带：全体代谢 ×1.3、速度 ×1.2');
  }
  if (cold) {
    colorThemes.push('cold');
    nameThemes.push('cold');
    applied.push('寒冷/冰/极地：全体代谢 ×0.75、速度 ×0.85');
  }
  const peace = has('和平', '无害', '花园', '伊甸', 'peace', 'peaceful', 'harmless', 'garden');
  if (peace) {
    terrain.hazardRatio = 0;
    food.maxPerCell *= 1.5;
    colorThemes.push('peace');
    nameThemes.push('peace');
    applied.push('和平/花园：全体攻击性归零，危险区清零，食物上限 ×1.5');
  }

  // ---- 资源丰饶度 ----
  if (has('贫瘠', '荒芜', '贫乏', 'barren', 'desolate', 'sparse')) {
    food.maxPerCell *= 0.4;
    food.regrow *= 0.5;
    nameThemes.push('barren');
    applied.push('贫瘠/荒芜：食物上限 ×0.4，再生速率 ×0.5');
  }
  if (has('富饶', '肥沃', '丰盛', '富足', 'fertile', 'lush', 'abundant')) {
    food.maxPerCell *= 1.5;
    food.regrow *= 1.5;
    nameThemes.push('fertile');
    applied.push('富饶/肥沃/丰盛：食物上限 ×1.5，再生速率 ×1.5');
  }

  // ---- 演化节奏（先判稳定，避免「低突变」误触高突变） ----
  if (has('稳定', '低突变', '低度突变', '缓慢演化', 'stable', 'low mutation', 'calm')) {
    rules.mutationRate = Math.min(rules.mutationRate, 0.05);
    applied.push('稳定/低突变：突变率压到 ≤0.05');
  } else if (has('快速演化', '剧变', '高突变', '突变', '高速演化', 'rapid', 'volatile', 'mutat')) {
    rules.mutationRate = Math.max(rules.mutationRate, 0.45);
    applied.push('快速演化/剧变/高突变：突变率提到 ≥0.4');
  }

  // ---- 危险程度 ----
  if (has('危险', '致命', '危机', '险恶', 'dangerous', 'deadly', 'lethal', 'hostile')) {
    terrain.hazardRatio = Math.max(terrain.hazardRatio, 0.1);
    applied.push('危险/致命：危险区占比 ≥0.1');
  }
  if (has('安全', 'safe', 'secure')) {
    terrain.hazardRatio = 0;
    applied.push('安全：危险区清零');
  }

  // ---- 世界尺寸 ----
  if (has('大世界', '广阔', '辽阔', '浩瀚', 'large world', 'vast', 'huge', 'expansive')) {
    width = 220;
    height = 220;
    applied.push('大世界/广阔：地图扩至 220×220');
  }
  if (has('小世界', '微型', '狭小', '紧凑', 'small world', 'tiny', 'compact')) {
    width = 90;
    height = 90;
    applied.push('小世界：地图缩至 90×90');
  }

  // ---- 物种构成 ----
  const hunterWanted = has('捕食者', '凶猛', '猎杀', '猎手', '掠食', '凶残', 'predator', 'fierce', 'savage', 'hunter');
  const preyWanted = has('猎物', '食草', '草食', '温顺', 'prey', 'herbivore', 'docile', 'gentle');

  // 追加猎手物种：高攻击、大体型、高速，数量为基础种群的 1/8
  const hunter: SpeciesTemplate | null = hunterWanted
    ? {
        name: '猎手',
        color: '#ef4444',
        count: Math.max(1, Math.round(species[0].count / 8)),
        genome: {
          speed: 1.05,
          sense: 13,
          size: 1.6,
          metabolism: 1.1,
          aggression: 0.95,
          fear: 0,
          sociability: 0.1,
          reproThreshold: 200,
        },
        variance: { speed: 0.12, sense: 1.5 },
      }
    : null;
  if (hunter !== null) species.push(hunter);

  // 数字解析：「N 种生物/物种」→ 物种数 N（最多 6，支持阿拉伯数字与常见中文数字）
  let wantSpecies: number | null = null;
  const digitMatch = text.match(/(\d+)\s*种/);
  const cnMatch = text.match(/([一二两二三四五六])\s*种/);
  if (digitMatch !== null) {
    const n = Number.parseInt(digitMatch[1], 10);
    if (n > 6) applied.push(`物种数量：描述为 ${n} 种，已按上限取 6 种`);
    wantSpecies = Math.min(6, Math.max(1, n));
  } else if (cnMatch !== null) {
    const cnNum: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    wantSpecies = cnNum[cnMatch[1]] ?? null;
  }

  // 用主题化填充物种补齐目标数量；超出的从尾部裁掉（填充种先于猎手，猎手先于基础种）
  const target = wantSpecies ?? (hunterWanted ? 2 : 1);
  const baseCount = species[0].count;
  const makeFiller = (i: number): SpeciesTemplate => ({
    name: '',
    color: '#34d399',
    count: Math.max(1, Math.round(baseCount * (0.7 - 0.15 * i))),
    genome: {
      speed: 0.5 + 0.2 * i,
      sense: 7 + i * 1.5,
      size: 0.8 + 0.2 * i,
      metabolism: 1,
      aggression: 0.1,
      fear: 0.4,
      sociability: 0.3 + 0.15 * i,
      reproThreshold: 100 + i * 20,
    },
    variance: { speed: 0.12, sense: 1.5 },
  });
  let fillerCount = 0;
  while (species.length < target) {
    species.push(makeFiller(fillerCount));
    fillerCount += 1;
  }
  while (species.length > target && species.length > 1) {
    species.pop();
  }

  if (hunter !== null && species.includes(hunter)) {
    applied.push('捕食者/凶猛/猎杀：追加猎手物种（攻击性 ≥0.9、大体型、高速，数量为基础种群的 1/8）');
  }
  if (wantSpecies !== null) {
    applied.push(`数字解析：物种数量按描述设为 ${species.length} 支`);
  }

  // ---- 基因级调制（在物种名单确定后统一施加，确保覆盖猎手与填充种） ----
  if (hot) {
    for (const s of species) {
      scaleGene(s.genome, 'metabolism', 1.3);
      scaleGene(s.genome, 'speed', 1.2);
    }
  }
  if (cold) {
    for (const s of species) {
      scaleGene(s.genome, 'metabolism', 0.75);
      scaleGene(s.genome, 'speed', 0.85);
    }
  }
  if (preyWanted) {
    // 温顺猎物：除猎手外的所有物种攻击性归零、警惕性提高
    for (const s of species) {
      if (s === hunter) continue;
      s.genome.aggression = 0;
      s.genome.fear = Math.max(s.genome.fear ?? DEFAULT_GENOME.fear, 0.8);
    }
    applied.push('猎物/食草/温顺：温顺物种攻击性归零、警惕性提高');
  }
  if (peace) {
    // 和平世界压倒一切：全体攻击性归零
    for (const s of species) s.genome.aggression = 0;
  }

  // ---- 生态圈栖息域（物种名单确定后统一施加） ----
  if (waterMode === 'ocean') {
    for (const s of species) s.habitat = BIOME_OCEAN;
  } else if (waterMode === 'fresh') {
    for (const s of species) s.habitat = BIOME_FRESHWATER;
  } else if (waterMode === 'islands') {
    for (let i = 0; i < species.length; i++) species[i].habitat = i === 0 ? BIOME_LAND : BIOME_OCEAN;
  }

  // ---- 按主题命名与配色 ----
  const styleKey = colorThemes[0] ?? 'neutral';
  const style = THEME_STYLES[styleKey] ?? THEME_STYLES.neutral;
  const hunterPool = style.hunter.length > 0 ? style.hunter : THEME_STYLES.neutral.hunter;
  let preyIdx = 0;
  for (const s of species) {
    if (s === hunter) {
      s.name = hunterPool[0];
    } else {
      s.name = style.prey[preyIdx % style.prey.length];
      preyIdx += 1;
    }
  }
  for (let i = 0; i < species.length; i += 1) {
    const s = species[i];
    const hue = Math.min(360, Math.max(0, style.hue + HUE_OFFSETS[i % HUE_OFFSETS.length]));
    s.color = hslToHex(hue, 0.68, 0.6);
    s.genome.hue = Math.round(hue);
  }

  // 世界名：取第一个命中的命名主题
  const theme0 = nameThemes[0];
  const worldName = theme0 !== undefined ? WORLD_NAMES[theme0] ?? base.name : base.name;

  if (applied.length === 0) {
    applied.push('未识别到明确主题：沿用基础模板（一支中性始祖种群），仅做统一命名配色');
  }

  // ---- 钳制与补全（基因组必须在此钳制，normalizeSpec 不处理基因组范围） ----
  for (const s of species) {
    s.genome = clampGenome(s.genome);
    s.count = Math.round(Math.min(600, Math.max(1, s.count)));
    s.name = s.name.slice(0, 12);
  }

  const spec = normalizeSpec({ name: worldName, width, height, food, terrain, biomes, species, rules }, seed);
  return { spec, applied };
}
