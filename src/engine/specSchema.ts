import { z } from 'zod';
import { DEFAULT_GENOME, GENE_KEYS, GENE_RANGE, type GeneKey } from './types';

/**
 * WorldSpec 的 zod 校验 schema，用于校验 LLM 的输出。
 *
 * 约束与 presets.ts 中 normalizeSpec 的钳制范围保持一致：
 * - 这里负责「形状 + 数值范围」校验：越界即判为不合格，由 worldgen 附带错误摘要让 LLM 重试；
 * - 字段缺失是常态（LLM 会省略字段），因此所有字段全部可选，交给 normalizeSpec 补全默认值；
 * - 未在 schema 中声明的多余字段会被 zod 静默剥离，不会导致校验失败；
 * - 非整数值不在此拒绝：normalizeSpec 会四舍五入，与它的宽容度一致。
 */

/** 单个基因字段：数值且落在 GENE_RANGE 合法区间内，可省略 */
function geneField(key: GeneKey) {
  const [lo, hi] = GENE_RANGE[key];
  return z.number().min(lo).max(hi).optional();
}

/** 基因模板（全部字段可选） */
export const genomeSchema = z.object({
  speed: geneField('speed'),
  sense: geneField('sense'),
  size: geneField('size'),
  metabolism: geneField('metabolism'),
  aggression: geneField('aggression'),
  fear: geneField('fear'),
  sociability: geneField('sociability'),
  reproThreshold: geneField('reproThreshold'),
  hue: geneField('hue'),
});

/** 单个物种模板（全部字段可选） */
export const speciesSchema = z.object({
  name: z.string().max(12, '物种名不能超过 12 个字符').optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i, '颜色必须形如 #rrggbb 的十六进制格式').optional(),
  count: z.number().min(1).max(600).optional(),
  genome: genomeSchema.optional(),
  variance: z.record(z.string(), z.number()).optional(),
  habitat: z.number().int().min(0).max(2).optional(),
});

/** 完整世界定义（全部字段可选；species 若给出则需 1..6 个） */
export const worldSpecSchema = z.object({
  name: z.string().max(40).optional(),
  seed: z.number().optional(),
  width: z.number().min(40).max(280).optional(),
  height: z.number().min(40).max(280).optional(),
  food: z
    .object({
      maxPerCell: z.number().min(2).max(60).optional(),
      regrow: z.number().min(0.001).max(0.1).optional(),
    })
    .optional(),
  terrain: z
    .object({
      obstacleRatio: z.number().min(0).max(0.3).optional(),
      hazardRatio: z.number().min(0).max(0.2).optional(),
    })
    .optional(),
  biomes: z
    .object({
      oceanRatio: z.number().min(0).max(0.45).optional(),
      freshwater: z.number().min(0).max(0.25).optional(),
    })
    .optional(),
  species: z.array(speciesSchema).min(1).max(6).optional(),
  rules: z
    .object({
      mutationRate: z.number().min(0).max(0.6).optional(),
      maxPopulation: z.number().min(100).max(20000).optional(),
      sexualReproduction: z.boolean().optional(),
      disasters: z
        .object({
          enabled: z.boolean().optional(),
          severity: z.number().min(0.1).max(1).optional(),
        })
        .optional(),
    })
    .optional(),
});

/** 校验通过后的宽松输入形状（可交给 normalizeSpec 补全） */
export type WorldSpecInput = z.infer<typeof worldSpecSchema>;

// ---------------------------------------------------------------------------
// 给 LLM 看的格式说明
// ---------------------------------------------------------------------------

/** 各基因的中文含义（用于生成 prompt 说明，保持与 types.ts 注释一致） */
const GENE_LABELS: Record<GeneKey, string> = {
  speed: '移动速度（格/tick）',
  sense: '感知半径（格）',
  size: '体型（决定能量上限与咬合力，也会抬高代谢）',
  metabolism: '代谢率乘数（越大越耗能）',
  aggression: '攻击性（0=温和，1=嗜杀，倾向捕猎更小的异类）',
  fear: '恐惧（遇到威胁时的逃逸强度）',
  sociability: '群聚性（被同类吸引的程度）',
  reproThreshold: '繁殖所需能量阈值',
  hue: '体色色相',
};

