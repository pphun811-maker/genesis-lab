import {
  BIOME_FRESHWATER,
  BIOME_LAND,
  BIOME_OCEAN,
  DEFAULT_GENOME,
  GENE_KEYS,
  GENE_RANGE,
  type GeneKey,
  type Genome,
} from './types';

/**
 * 物种命名器：由基因组（+栖息域）确定性地推导现实生物风格的命名。
 *
 *   name  —— 俗名，遵循中文动物命名惯例「[大小][颜色][类群]」：
 *            陆地：大灰狼 / 赤狐 / 大眼鹰 / 盲鼠 / 巨金象 / 疾羚
 *            淡水：青鲈 / 巨银鲶 / 大眼鳜 / 疾鳟 / 微绿鳉
 *            海洋：蓝鲨 / 巨蓝鲸 / 大眼章鱼 / 疾鲔 / 微蓝鳀
 *   latin —— 拉丁双名「属名 种加词」，属名来自类群（按栖息域分派表），
 *            种加词来自最显著的性状偏离（ferox 凶猛 / celer 迅速 / caecus 盲…）
 *   tags  —— 至多四枚特征标签（淡水/海洋物种以栖息域标签开头）
 *   niche —— 一句话生态位描述
 *
 * 纯函数：无随机、无状态，相同基因组+栖息域必得相同描述。
 * 陆地类群表与历史版本逐字一致（旧世界新物种命名不受本轮影响）。
 */

export interface SpeciesDescription {
  name: string;
  latin: string;
  tags: string[];
  niche: string;
}

// ---------------------------------------------------------------------------
// 俗名构件
// ---------------------------------------------------------------------------

/** 体色色相 → 颜色字（与画布上 hue 着色一致，名字即外观） */
function hueColorChar(hue: number): string {
  const h = ((hue % 360) + 360) % 360;
  if (h < 15 || h >= 345) return '赤';
  if (h < 45) return '橙';
  if (h < 70) return '金';
  if (h < 100) return '黄';
  if (h < 150) return '绿';
  if (h < 190) return '青';
  if (h < 230) return '蓝';
  if (h < 270) return '靛';
  if (h < 310) return '紫';
  return '绯';
}

/** 生态类群 → 类群字（按角色优先级命中）与拉丁属名（陆地） */
const ARCHETYPES: Array<{
  test: (g: Genome) => boolean;
  base: string;
  genus: string;
}> = [
  { test: (g) => g.aggression >= 0.5 && g.size >= 1.6, base: '虎', genus: 'Panthera' },
  { test: (g) => g.aggression >= 0.5 && g.size >= 0.9, base: '狼', genus: 'Canis' },
  { test: (g) => g.aggression >= 0.5, base: '鼬', genus: 'Mustela' },
  { test: (g) => g.size >= 2.2, base: '象', genus: 'Elephas' },
  { test: (g) => g.sense >= 12, base: '鹰', genus: 'Aquila' },
  { test: (g) => g.speed >= 1.2, base: '羚', genus: 'Gazella' },
  { test: (g) => g.metabolism <= 0.7, base: '龟', genus: 'Testudo' },
  { test: (g) => g.fear >= 0.6, base: '兔', genus: 'Lepus' },
  { test: (g) => g.sociability >= 0.6 && g.size >= 1.2, base: '牛', genus: 'Bos' },
  { test: (g) => g.sociability >= 0.6, base: '雀', genus: 'Passer' },
  { test: (g) => g.size >= 1.7, base: '犀', genus: 'Rhinoceros' },
  { test: (g) => g.size >= 1.3, base: '鹿', genus: 'Cervus' },
  { test: (g) => g.size <= 0.65, base: '鼠', genus: 'Mus' },
  { test: () => true, base: '狐', genus: 'Vulpes' },
];

/** 淡水类群表：湖泊与湿地生态位——伏击大鱼/群游小鱼/底栖虾螺 */
const FRESHWATER_ARCHETYPES: Array<{
  test: (g: Genome) => boolean;
  base: string;
  genus: string;
}> = [
  { test: (g) => g.aggression >= 0.5 && g.size >= 1.6, base: '鲶', genus: 'Silurus' },
  { test: (g) => g.aggression >= 0.5 && g.size >= 0.9, base: '鲈', genus: 'Perca' },
  { test: (g) => g.aggression >= 0.5, base: '虾', genus: 'Macrobrachium' },
  { test: (g) => g.size >= 2.2, base: '鲟', genus: 'Acipenser' },
  { test: (g) => g.sense >= 12, base: '鳜', genus: 'Siniperca' },
  { test: (g) => g.speed >= 1.2, base: '鳟', genus: 'Salmo' },
  { test: (g) => g.metabolism <= 0.7, base: '鳖', genus: 'Trionyx' },
  { test: (g) => g.fear >= 0.6, base: '螺', genus: 'Lymnaea' },
  { test: (g) => g.sociability >= 0.6 && g.size >= 1.2, base: '鲢', genus: 'Hypophthalmichthys' },
  { test: (g) => g.sociability >= 0.6, base: '鲦', genus: 'Hemiculter' },
  { test: (g) => g.size >= 1.7, base: '鳙', genus: 'Aristichthys' },
  { test: (g) => g.size >= 1.3, base: '鲩', genus: 'Ctenopharyngodon' },
  { test: (g) => g.size <= 0.65, base: '鳉', genus: 'Oryzias' },
  { test: () => true, base: '鲫', genus: 'Carassius' },
];

