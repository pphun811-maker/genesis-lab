/**
 * Genesis Lab 核心领域类型。
 *
 * WorldSpec 是世界的完整定义（可 JSON 序列化、可由 LLM 或参数面板生成）。
 * SimState 是某一 tick 的完整快照（可用于分叉实验、断点续跑）。
 */

// ---------------------------------------------------------------------------
// 基因
// ---------------------------------------------------------------------------

export interface Genome {
  /** 移动速度（格/tick） */
  speed: number;
  /** 感知半径（格） */
  sense: number;
  /** 体型：决定能量上限、咬合力、代谢 */
  size: number;
  /** 代谢率乘数 */
  metabolism: number;
  /** 攻击性：倾向捕猎更小的异类 */
  aggression: number;
  /** 恐惧：遇到威胁时逃逸强度 */
  fear: number;
  /** 群聚性：被同类吸引的程度 */
  sociability: number;
  /** 繁殖所需能量阈值 */
  reproThreshold: number;
  /** 体色色相（0..360），演化中可视漂移 */
  hue: number;
}

export type GeneKey = keyof Genome;

/** 每个基因的合法区间（突变时钳制，遗传距离归一化时使用） */
export const GENE_RANGE: Record<GeneKey, [number, number]> = {
  speed: [0.1, 2.4],
  sense: [2, 20],
  size: [0.4, 3.0],
  metabolism: [0.4, 2.0],
  aggression: [0, 1],
  fear: [0, 1],
  sociability: [0, 1],
  reproThreshold: [40, 320],
  hue: [0, 360],
};

export const GENE_KEYS = Object.keys(GENE_RANGE) as GeneKey[];

// ---------------------------------------------------------------------------
// 世界定义
// ---------------------------------------------------------------------------

export interface SpeciesTemplate {
  name: string;
  /** 物种代表色（hex），初始个体 hue 基因由它导出 */
  color: string;
  count: number;
  /** 初始基因模板（缺失字段取默认值），variance 为各基因初始方差 */
  genome: Partial<Genome>;
  variance?: Partial<Record<GeneKey, number>>;
}

export interface WorldSpec {
  name: string;
  seed: number;
  width: number;
  height: number;
  food: {
    /** 每格食物能量上限 = maxPerCell * 肥沃度 */
    maxPerCell: number;
    /** 每 tick 每格再生量 = regrow * 肥沃度 */
    regrow: number;
  };
  terrain: {
    /** 障碍物占比（0..0.3） */
    obstacleRatio: number;
    /** 危险区占比（0..0.2） */
    hazardRatio: number;
  };
  species: SpeciesTemplate[];
  rules: {
    mutationRate: number;
    maxPopulation: number;
    /** 有性繁殖：求偶+基因交叉；缺省视为无性（旧快照行为不变） */
    sexualReproduction?: boolean;
    /** 灾变事件（旱灾/瘟疫）；旧快照无此字段视为关闭 */
    disasters?: { enabled: boolean; severity: number };
  };
}

// ---------------------------------------------------------------------------
// 个体与物种
// ---------------------------------------------------------------------------

export interface Agent {
  id: number;
  speciesId: number;
  /** 谱系 ID：无性繁殖沿克隆线继承 */
  lineageId: number;
  x: number;
  y: number;
  /** 朝向单位向量 */
  dirX: number;
  dirY: number;
  energy: number;
  age: number;
  genome: Genome;
  /** 距上次攻击的冷却 tick 数 */
  attackCooldown: number;
  /** 本 tick 的行为意图（0 游荡 1 逃逸 2 追捕 3 觅食 4 归群），仅供检查器展示 */
  intent?: number;
  /** 最近一次伤害来源（0 无 1 危险区 2 瘟疫），死亡归因用；旧快照缺省视为 0 */
  damageTag?: number;
  /** 上次交配的 tick（有性繁殖不应期）；旧快照缺省视为远古 */
  lastMatedTick?: number;
  /** 上次进食位置（觅食记忆） */
  memoryX: number;
  memoryY: number;
  memoryTick: number;
  /** 是否存活（被咬致死后同 tick 内由感知过滤） */
  alive: boolean;
}

export interface SpeciesInfo {
  id: number;
  name: string;
  color: string;
  /** 基因组中心（用于遗传距离聚类） */
  centroid: Genome;
  foundedTick: number;
  /** 灭绝 tick；null = 存续 */
  extinctTick: number | null;
  /** 祖先物种 id（新物种由哪个物种分化而来） */
  parentSpeciesId: number | null;
  /** 特征标签（由中心基因组推导；旧快照恢复时可能缺失，惰性补算） */
  tags?: string[];
  /** 一句话生态位描述 */
  niche?: string;
  /** 拉丁双名（属名来自生态类群，种加词来自显著性状） */
  latin?: string;
  /** 历史峰值个体数（指标采样时更新） */
  peakCount?: number;
}

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------