/** 一个能通过全部约束的完整示例 */
const EXAMPLE_SPEC = {
  name: '炽热荒漠',
  width: 200,
  height: 200,
  food: { maxPerCell: 7, regrow: 0.004 },
  terrain: { obstacleRatio: 0.04, hazardRatio: 0.1 },
  species: [
    {
      name: '耐旱者',
      color: '#eab308',
      count: 90,
      genome: { speed: 0.4, sense: 12, size: 0.8, metabolism: 0.7, aggression: 0.1, reproThreshold: 80 },
      variance: { sense: 2 },
    },
    {
      name: '沙蝎',
      color: '#f87171',
      count: 14,
      genome: { speed: 1.1, sense: 13, size: 1.6, metabolism: 1.1, aggression: 0.95, fear: 0, reproThreshold: 200 },
    },
  ],
  rules: { mutationRate: 0.2, maxPopulation: 900 },
};

/** 生成给 LLM 看的 WorldSpec 字段说明：字段名、范围、含义与一个完整示例 */
export function describeSpecForPrompt(): string {
  const genomeLines = GENE_KEYS.map((key) => {
    const [lo, hi] = GENE_RANGE[key];
    return `        "${key}": ${DEFAULT_GENOME[key]},   // ${lo}..${hi}，${GENE_LABELS[key]}`;
  }).join('\n');

  return [
    '【WorldSpec 世界定义 JSON 格式说明】',
    '所有字段都可以省略（省略时系统会自动补全默认值），但给出的数值必须严格落在注释标注的范围内。无需输出 seed，系统会自行指定。',
    '',
    '{',
    '  "name": "世界名",                     // 字符串，≤40 字',
    '  "width": 160,                         // 数值，40..280，地图宽度（格数）',
    '  "height": 160,                        // 数值，40..280，地图高度（格数）',
    '  "food": {',
    '    "maxPerCell": 18,                   // 数值，2..60，每格食物能量上限（越大世界越富饶）',
    '    "regrow": 0.015                     // 数值，0.001..0.1，每 tick 食物再生比例',
    '  },',
  '  "terrain": {',
  '    "obstacleRatio": 0.05,              // 数值，0..0.3，障碍物占地比例',
  '    "hazardRatio": 0.02                 // 数值，0..0.2，危险区占地比例（进入会持续受伤）',
  '  },',
  '  "biomes": {                           // 可选：生态圈（复合地图）。省略 = 纯陆地世界',
  '    "oceanRatio": 0.1,                  // 数值，0..0.45，海洋（咸水）占地比例；水陆真隔离',
  '    "freshwater": 0.05                  // 数值，0..0.25，淡水湖泊占陆地的比例',
  '  },',
  '  "species": [                          // 数组，1..6 个物种',
  '    {',
  '      "name": "物种名",                 // 字符串，≤12 字，建议用有画面感的中文短名',
  '      "color": "#34d399",               // 物种代表色，格式 #rrggbb',
  '      "count": 100,                     // 数值，1..600，初始个体数量',
  '      "habitat": 0,                     // 可选：栖息域 0=陆地 1=淡水 2=海洋（硬隔离，不同域互不可入；省略=陆地）',
    '      "genome": {                       // 初始基因模板，以下字段全部可省略',
    genomeLines,
    '      },',
    '      "variance": { "speed": 0.1, "sense": 1 }    // 可选：各基因的初始随机方差',
    '    }',
    '  ],',
  '  "rules": {',
  '    "mutationRate": 0.15,               // 数值，0..0.6，繁殖时的基因突变率',
  '    "maxPopulation": 2500,              // 数值，100..20000，全场个体数量上限',
  '    "sexualReproduction": true,         // 可选：有性繁殖（求偶+基因交叉），缺省关闭',
  '    "disasters": { "enabled": true, "severity": 0.5 }  // 可选：灾变事件（旱灾/瘟疫），severity 0.1..1',
  '}',
  '',
  '【完整示例】',
    JSON.stringify(EXAMPLE_SPEC, null, 2),
  ].join('\n');
}