/** 海洋类群表：远洋/礁区生态位——顶级鲨鲸/群游鲭鲱/底栖蟹星 */
const OCEAN_ARCHETYPES: Array<{
  test: (g: Genome) => boolean;
  base: string;
  genus: string;
}> = [
  { test: (g) => g.aggression >= 0.5 && g.size >= 1.6, base: '鲨', genus: 'Carcharias' },
  { test: (g) => g.aggression >= 0.5 && g.size >= 0.9, base: '鳕', genus: 'Gadus' },
  { test: (g) => g.aggression >= 0.5, base: '蟹', genus: 'Carcinus' },
  { test: (g) => g.size >= 2.2, base: '鲸', genus: 'Balaena' },
  { test: (g) => g.sense >= 12, base: '章鱼', genus: 'Octopus' },
  { test: (g) => g.speed >= 1.2, base: '鲔', genus: 'Thunnus' },
  { test: (g) => g.metabolism <= 0.7, base: '星', genus: 'Asterias' },
  { test: (g) => g.fear >= 0.6, base: '鲱', genus: 'Clupea' },
  { test: (g) => g.sociability >= 0.6 && g.size >= 1.2, base: '豚', genus: 'Delphinus' },
  { test: (g) => g.sociability >= 0.6, base: '鲭', genus: 'Scomber' },
  { test: (g) => g.size >= 1.7, base: '鳐', genus: 'Raja' },
  { test: (g) => g.size >= 1.3, base: '鲷', genus: 'Sparus' },
  { test: (g) => g.size <= 0.65, base: '鳀', genus: 'Engraulis' },
  { test: () => true, base: '鲹', genus: 'Caranx' },
];

/** 栖息域 → 类群表（陆地表即历史表，保证旧世界命名不变） */
const ARCHETYPES_BY_HABITAT: ReadonlyArray<typeof ARCHETYPES> = [
  ARCHETYPES,
  FRESHWATER_ARCHETYPES,
  OCEAN_ARCHETYPES,
];

/** 水域物种的特征标签前缀（陆地物种不加前缀，与历史行为一致） */
const HABITAT_TAG: Record<number, string> = {
  [BIOME_FRESHWATER]: '淡水',
  [BIOME_OCEAN]: '海洋',
};

/** 形体描述符：基因偏离触发，size 级描述符插在颜色前，其余直接缀在类群前 */
const DESCRIPTORS: Array<{
  key: Exclude<GeneKey, 'hue'>;
  test: (v: number) => boolean;
  ch: string;
  /** size 级（巨/大/小/微）采用「大灰狼」语序，其余采用「长耳鸮」语序 */
  sizeClass: boolean;
}> = [
  { key: 'size', test: (v) => v >= 2.0, ch: '巨', sizeClass: true },
  { key: 'size', test: (v) => v >= 1.4 && v < 2.0, ch: '大', sizeClass: true },
  { key: 'size', test: (v) => v <= 0.5, ch: '微', sizeClass: true },
  { key: 'size', test: (v) => v > 0.5 && v <= 0.7, ch: '小', sizeClass: true },
  { key: 'sense', test: (v) => v >= 13, ch: '大眼', sizeClass: false },
  { key: 'sense', test: (v) => v <= 5, ch: '盲', sizeClass: false },
  { key: 'speed', test: (v) => v >= 1.4, ch: '疾', sizeClass: false },
  { key: 'speed', test: (v) => v <= 0.3, ch: '缓', sizeClass: false },
  { key: 'aggression', test: (v) => v >= 0.65, ch: '尖牙', sizeClass: false },
  { key: 'metabolism', test: (v) => v <= 0.6, ch: '懒', sizeClass: false },
];

const DESCRIPTOR_SIGMA = 0.12;

// ---------------------------------------------------------------------------
// 拉丁种加词
// ---------------------------------------------------------------------------

/** 显著偏离基因 → 拉丁种加词 */
const EPITHETS: Array<{
  key: Exclude<GeneKey, 'hue'>;
  high: string;
  low: string;
}> = [
  { key: 'speed', high: 'celer', low: 'tardus' },
  { key: 'sense', high: 'acutus', low: 'caecus' },
  { key: 'size', high: 'magnus', low: 'minor' },
  { key: 'metabolism', high: 'avidus', low: 'piger' },
  { key: 'aggression', high: 'ferox', low: 'placidus' },
  { key: 'fear', high: 'timidus', low: 'audax' },
  { key: 'sociability', high: 'gregarius', low: 'solitarius' },
  { key: 'reproThreshold', high: 'rarus', low: 'fecundus' },
];

const EPITHET_SIGMA = 0.08;
const EPITHET_DEFAULT = 'vulgaris';