export interface SimCounters {
  births: number;
  deaths: number;
  kills: number;
  speciations: number;
  /** 死亡尸体实际回归土壤的能量（能量守恒审计用） */
  corpseEnergy: number;
  /** 离开系统的能量：代谢/移动/攻击消耗/危险区/繁殖开销/死亡遗能（守恒审计用） */
  dissipated: number;
  /** 死因账本（累计）：饿死含险境与疫后虚弱 */
  deathsByCause: DeathCauses;
}

/** 死因分类：饿死 / 被捕杀 / 衰老 / 危险区 / 瘟疫 */
export interface DeathCauses {
  starve: number;
  predation: number;
  age: number;
  hazard: number;
  plague: number;
}

export const DEATH_CAUSE_KEYS = ['starve', 'predation', 'age', 'hazard', 'plague'] as const;

export const DEATH_CAUSE_LABELS: Record<keyof DeathCauses, string> = {
  starve: '饿死',
  predation: '被捕杀',
  age: '衰老',
  hazard: '危险区',
  plague: '瘟疫',
};

export function emptyDeathCauses(): DeathCauses {
  return { starve: 0, predation: 0, age: 0, hazard: 0, plague: 0 };
}

export interface SimState {
  version: 1;
  spec: WorldSpec;
  tick: number;
  rngState: number;
  nextAgentId: number;
  nextSpeciesId: number;
  agents: Agent[];
  food: Float32Array;
  fertility: Float32Array;
  terrain: Uint8Array;
  species: SpeciesInfo[];
  counters: SimCounters;
  /** 进行中的旱灾（结束 tick）；旧快照缺省视为无旱灾 */
  droughtUntilTick?: number;
  droughtMult?: number;
  /** 下一次灾变的最早 tick（快照恢复后保持灾变节奏） */
  nextDisasterAt?: number;
  /** 食物网捕杀矩阵序列化形式 [捕食者物种id, 猎物物种id, 累计次数] */
  killMatrix?: Array<[number, number, number]>;
}

export const TERRAIN_NORMAL = 0;
export const TERRAIN_OBSTACLE = 1;
export const TERRAIN_HAZARD = 2;

// ---------------------------------------------------------------------------
// 指标与事件
// ---------------------------------------------------------------------------

/** 基因均值（全体存活个体） */
export interface GeneAverages {
  speed: number;
  sense: number;
  size: number;
  metabolism: number;
  aggression: number;
  fear: number;
  sociability: number;
  reproThreshold: number;
}

export interface MetricSample {
  t: number;
  pop: number;
  /** 场上食物总能量 */
  food: number;
  species: number;
  births: number;
  deaths: number;
  kills: number;
  genes: GeneAverages;
  /** 各物种当前个体数（ extinctTick === null 的物种） */
  speciesCounts: Array<{ id: number; count: number }>;
  /** 全场食物能量容量（Σ 肥沃度×每格上限，恒定）；旧记录缺省 */
  foodCap?: number;
  /** 本采样窗口死因分布（增量）；旧记录缺省 */
  deathsByCause?: DeathCauses;
  /** 本采样窗口各物种死因（增量，仅含有死亡的物种）；旧记录缺省 */
  speciesDeaths?: Array<{ id: number } & DeathCauses>;
  /** 食物网：累计捕杀数 Top 物种对（killer→victim）；旧记录缺省 */
  killTop?: Array<{ killer: number; victim: number; count: number }>;
  /** 死亡热区网格（世界 W×H，与食物同频节流发送）；缺省无 */
  deathHeat?: Float32Array;
}

export type SimEventKind = 'speciation' | 'extinction' | 'rule' | 'milestone' | 'system' | 'miracle';

export interface SimEvent {
  t: number;
  kind: SimEventKind;
  msg: string;
  speciesId?: number;
}

// ---------------------------------------------------------------------------
// 物种模板 → 完整基因的默认值
// ---------------------------------------------------------------------------

export const DEFAULT_GENOME: Readonly<Genome> = {
  speed: 0.55,
  sense: 8,
  size: 1.0,
  metabolism: 1.0,
  aggression: 0.15,
  fear: 0.4,
  sociability: 0.35,
  reproThreshold: 110,
  hue: 140,
};

/** 由能量学推导的个体能量上限（体型越大上限越高） */
export function maxEnergyOf(size: number): number {
  return 60 + 60 * size;
}

/** 寿命上限（tick），体型大的更长寿；衰老代谢随寿命推进抬升（见 sim） */
export function maxAgeOf(size: number): number {
  return 15000 + 6000 * size;
}