// ---------------------------------------------------------------------------
// 特征标签与生态位（沿用既有风格）
// ---------------------------------------------------------------------------

const TAG_RULES: Array<{
  key: Exclude<GeneKey, 'hue'>;
  high: number;
  highTag: string;
  low: number;
  lowTag: string;
}> = [
  { key: 'speed', high: 1.2, highTag: '迅捷', low: 0.35, lowTag: '迟缓' },
  { key: 'sense', high: 12, highTag: '锐目', low: 5, lowTag: '近视' },
  { key: 'size', high: 1.8, highTag: '巨躯', low: 0.65, lowTag: '微小' },
  { key: 'metabolism', high: 1.3, highTag: '高耗', low: 0.7, lowTag: '低耗' },
  { key: 'aggression', high: 0.5, highTag: '凶猛', low: 0.1, lowTag: '温和' },
  { key: 'fear', high: 0.6, highTag: '胆小', low: 0.2, lowTag: '大胆' },
  { key: 'sociability', high: 0.6, highTag: '群居', low: 0.15, lowTag: '独行' },
  { key: 'reproThreshold', high: 200, highTag: '晚育', low: 90, lowTag: '早繁' },
];

/**
 * 由基因组 + 栖息域推导物种描述（俗名 + 拉丁双名 + 标签 + 生态位）。
 * habitat 缺省视为陆地（旧调用方/旧快照行为不变）。
 */
export function describeGenome(g: Genome, habitat: number = BIOME_LAND): SpeciesDescription {
  // ---- 各基因归一化偏离（hue 只管颜色，不参与性状判断）----
  const devs = {} as Record<Exclude<GeneKey, 'hue'>, number>;
  let bestGene: Exclude<GeneKey, 'hue'> | null = null;
  let bestDev = 0;
  for (const key of GENE_KEYS) {
    if (key === 'hue') continue;
    const [min, max] = GENE_RANGE[key];
    devs[key] = (g[key] - DEFAULT_GENOME[key]) / (max - min);
    if (Math.abs(devs[key]) > Math.abs(bestDev)) {
      bestDev = devs[key];
      bestGene = key;
    }
  }

  // ---- 类群（拉丁属名）：按栖息域分派类群表 ----
  const table = ARCHETYPES_BY_HABITAT[habitat] ?? ARCHETYPES;
  let base = table[table.length - 1].base;
  let genus = table[table.length - 1].genus;
  for (const a of table) {
    if (a.test(g)) {
      base = a.base;
      genus = a.genus;
      break;
    }
  }

  // ---- 形体描述符（取显著偏离最大者）----
  let descriptor: { ch: string; sizeClass: boolean } | null = null;
  let descriptorDev = 0;
  for (const d of DESCRIPTORS) {
    if (!d.test(g[d.key])) continue;
    const dev = Math.abs(devs[d.key]);
    if (dev >= DESCRIPTOR_SIGMA && dev > descriptorDev) {
      descriptorDev = dev;
      descriptor = { ch: d.ch, sizeClass: d.sizeClass };
    }
  }

  // ---- 组名：大灰狼 / 长耳鸮 / 赤狐 三种语序 ----
  const color = hueColorChar(g.hue);
  let name: string;
  if (descriptor?.sizeClass) name = `${descriptor.ch}${color}${base}`;
  else if (descriptor) name = `${descriptor.ch}${base}`;
  else name = `${color}${base}`;

  // ---- 拉丁双名 ----
  let epithet = EPITHET_DEFAULT;
  if (bestGene !== null && Math.abs(bestDev) >= EPITHET_SIGMA) {
    const rule = EPITHETS.find((e) => e.key === bestGene)!;
    epithet = bestDev > 0 ? rule.high : rule.low;
  }
  const latin = `${genus} ${epithet}`;

  // ---- 特征标签 ----
  const tags: string[] = [];
  const habitatTag = HABITAT_TAG[habitat];
  if (habitatTag) tags.push(habitatTag); // 水域物种以栖息域标签开头
  for (const rule of TAG_RULES) {
    if (tags.length >= 4) break;
    const v = g[rule.key];
    if (v >= rule.high) tags.push(rule.highTag);
    else if (v <= rule.low) tags.push(rule.lowTag);
  }
  if (tags.length === 0) tags.push('均衡');

  return { name, latin, tags, niche: nicheOf(g) };
}

/** 一句话生态位：按捕食 → 避险 → 群居 → 游走 → 侦察的优先级定角色 */
function nicheOf(g: Genome): string {
  if (g.aggression >= 0.45) {
    return g.size >= 0.9
      ? '掠食者——主动猎杀比自己弱小的个体为生'
      : '小型猎手——凭偷袭与数量蚕食猎物';
  }
  if (g.fear >= 0.55) return '避险者——警觉怕险，遇威胁即逃';
  if (g.sociability >= 0.55) return '群居者——与同类抱团迁徙、共同觅食';
  if (g.speed >= 1.1) return '游走者——以速度换食物，居无定所';
  if (g.sense >= 12) return '侦察者——广域感知，总能先一步发现食物';
  return '机会主义者——随遇而安，就近觅食';
}
