import { steer, clampCell } from './behavior';
import { crossoverGenome, genomeFromTemplate, mutateGenome } from './genome';
import { Rng } from './rng';
import { SpeciesTable } from './species';
import { SpatialHash } from './spatial';
import {
  BIOME_FRESHWATER,
  BIOME_LAND,
  BIOME_OCEAN,
  DEATH_CAUSE_KEYS,
  TERRAIN_FRESH,
  TERRAIN_HAZARD,
  TERRAIN_NORMAL,
  TERRAIN_OBSTACLE,
  TERRAIN_OCEAN,
  emptyDeathCauses,
  habitatOfTerrain,
  maxAgeOf,
  maxEnergyOf,
  type Agent,
  type DeathCauses,
  type GeneAverages,
  type MetricSample,
  type SimCounters,
  type SimEvent,
  type SimState,
  type SpeciesTemplate,
  type WorldSpec,
} from './types';
import { World } from './world';

// ---------------------------------------------------------------------------
// 能量学与行为常量（每 tick）
// ---------------------------------------------------------------------------

const EAT_RATE = 1.2; // 进食速度（能量/tick）
const BASE_METAB = 0.03; // 基础代谢系数
/** 感知半径的代谢代价系数（平方级）：sense 12 → 基础代谢 ×15.4，sense 16 → ×26.6。
 * 旧线性代价（0.15×sense）近乎免费，军备竞赛把 sense 推到 16+，而邻居候选
 * ∝ 密度×sense² 直接拖垮高种群性能——「眼睛很贵」是刻意的生态设计（2026-10-13 拍板）。 */
const SENSE_COST = 0.05;
/** 密度自适应感知收缩系数：实际感知半径 = min(sense, √(面积/种群)×K)。
 * 候选 ∝ r²×局部密度（生物因食物/群聚成团，聚集区局部密度可达平均的 5~10 倍）。
 * K=1.6 实测校准：万级聚集种群单 tick ~28ms（修复前同场景 100ms+）；
 * 拥挤世界视野 3~5 格仍能看到十几个邻居，信息量与稀疏世界的远视野相当。
 * 低密度世界 rCap 远大于 sense，完全无感。生态解释：「拥挤干扰视线」。 */
const SENSE_CAP_K = 1.6;
const MOVE_COST = 0.02; // 移动能量代价系数（× 体型 × 实际位移）
const BITE = 10; // 咬合基础能量（× 攻击者体型）
const ATTACK_COST = 0.5; // 每次攻击的消耗
const ATTACK_COOLDOWN = 12; // 攻击冷却（tick）
const HAZARD_DMG = 0.4; // 危险区每 tick 伤害
const CORPSE_ENERGY = 3; // 尸体能量系数（× 体型）
const MATURITY_TICKS = 600; // 性成熟年龄
const REPRO_SPLIT = 0.42; // 繁殖时双方各得的比例（余量为繁殖开销）
const AGGRECTION_HUNT = 0.3; // 低于此攻击性不捕猎
const METRICS_EVERY = 10;
const REGROW_EVERY = 4;
const SPECIES_PRUNE_EVERY = 30;
const MILESTONE_EVERY = 300;

// ---- 生态压力（打破「顶格稳态」的三件套）----
/** 拥挤应激：种群 ≥80% 上限后繁殖门槛线性抬升，顶格时 ×(1+0.75) */
const REPRO_CROWDING = 0.75;
/** 衰老代谢：随寿命推进平方抬升，暮年代谢 ×(1+0.75)——老者先饿，逼出周转 */
const SENESCENCE = 0.75;
/** 灾变节奏：首次 ≥5000 tick，此后每 4200~7800 tick 一次尝试 */
const DISASTER_FIRST_AT = 5000;
const DISASTER_MIN_GAP = 4200;
const DISASTER_VAR_GAP = 3600;

// ---- 有性繁殖 ----
/** 每个亲本投入自身体能的比例（余下留存）；池子的 16% 为交配与孕育开销 */
const SEXUAL_PAY = 0.25;
const SEXUAL_POOL_EFFICIENCY = 0.84;
/** 交配不应期（tick），防止同一对同 tick 连续产崽 */
const MATE_REFRACTORY = 30;
/** 求偶对象需要达到的体能门槛（× 自身繁殖阈值） */
const MATE_ENERGY_RATIO = 0.5;

/** 深拷贝计数器（deathsByCause 是嵌套对象，浅拷贝会共享引用导致增量计算错乱） */
function cloneCounters(c: SimCounters): SimCounters {
  return { ...c, deathsByCause: { ...c.deathsByCause } };
}

/**
 * 栖息域硬隔离（2026-10-13 用户拍板）：能否进入地形值 t 的格子。
 * 障碍格对所有生物都是真墙；陆域生物可走普通格与危险区；
 * 淡水生物只待淡水格，海洋生物只待海洋格。
 */
function canEnter(habitat: number, t: number): boolean {
  if (t === TERRAIN_OBSTACLE) return false;
  if (habitat === BIOME_LAND) return t === TERRAIN_NORMAL || t === TERRAIN_HAZARD;
  if (t === TERRAIN_FRESH) return habitat === BIOME_FRESHWATER;
  return t === TERRAIN_OCEAN && habitat === BIOME_OCEAN;
}

export class Simulation {
  readonly spec: WorldSpec;
  readonly world: World;
  readonly rng: Rng;
  readonly species = new SpeciesTable();
  agents: Agent[] = [];
  tick = 0;
  counters: SimCounters = {
    births: 0,
    deaths: 0,
    kills: 0,
    speciations: 0,
    corpseEnergy: 0,
    dissipated: 0,
    deathsByCause: emptyDeathCauses(),
  };
  /** 食物网：捕杀矩阵 killerSpeciesId → victimSpeciesId → 累计次数（随快照保存） */
  killMatrix: Map<number, Map<number, number>> = new Map();
  /** 死亡热区网格（世界 W×H，仅展示用，不入快照） */
  readonly deathHeat: Float32Array;

  private nextAgentId = 1;
  private hash: SpatialHash;
  private pendingEvents: SimEvent[] = [];
  private pendingMetrics: MetricSample[] = [];
  private lastMetricCounters: SimCounters;
  /** 采样窗口内各物种死因增量（metrics 采样时清空） */
  private speciesDeathsWindow = new Map<number, DeathCauses>();

  // ---- 里程碑叙述状态（不影响模拟物理，仅用于生成事件）----
  /** 全场食物能量容量（恒定），供饥荒/丰饶判定 */
  readonly foodCapacity: number;
  /** 上次里程碑检查时的种群数 */
  private lastPopMark = 0;
  /** 上次播报的主导物种 */
  private lastDominantId: number | null = null;
  private lastDominantName = '';
  /** 各类事件的冷却（tick） */
  private lastPopEventTick = -Infinity;
  private famineCooldownUntil = 0;
  private plentyCooldownUntil = 0;
  private recordCooldown = { size: 0, speed: 0, aggression: 0 };
  private recordSize = 0;
  private recordSpeed = 0;
  private recordAggr = 0;

  // ---- 灾变与稳态 ----
  /** 下一次灾变尝试的最早 tick */
  private nextDisasterAt: number;
  private droughtWasActive = false;
  private plagueActive = false;
  private plagueDeathsBase = 0;
  /** 稳态检测：种群顶格且繁殖停滞的起始 tick */
  private stagnantSince: number | null = null;
  private stagnationEventAt = -Infinity;
  /** 本 tick 的有效感知半径上限（密度自适应，见 SENSE_CAP_K；每 tickOnce 开头重算） */
  private senseCap = Infinity;
  private birthsAtLastCheck = 0;

  constructor(spec: WorldSpec) {
    this.spec = structuredClone(spec);
    this.world = new World(this.spec);
    // 与地形生成使用不同的随机流，避免相互影响
    this.rng = new Rng((spec.seed ^ 0x9e3779b9) >>> 0);
    this.hash = new SpatialHash(6, this.spec.width, this.spec.height);
    this.lastMetricCounters = cloneCounters(this.counters);
    this.foodCapacity = this.world.totalCapacity();
    this.deathHeat = new Float32Array(this.world.n);
    this.spawnInitial(this.spec.species);
    // 叙述基线：以初始种群为参照，演化突破才有「事件感」
    this.lastPopMark = this.agents.length;
    for (const a of this.agents) this.updateRecords(a);
    this.nextDisasterAt = DISASTER_FIRST_AT + this.rng.int(3000);
  }

  /** 记录个体的体型/速度/凶性是否刷新历史纪录 */
  private updateRecords(a: Agent): void {
    if (a.genome.size > this.recordSize) this.recordSize = a.genome.size;
    if (a.genome.speed > this.recordSpeed) this.recordSpeed = a.genome.speed;
    if (a.genome.aggression > this.recordAggr) this.recordAggr = a.genome.aggression;
  }

  // -------------------------------------------------------------------------
  // 初始化 / 快照
  // -------------------------------------------------------------------------

  private spawnInitial(templates: SpeciesTemplate[]): void {
    for (const tpl of templates) {
      const founderGenome = genomeFromTemplate(tpl, this.rng);
      // 先为整支种群选定落域：优先匹配模板栖息域；世界里没有该圈域时
      // 落在任意可通行格并随地形改域（引擎自洽优先）
      const [, , hab] = this.randomPosFor(tpl.habitat ?? BIOME_LAND);
      const info = this.species.found(tpl.name, tpl.color, founderGenome, 0, hab);
      for (let i = 0; i < tpl.count; i++) {
        const genome = genomeFromTemplate(tpl, this.rng);
        const [x, y] = this.randomPosFor(hab);
        const [dx, dy] = this.rng.direction();
        this.agents.push({
          id: this.nextAgentId++,
          speciesId: info.id,
          lineageId: info.id,
          x,
          y,
          dirX: dx,
          dirY: dy,
          energy: maxEnergyOf(genome.size) * 0.7,
          age: this.rng.int(MATURITY_TICKS),
          genome,
          attackCooldown: 0,
          memoryX: -1,
          memoryY: -1,
          memoryTick: -9999,
          alive: true,
        });
      }
    }
  }

  /**
   * 在指定栖息域内随机取点，返回 [x, y, 实际栖息域]。
   * 随机 80 次未命中则线性扫描兜底（确定性）；该圈域不存在时退回任意
   * 可通行格并随地形改域，保证任何 spec 都能落地。
   */
  private randomPosFor(habitatHint: number): [number, number, number] {
    const w = this.world;
    for (let tries = 0; tries < 80; tries++) {
      const x = this.rng.next() * this.spec.width;
      const y = this.rng.next() * this.spec.height;
      const cx = x | 0;
      const cy = y | 0;
      if (!w.passable(cx, cy)) continue;
      const h = habitatOfTerrain(w.terrain[w.cellIndex(cx, cy)]);
      if (h === habitatHint) return [x, y, h];
    }
    for (let i = 0; i < w.n; i++) {
      const t = w.terrain[i];
      if (t === TERRAIN_OBSTACLE) continue;
      if (habitatOfTerrain(t) === habitatHint) {
        return [(i % w.width) + 0.5, Math.floor(i / w.width) + 0.5, habitatHint];
      }
    }
    for (let tries = 0; tries < 80; tries++) {
      const x = this.rng.next() * this.spec.width;
      const y = this.rng.next() * this.spec.height;
      if (w.passable(x | 0, y | 0)) {
        const h = habitatOfTerrain(w.terrain[w.cellIndex(x | 0, y | 0)]);
        return [x, y, h];
      }
    }
    return [this.spec.width / 2, this.spec.height / 2, BIOME_LAND];
  }

  /** 导出完整快照（结构化克隆友好，可直接存 IndexedDB 或用于分叉） */
  toState(): SimState {
    const state: SimState = {
      version: 1,
      spec: structuredClone(this.spec),
      tick: this.tick,
      rngState: this.rng.state,
      nextAgentId: this.nextAgentId,
      nextSpeciesId: this.species.nextSpeciesId,
      agents: this.agents.map((a) => ({
        ...a,
        genome: { ...a.genome },
      })),
      food: this.world.food.slice(),
      fertility: this.world.fertility.slice(),
      terrain: this.world.terrain.slice(),
      species: this.species.all.map((s) => ({ ...s, centroid: { ...s.centroid } })),
      counters: cloneCounters(this.counters),
    };
    const drought = this.world.droughtState();
    state.droughtUntilTick = drought.untilTick;
    state.droughtMult = drought.mult;
    state.nextDisasterAt = this.nextDisasterAt;
    const km: Array<[number, number, number]> = [];
    for (const [killer, row] of this.killMatrix) {
      for (const [victim, count] of row) km.push([killer, victim, count]);
    }
    state.killMatrix = km;
    return state;
  }

  /** 从快照恢复（用于分叉实验与断点续跑） */
  static fromState(state: SimState): Simulation {
    if (state.version !== 1) throw new Error(`不支持的快照版本: ${state.version}`);
    const sim = new Simulation(state.spec);
    // 丢弃构造时生成的初始个体与地形，用快照内容替换
    sim.agents = state.agents.map((a) => ({ ...a, genome: { ...a.genome } }));
    sim.world.food.set(state.food);
    sim.world.fertility.set(state.fertility);
    sim.world.terrain.set(state.terrain);
    sim.tick = state.tick;
    sim.rng.state = state.rngState;
    sim.nextAgentId = state.nextAgentId;
    sim.counters = cloneCounters({
      ...state.counters,
      deathsByCause: { ...emptyDeathCauses(), ...(state.counters.deathsByCause ?? {}) },
    });
    sim.lastMetricCounters = cloneCounters(sim.counters);
    sim.killMatrix = new Map();
    for (const [killer, victim, count] of state.killMatrix ?? []) {
      let row = sim.killMatrix.get(killer);
      if (!row) {
        row = new Map();
        sim.killMatrix.set(killer, row);
      }
      row.set(victim, count);
    }
    sim.species.restore(
      state.species.map((s) => ({ ...s, centroid: { ...s.centroid } })),
      state.nextSpeciesId,
    );
    // 里程碑叙述状态从快照重建：避免恢复/分叉后重复播报已知事实
    sim.lastPopMark = sim.agents.length;
    const domCount = new Map<number, number>();
    for (const a of sim.agents) {
      sim.updateRecords(a);
      domCount.set(a.speciesId, (domCount.get(a.speciesId) ?? 0) + 1);
    }
    let bestId: number | null = null;
    let bestN = 0;
    for (const [id, c] of domCount) {
      if (c > bestN) {
        bestN = c;
        bestId = id;
      }
    }
    sim.lastDominantId = bestId;
    sim.lastDominantName =
      bestId !== null ? (sim.species.all.find((s) => s.id === bestId)?.name ?? '') : '';
    sim.birthsAtLastCheck = sim.counters.births;
    if (state.nextDisasterAt !== undefined) sim.nextDisasterAt = state.nextDisasterAt;
    if (state.droughtUntilTick !== undefined) {
      sim.world.restoreDrought(state.droughtUntilTick, state.droughtMult ?? 1);
      sim.droughtWasActive = sim.world.droughtActive(sim.tick);
    }
    return sim;
  }

  // -------------------------------------------------------------------------
  // 规则热修改
  // -------------------------------------------------------------------------

  /**
   * 规则热修改。via 为干预来源前缀（如 '按 AI 建议'），仅影响事件文案——
   * 数值路径完全一致，两次干预之间的确定性不受影响。
   */
  updateRules(
    patch: {
      mutationRate?: number;
      foodRegrow?: number;
      maxPopulation?: number;
      sexualReproduction?: boolean;
      disasters?: { enabled: boolean; severity: number };
    },
    via?: string,
  ): void {
    const changed: string[] = [];
    if (patch.mutationRate !== undefined && patch.mutationRate !== this.spec.rules.mutationRate) {
      this.spec.rules.mutationRate = patch.mutationRate;
      changed.push(`突变率 → ${(patch.mutationRate * 100).toFixed(1)}%`);
    }
    if (patch.foodRegrow !== undefined && patch.foodRegrow !== this.spec.food.regrow) {
      this.spec.food.regrow = patch.foodRegrow;
      this.world.updateRules({ foodRegrow: patch.foodRegrow });
      changed.push(`食物再生 → ${patch.foodRegrow.toFixed(4)}`);
    }
    if (patch.maxPopulation !== undefined && patch.maxPopulation !== this.spec.rules.maxPopulation) {
      this.spec.rules.maxPopulation = patch.maxPopulation;
      changed.push(`种群上限 → ${patch.maxPopulation}`);
    }
    if (patch.sexualReproduction !== undefined && !!patch.sexualReproduction !== !!this.spec.rules.sexualReproduction) {
      this.spec.rules.sexualReproduction = patch.sexualReproduction;
      changed.push(patch.sexualReproduction ? '繁殖方式 → 有性（求偶+基因交叉）' : '繁殖方式 → 无性（分裂）');
    }
    if (patch.disasters !== undefined) {
      const cur = this.spec.rules.disasters ?? { enabled: false, severity: 0.5 };
      const next = patch.disasters;
      if (cur.enabled !== next.enabled || Math.abs(cur.severity - next.severity) > 1e-9) {
        this.spec.rules.disasters = { ...next };
        if (cur.enabled !== next.enabled) changed.push(next.enabled ? '灾变开启' : '灾变关闭');
        if (Math.abs(cur.severity - next.severity) > 1e-9) {
          changed.push(`灾变强度 → ${Math.round(next.severity * 100)}%`);
        }
        // 刚开启时给世界 3000+ tick 的宽限，避免立刻遭灾
        if (next.enabled && !cur.enabled && this.tick >= this.nextDisasterAt) {
          this.nextDisasterAt = this.tick + 3000 + this.rng.int(2000);
        }
      }
    }
    if (changed.length > 0) {
      this.pendingEvents.push({
        t: this.tick,
        kind: 'rule',
        msg: `实验者${via ?? ''}修改了规则：${changed.join('，')}`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 主循环
  // -------------------------------------------------------------------------

  tickOnce(): void {
    const t = ++this.tick;
    if (t % REGROW_EVERY === 0) this.world.regrowFood(t);
    if (t % 10 === 0) this.decayDeathHeat();

    this.hash.clear();
    for (let i = 0; i < this.agents.length; i++) this.hash.insert(this.agents[i]);

    const w = this.world;
    // 密度自适应感知收缩：实际感知半径 = min(基因 sense, rCap)，rCap 随种群密度
    // 收缩（拥挤干扰视线），把每个体的邻居候选数锁在 π×K² 附近——性能硬保障。
    this.senseCap =
      Math.sqrt((w.width * w.height) / Math.max(1, this.agents.length)) * SENSE_CAP_K;
    const ctx = { world: w, hash: this.hash, rng: this.rng, tick: t, senseCap: this.senseCap, habitat: BIOME_LAND };
    const maxPop = this.spec.rules.maxPopulation;
    const newborns: Agent[] = [];

    // 指标累加器与物种计数：只在会消费它们的 tick（指标采样 10 / 灭绝检查 30 的公倍数节奏）
    // 才维护——每 tick 每个体 8 次 genome 属性读 + 一次 Map 写在万级种群下是实测热点，
    // 而累加值纯粹是只读统计，惰性化不改变任何模拟状态与轨迹。
    let sSpeed = 0;
    let sSense = 0;
    let sSize = 0;
    let sMetab = 0;
    let sAggr = 0;
    let sFear = 0;
    let sSoc = 0;
    let sRepro = 0;
    const speciesPop = new Map<number, number>();
    const statsTick = t % METRICS_EVERY === 0 || t % SPECIES_PRUNE_EVERY === 0;

    for (let i = 0; i < this.agents.length; ) {
      const a = this.agents[i];

      // 本 tick 内已被咬死的个体：立即移除
      if (!a.alive) {
        this.removeAgent(i);
        continue;
      }

      // ---- 决策与移动 ----
      // 栖息域由所在格推导（硬隔离保证个体永远站在本域格上；旧快照中
      // 站进障碍格的个体按陆域处理，可自行走出）
      const habitat = habitatOfTerrain(
        w.terrain[w.cellIndex(clampCell(a.x, w.width), clampCell(a.y, w.height))],
      );
      ctx.habitat = habitat;
      const st = steer(a, ctx);
      a.intent = st.intent;
      a.dirX = st.dirX;
      a.dirY = st.dirY;
      let moved = 0;
      const step = a.genome.speed * st.effort;
      if (step > 0) {
        moved = this.moveAgent(a, habitat, step);
      }

      // ---- 进食与危险区 ----
      const cx = clampCell(a.x, w.width);
      const cy = clampCell(a.y, w.height);
      const ci = w.cellIndex(cx, cy);
      const cellT = w.terrain[ci];
      if (cellT === TERRAIN_NORMAL || cellT === TERRAIN_FRESH || cellT === TERRAIN_OCEAN) {
        // 能量满格时不进食：避免食物被白白销毁（守恒要求）
        const room = maxEnergyOf(a.genome.size) - a.energy;
        const food = w.food[ci];
        if (room > 0 && food > 0) {
          const gain = Math.min(food, EAT_RATE, room);
          w.food[ci] = food - gain;
          a.energy += gain;
          a.memoryX = a.x;
          a.memoryY = a.y;
          a.memoryTick = t;
        }
      } else if (cellT === TERRAIN_HAZARD) {
        a.energy -= HAZARD_DMG;
        a.damageTag = 1;
        this.counters.dissipated += HAZARD_DMG;
      }

      // ---- 攻击（猎物复用 steer 单遍扫描的结果，免去第二次邻居查询）----
      if (a.attackCooldown > 0) a.attackCooldown--;
      const prey = st.prey;
      if (prey && a.genome.aggression > AGGRECTION_HUNT && a.attackCooldown === 0) {
        this.tryAttack(a, prey);
      }

      // ---- 代谢（能量离开系统；暮年代谢抬升，老者先饿，逼出种群周转）----
      const lifeFrac = a.age / maxAgeOf(a.genome.size);
      const senescence = 1 + SENESCENCE * lifeFrac * lifeFrac;
      const s = a.genome.sense;
      const drain =
        (BASE_METAB * a.genome.size * a.genome.metabolism * (1 + SENSE_COST * s * s) +
          MOVE_COST * a.genome.size * moved) * senescence;
      a.energy -= drain;
      this.counters.dissipated += drain;

      // ---- 衰老与死亡 ----
      a.age++;
      if (a.energy <= 0 || a.age > maxAgeOf(a.genome.size)) {
        this.dieAt(i);
        continue;
      }

      // ---- 繁殖（拥挤应激：种群逼近上限时繁殖门槛抬升，饱和不停摆）----
      const popNow = this.agents.length + newborns.length;
      const crowding =
        maxPop > 0 && popNow >= maxPop * 0.8
          ? Math.min(1, (popNow / maxPop - 0.8) / 0.2)
          : 0;
      if (
        a.energy >= a.genome.reproThreshold * (1 + REPRO_CROWDING * crowding) &&
        a.age > MATURITY_TICKS &&
        popNow < maxPop
      ) {
        if (this.spec.rules.sexualReproduction) {
          if (t - (a.lastMatedTick ?? -Infinity) >= MATE_REFRACTORY) {
            const mate = this.findMate(a, t);
            if (mate) newborns.push(this.reproduceSexual(a, mate, t));
          }
        } else {
          newborns.push(this.reproduce(a, t));
        }
      }

      // ---- 统计（惰性：只在会消费结果的 tick 维护，见循环前的说明）----
      if (statsTick) {
        const g = a.genome;
        sSpeed += g.speed;
        sSense += g.sense;
        sSize += g.size;
        sMetab += g.metabolism;
        sAggr += g.aggression;
        sFear += g.fear;
        sSoc += g.sociability;
        sRepro += g.reproThreshold;
        speciesPop.set(a.speciesId, (speciesPop.get(a.speciesId) ?? 0) + 1);
      }

      i++;
    }

    // 新生个体加入（下一 tick 行动）
    for (const child of newborns) this.agents.push(child);

    // 物种灭绝检查
    if (t % SPECIES_PRUNE_EVERY === 0) {
      for (const ev of this.species.prune(t, speciesPop)) this.pendingEvents.push(ev);
    }

    // 指标采样
    if (t % METRICS_EVERY === 0) {
      const pop = this.agents.length;
      const genes: GeneAverages = {
        speed: sSpeed / pop,
        sense: sSense / pop,
        size: sSize / pop,
        metabolism: sMetab / pop,
        aggression: sAggr / pop,
        fear: sFear / pop,
        sociability: sSoc / pop,
        reproThreshold: sRepro / pop,
      };
      const c = this.counters;
      const lc = this.lastMetricCounters;
      const causeDelta = emptyDeathCauses();
      for (const k of DEATH_CAUSE_KEYS) {
        causeDelta[k] = c.deathsByCause[k] - (lc.deathsByCause?.[k] ?? 0);
      }
      const speciesDeaths = Array.from(this.speciesDeathsWindow, ([id, w]) => ({ id, ...w }));
      this.speciesDeathsWindow.clear();
      // 食物网：累计捕杀 Top 物种对
      const pairs: Array<{ killer: number; victim: number; count: number }> = [];
      for (const [killer, row] of this.killMatrix) {
        for (const [victim, count] of row) pairs.push({ killer, victim, count });
      }
      pairs.sort((a, b) => b.count - a.count);
      this.pendingMetrics.push({
        t,
        pop,
        food: w.totalFood(),
        species: this.species.active.length,
        births: c.births - lc.births,
        deaths: c.deaths - lc.deaths,
        kills: c.kills - lc.kills,
        genes,
        speciesCounts: Array.from(speciesPop, ([id, count]) => ({ id, count })),
        foodCap: this.foodCapacity,
        deathsByCause: causeDelta,
        speciesDeaths,
        killTop: pairs.slice(0, 8),
      });
      this.lastMetricCounters = cloneCounters(c);
      // 物种峰值（灭绝讣告用）
      for (const s of this.species.active) {
        const count = speciesPop.get(s.id) ?? 0;
        if (count > (s.peakCount ?? 0)) s.peakCount = count;
      }
    }

    // 里程碑叙述：种群趋势 / 主导更迭 / 饥荒丰饶 / 演化纪录
    if (t % MILESTONE_EVERY === 0) {
      this.checkMilestones(t, speciesPop);
      this.checkDisasters(t);
    }
  }

  // -------------------------------------------------------------------------
  // 子过程
  // -------------------------------------------------------------------------

  /**
   * 里程碑检查（每 300 tick）：把冷冰冰的指标曲线翻译成世界大事。
   * 只读模拟状态、不消耗随机数——同 seed 轨迹与事件流完全确定。
   */
  private checkMilestones(t: number, speciesPop: Map<number, number>): void {
    const events: SimEvent[] = [];
    const pop = this.agents.length;
    const birthsWindow = this.counters.births - this.birthsAtLastCheck;
    this.birthsAtLastCheck = this.counters.births;

    // ---- 种群趋势 ----
    if (this.lastPopMark >= 30 && t - this.lastPopEventTick >= 600) {
      const ratio = pop / this.lastPopMark;
      if (ratio >= 1.35) {
        events.push({
          t,
          kind: 'milestone',
          msg: `种群繁荣——个体数从 ${this.lastPopMark.toLocaleString()} 增至 ${pop.toLocaleString()}（+${Math.round((ratio - 1) * 100)}%）`,
        });
        this.lastPopEventTick = t;
      } else if (ratio <= 0.65 && pop >= 40) {
        events.push({
          t,
          kind: 'milestone',
          msg: `种群衰退——个体数从 ${this.lastPopMark.toLocaleString()} 跌至 ${pop.toLocaleString()}（${Math.round((ratio - 1) * 100)}%）`,
        });
        this.lastPopEventTick = t;
      }
    }
    this.lastPopMark = pop;

    // ---- 主导物种更迭 ----
    let domId: number | null = null;
    let domCount = 0;
    for (const [id, count] of speciesPop) {
      if (count > domCount) {
        domCount = count;
        domId = id;
      }
    }
    if (domId !== null && pop > 0 && domCount >= Math.max(20, pop * 0.15) && domId !== this.lastDominantId) {
      const s = this.species.all.find((sp) => sp.id === domId);
      if (s) {
        events.push(
          this.lastDominantId === null
            ? {
                t,
                kind: 'milestone',
                msg: `「${s.name}」成为当前最繁盛的物种（${domCount.toLocaleString()} 个体，占 ${Math.round((domCount / pop) * 100)}%）`,
              }
            : {
                t,
                kind: 'milestone',
                msg: `权力更迭——「${s.name}」取代「${this.lastDominantName}」成为最繁盛的物种（${domCount.toLocaleString()} 个体）`,
              },
        );
        this.lastDominantId = domId;
        this.lastDominantName = s.name;
      }
    }

    // ---- 饥荒 / 丰饶 ----
    const frac = this.world.totalFood() / (this.foodCapacity || 1);
    if (frac < 0.15 && t >= this.famineCooldownUntil) {
      events.push({
        t,
        kind: 'milestone',
        msg: `饥荒——全场食物能量仅剩 ${Math.max(1, Math.round(frac * 100))}%`,
      });
      this.famineCooldownUntil = t + 1800;
    } else if (frac >= 0.5 && t >= this.plentyCooldownUntil) {
      events.push({
        t,
        kind: 'milestone',
        msg: `食物丰饶——植被重新覆盖全场（${Math.round(frac * 100)}%）`,
      });
      this.plentyCooldownUntil = t + 7200;
    }

    // ---- 演化纪录（较旧纪录突破 6% 才播报）----
    let mSize = 0;
    let mSpeed = 0;
    let mAggr = 0;
    let sizeId = 0;
    let speedId = 0;
    let aggrId = 0;
    for (const a of this.agents) {
      if (a.genome.size > mSize) {
        mSize = a.genome.size;
        sizeId = a.speciesId;
      }
      if (a.genome.speed > mSpeed) {
        mSpeed = a.genome.speed;
        speedId = a.speciesId;
      }
      if (a.genome.aggression > mAggr) {
        mAggr = a.genome.aggression;
        aggrId = a.speciesId;
      }
    }
    const nameOf = (id: number): string => this.species.all.find((s) => s.id === id)?.name ?? '未知物种';
    if (mSize > this.recordSize * 1.06 && t >= this.recordCooldown.size) {
      events.push({ t, kind: 'milestone', msg: `体型纪录——「${nameOf(sizeId)}」中出现体型 ${mSize.toFixed(2)} 的个体` });
      this.recordSize = mSize;
      this.recordCooldown.size = t + 2400;
    }
    if (mSpeed > this.recordSpeed * 1.06 && t >= this.recordCooldown.speed) {
      events.push({ t, kind: 'milestone', msg: `速度纪录——「${nameOf(speedId)}」中出现速度 ${mSpeed.toFixed(2)} 格/tick 的个体` });
      this.recordSpeed = mSpeed;
      this.recordCooldown.speed = t + 2400;
    }
    if (mAggr > this.recordAggr * 1.06 && mAggr > 0.3 && t >= this.recordCooldown.aggression) {
      events.push({ t, kind: 'milestone', msg: `凶性纪录——「${nameOf(aggrId)}」的攻击性达到 ${Math.round(mAggr * 100)}%` });
      this.recordAggr = mAggr;
      this.recordCooldown.aggression = t + 2400;
    }

    // ---- 稳态检测：种群顶格且繁殖近乎停滞 → 提示打破僵局 ----
    const cap = this.spec.rules.maxPopulation;
    if (cap > 0 && pop >= cap * 0.97 && birthsWindow < pop * 0.004) {
      if (this.stagnantSince === null) {
        this.stagnantSince = t;
      } else if (t - this.stagnantSince >= 2400 && t - this.stagnationEventAt >= 6000) {
        events.push({
          t,
          kind: 'milestone',
          msg: '稳态时代——种群顶满承载力上限，繁殖近乎停滞，演化陷入僵局（可分叉后降低种群上限或开启灾变打破平衡）',
        });
        this.stagnationEventAt = t;
      }
    } else {
      this.stagnantSince = null;
    }

    // 每 300 tick 至多 3 条，防刷屏
    for (const ev of events.slice(0, 3)) this.pendingEvents.push(ev);
  }

  /**
   * 灾变调度（每 300 tick 检查）：旱灾削减食物再生，瘟疫直接削弱种群。
   * 全部随机走 Rng（种子化、随快照保存），确定性可复现；进行中的灾变
   * 即使被关闭也会正常收尾播报。
   */
  private checkDisasters(t: number): void {
    const conf = this.spec.rules.disasters;

    // 旱灾结束播报
    const droughtNow = this.world.droughtActive(t);
    if (this.droughtWasActive && !droughtNow) {
      this.pendingEvents.push({
        t,
        kind: 'milestone',
        msg: '旱灾结束——植被开始恢复，食物重新累积',
      });
    }
    this.droughtWasActive = droughtNow;

    // 瘟疫平息播报
    if (this.plagueActive) {
      const delta = this.counters.deaths - this.plagueDeathsBase;
      this.pendingEvents.push({
        t,
        kind: 'milestone',
        msg: `瘟疫平息——疫情期间共 ${delta.toLocaleString()} 个体死亡`,
      });
      this.plagueActive = false;
    }

    if (!conf?.enabled || t < this.nextDisasterAt) return;
    this.nextDisasterAt = t + DISASTER_MIN_GAP + this.rng.int(DISASTER_VAR_GAP);
    const sev = Math.min(1, Math.max(0.1, conf.severity));
    if (this.rng.next() < 0.55) {
      const dur = 1500 + this.rng.int(1500);
      const mult = Math.max(0.1, 1 - 0.65 * sev);
      this.world.beginDrought(dur, mult, t);
      this.droughtWasActive = true;
      this.pendingEvents.push({
        t,
        kind: 'milestone',
        msg: `旱灾来袭——食物再生骤降至原来的 ${Math.round(mult * 100)}%，预计持续 ${dur.toLocaleString()} tick`,
      });
    } else {
      const infFrac = 0.15 + 0.3 * sev;
      const dmgFrac = 0.25 + 0.3 * sev;
      let infected = 0;
      for (const a of this.agents) {
        if (!this.rng.chance(infFrac)) continue;
        infected++;
        const dmg = maxEnergyOf(a.genome.size) * dmgFrac;
        a.energy -= dmg;
        a.damageTag = 2;
        this.counters.dissipated += dmg;
      }
      const pct = Math.round((infected / Math.max(1, this.agents.length)) * 100);
      this.pendingEvents.push({
        t,
        kind: 'milestone',
        msg: infected > 0 ? `瘟疫爆发——约 ${pct}% 个体感染，体力大幅衰弱` : '瘟疫爆发——所幸无人感染',
      });
      this.plagueActive = true;
      this.plagueDeathsBase = this.counters.deaths;
    }
  }

  /**
   * 尝试朝 dirX/dirY 移动一步，返回实际位移（被阻挡时尝试滑行/调头）。
   *
   * 2026-10-13 语义变更（用户拍板）：按「目标格」做真阻挡——障碍格与
   * 非本栖息域格都不可进入。历史版本的分数坐标判定（TypedArray 取
   * undefined = 可通行，障碍物形同装饰）已废除。
   */
  private moveAgent(a: Agent, habitat: number, step: number): number {
    const w = this.world;
    const W = w.width;
    const nx = a.x + a.dirX * step;
    const ny = a.y + a.dirY * step;
    if (nx >= 0 && ny >= 0 && nx < W && ny < w.height) {
      if (canEnter(habitat, w.terrain[(ny | 0) * W + (nx | 0)])) {
        a.x = nx;
        a.y = ny;
        return step;
      }
    }
    // 滑行：先试只走 x，再试只走 y，都不行则调头（贴岸/贴壁滑行）
    const nx2 = a.x + a.dirX * step;
    if (nx2 >= 0 && nx2 < W && a.y >= 0 && a.y < w.height) {
      if (canEnter(habitat, w.terrain[(a.y | 0) * W + (nx2 | 0)])) {
        a.x = nx2;
        a.dirY = -a.dirY;
        return step * 0.8;
      }
    }
    const ny2 = a.y + a.dirY * step;
    if (ny2 >= 0 && ny2 < w.height && a.x >= 0 && a.x < W) {
      if (canEnter(habitat, w.terrain[(ny2 | 0) * W + (a.x | 0)])) {
        a.y = ny2;
        a.dirX = -a.dirX;
        return step * 0.8;
      }
    }
    a.dirX = -a.dirX;
    a.dirY = -a.dirY;
    return 0;
  }

  /**
   * 攻击判定：猎物由 steer 的单遍感知扫描提供（本 tick 内刚扫到的最近猎物），
   * 这里只做距离与合法性复核，省去第二次空间查询。
   */
  private tryAttack(a: Agent, prey: Agent): void {
    if (!prey.alive || prey.speciesId === a.speciesId) return;
    if (prey.genome.size >= a.genome.size * 0.85) return;
    const dx = prey.x - a.x;
    const dy = prey.y - a.y;
    const contact = 0.5 + 0.3 * a.genome.size;
    const reach = contact + 0.3 * prey.genome.size;
    if (dx * dx + dy * dy > reach * reach) return;

    const bite = BITE * a.genome.size;
    const steal = Math.min(Math.max(prey.energy, 0), bite);
    prey.energy -= steal;
    a.energy += steal;
    a.energy -= ATTACK_COST;
    this.counters.dissipated += ATTACK_COST;
    a.attackCooldown = ATTACK_COOLDOWN;

    if (prey.energy <= 0) {
      // 当场咬死：尸体落地，统计计入捕杀
      prey.alive = false;
      this.counters.kills++;
      this.counters.deaths++;
      this.counters.deathsByCause.predation++;
      this.bumpSpeciesDeath(prey.speciesId, 'predation');
      // 食物网：捕杀矩阵累计
      let row = this.killMatrix.get(a.speciesId);
      if (!row) {
        row = new Map();
        this.killMatrix.set(a.speciesId, row);
      }
      row.set(prey.speciesId, (row.get(prey.speciesId) ?? 0) + 1);
      this.dropCorpse(prey);
    }
  }

  /** 幼体落点合法性：界内且属于父本栖息域（硬隔离从出生开始生效） */
  private canBirthAt(habitat: number, x: number, y: number): boolean {
    const w = this.world;
    if (x < 0 || y < 0 || x >= w.width || y >= w.height) return false;
    return canEnter(habitat, w.terrain[(y | 0) * w.width + (x | 0)]);
  }

  private reproduce(parent: Agent, t: number): Agent {
    const total = parent.energy;
    const childEnergy = total * REPRO_SPLIT;
    parent.energy = total * REPRO_SPLIT;
    // 繁殖开销（余量）离开系统
    this.counters.dissipated += total - childEnergy - parent.energy;

    const genome = mutateGenome(parent.genome, this.spec.rules.mutationRate, this.rng);
    const [ox, oy] = this.rng.disc(1.5);
    let x = parent.x + ox;
    let y = parent.y + oy;
    const hab = habitatOfTerrain(
      this.world.terrain[
        this.world.cellIndex(clampCell(parent.x, this.world.width), clampCell(parent.y, this.world.height))
      ],
    );
    if (!this.canBirthAt(hab, x, y)) {
      x = parent.x;
      y = parent.y;
    }
    const [dx, dy] = this.rng.direction();

    const assigned = this.species.assign(genome, t, hab);
    if (assigned.speciated) {
      this.counters.speciations++;
      this.pendingEvents.push(assigned.event!);
    }

    this.counters.births++;
    return {
      id: this.nextAgentId++,
      speciesId: assigned.species.id,
      lineageId: parent.lineageId,
      x,
      y,
      dirX: dx,
      dirY: dy,
      energy: childEnergy,
      age: 0,
      genome,
      attackCooldown: 0,
      memoryX: -1,
      memoryY: -1,
      memoryTick: -9999,
      alive: true,
    };
  }

  /** 食物再生：每 10 tick 衰减一次死亡热区（展示用） */
  private decayDeathHeat(): void {
    const h = this.deathHeat;
    for (let i = 0; i < h.length; i++) {
      if (h[i] > 0.01) h[i] *= 0.95;
      else if (h[i] !== 0) h[i] = 0;
    }
  }

  /** 求偶：感知范围内最近的同类成熟个体（体能达标且不在不应期） */
  private findMate(self: Agent, t: number): Agent | null {
    let best: Agent | null = null;
    let bestD2 = Infinity;
    // 求偶视野同样受密度自适应收缩约束
    const r = Math.min(self.genome.sense, this.senseCap);
    // d2 >= bestD2 的平局取先者语义依赖 forEachNear 的遍历顺序，勿改循环结构
    this.hash.forEachNear(self.x, self.y, r, (other) => {
      if (other === self || !other.alive || other.speciesId !== self.speciesId) return;
      if (other.age <= MATURITY_TICKS) return;
      if (t - (other.lastMatedTick ?? -Infinity) < MATE_REFRACTORY) return;
      if (other.energy < other.genome.reproThreshold * MATE_ENERGY_RATIO) return;
      const dx = other.x - self.x;
      const dy = other.y - self.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r * r || d2 >= bestD2) return;
      bestD2 = d2;
      best = other;
    });
    return best as Agent | null;
  }

  /**
   * 有性繁殖：双亲各投入体能 SEXUAL_PAY 份额，池子的 SEXUAL_POOL_EFFICIENCY
   * 成为幼体（余量按开销耗散）；基因经均匀交叉后再突变。
   */
  private reproduceSexual(a: Agent, b: Agent, t: number): Agent {
    const payA = a.energy * SEXUAL_PAY;
    const payB = b.energy * SEXUAL_PAY;
    a.energy -= payA;
    b.energy -= payB;
    a.lastMatedTick = t;
    b.lastMatedTick = t;
    const pool = payA + payB;
    const childEnergy = pool * SEXUAL_POOL_EFFICIENCY;
    this.counters.dissipated += pool - childEnergy;

    const genome = mutateGenome(
      crossoverGenome(a.genome, b.genome, this.rng),
      this.spec.rules.mutationRate,
      this.rng,
    );
    const [ox, oy] = this.rng.disc(1.5);
    let x = a.x + ox;
    let y = a.y + oy;
    const hab = habitatOfTerrain(
      this.world.terrain[this.world.cellIndex(clampCell(a.x, this.world.width), clampCell(a.y, this.world.height))],
    );
    if (!this.canBirthAt(hab, x, y)) {
      x = a.x;
      y = a.y;
    }
    const [dx, dy] = this.rng.direction();

    const assigned = this.species.assign(genome, t, hab);
    if (assigned.speciated) {
      this.counters.speciations++;
      this.pendingEvents.push(assigned.event!);
    }

    this.counters.births++;
    return {
      id: this.nextAgentId++,
      speciesId: assigned.species.id,
      lineageId: a.lineageId,
      x,
      y,
      dirX: dx,
      dirY: dy,
      energy: childEnergy,
      age: 0,
      genome,
      attackCooldown: 0,
      memoryX: -1,
      memoryY: -1,
      memoryTick: -9999,
      alive: true,
    };
  }

  /** 死亡处理：遗体能量回归土壤（受格子容量钳制）；余额（可为负）计入账本后随移除消失 */
  private dieAt(index: number): void {
    const a = this.agents[index];
    a.alive = false;
    this.counters.deaths++;
    // 死因归因：衰老优先，其余按最近伤害来源；饿死含险境与疫后虚弱
    const cause: keyof DeathCauses =
      a.age > maxAgeOf(a.genome.size)
        ? 'age'
        : a.damageTag === 2
          ? 'plague'
          : a.damageTag === 1
            ? 'hazard'
            : 'starve';
    this.counters.deathsByCause[cause]++;
    this.bumpSpeciesDeath(a.speciesId, cause);
    // 饿死时余额为负：移除它会向系统注回 |余额|，账本必须同步冲减耗散
    this.counters.dissipated += a.energy;
    this.dropCorpse(a);
    this.removeAgent(index);
  }

  // -------------------------------------------------------------------------
  // 神迹（tick 边界注入的空间级干预；rng 消耗走 sim.rng，确定性语义同 updateRules）
  // -------------------------------------------------------------------------

  /**
   * 释放神迹，返回受影响格数 / 击杀数（事件文案用）。
   *
   * - bloom（雨露）：圆内可通行格注入食物（钳到该格承载上限）；
   * - bless（丰饶）：圆内可通行格食物回满承载上限；
   * - smite（天罚）：圆内个体随机击杀 power 比例（0.01~0.5），死因归天灾。
   *
   * via 为干预来源前缀（如 '按 AI 建议'），仅影响事件文案。
   * bloom/bless 只动环境食物库（与 regrowFood 同性质，不入能量账本）；
   * smite 走现有死亡入账，账本恒等式保持。
   */
  miracle(
    kind: 'bloom' | 'smite' | 'bless',
    x: number,
    y: number,
    radius: number,
    power: number,
    via?: string,
  ): number {
    const w = this.world;
    const label = `实验者${via ?? ''}降下神迹`;
    const r2 = radius * radius;
    const gx0 = Math.max(0, Math.floor(x - radius));
    const gx1 = Math.min(w.width - 1, Math.ceil(x + radius));
    const gy0 = Math.max(0, Math.floor(y - radius));
    const gy1 = Math.min(w.height - 1, Math.ceil(y + radius));

    if (kind === 'bloom' || kind === 'bless') {
      let affected = 0;
      for (let gy = gy0; gy <= gy1; gy++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const dx = gx + 0.5 - x;
          const dy = gy + 0.5 - y;
          if (dx * dx + dy * dy > r2) continue;
          const i = w.cellIndex(gx, gy);
          const t = w.terrain[i];
          if (t === TERRAIN_OBSTACLE || t === TERRAIN_HAZARD) continue;
          const cap = w.foodCap(i);
          if (cap <= 0) continue;
          if (kind === 'bless') {
            w.food[i] = cap;
          } else {
            const per = Math.min(8, Math.max(0.5, power));
            w.food[i] = Math.min(cap, w.food[i] + per);
          }
          affected++;
        }
      }
      const name = kind === 'bloom' ? '雨露' : '丰饶';
      const detail =
        kind === 'bloom'
          ? `在 (${Math.round(x)}, ${Math.round(y)}) 半径 ${Math.round(radius)} 内撒下食物`
          : `(${Math.round(x)}, ${Math.round(y)}) 半径 ${Math.round(radius)} 内土地回满生机`;
      this.pendingEvents.push({
        t: this.tick,
        kind: 'miracle',
        msg: `${label}「${name}」：${detail}，${affected} 格土地受益`,
      });
      return affected;
    }

    // smite（天罚）：圆内个体随机击杀 power 比例
    const ratio = Math.min(0.5, Math.max(0.005, power));
    const inRange: number[] = [];
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.alive) continue;
      const dx = a.x - x;
      const dy = a.y - y;
      if (dx * dx + dy * dy > r2) continue;
      inRange.push(i);
    }
    let target = Math.floor(inRange.length * ratio);
    if (target < 1 && inRange.length > 0) target = 1;
    // Fisher–Yates 洗牌取前 target 个（rng 走 sim.rng，确定性）
    for (let i = inRange.length - 1; i > 0; i--) {
      const j = this.rng.int(i + 1);
      const tmp = inRange[i];
      inRange[i] = inRange[j];
      inRange[j] = tmp;
    }
    inRange.length = Math.min(target, inRange.length);
    inRange.sort((a, b) => b - a); // 降序：swap-remove 只会挪动已处理区间，安全
    let killed = 0;
    for (const idx of inRange) {
      const a = this.agents[idx];
      if (!a.alive) continue;
      a.damageTag = 1; // 死因归天灾（hazard）
      this.dieAt(idx);
      killed++;
    }
    this.pendingEvents.push({
      t: this.tick,
      kind: 'miracle',
      msg: `${label}「天罚」：雷落 (${Math.round(x)}, ${Math.round(y)})，${killed} 只生灵殒命`,
    });
    return killed;
  }

  /** 累计某物种的一例死亡（全局账本 + 采样窗口增量） */
  private bumpSpeciesDeath(speciesId: number, cause: keyof DeathCauses): void {
    let w = this.speciesDeathsWindow.get(speciesId);
    if (!w) {
      w = emptyDeathCauses();
      this.speciesDeathsWindow.set(speciesId, w);
    }
    w[cause]++;
  }

  private dropCorpse(a: Agent): void {
    const w = this.world;
    const ci = w.cellIndex(clampCell(a.x, w.width), clampCell(a.y, w.height));
    const cap = w.fertility[ci] * this.spec.food.maxPerCell;
    const corpse = CORPSE_ENERGY * a.genome.size;
    const room = cap - w.food[ci];
    if (room > 0) {
      const added = room < corpse ? room : corpse;
      w.food[ci] += added;
      this.counters.corpseEnergy += added;
    }
    // 死亡热区（展示用）：+1 后随时间衰减，封顶防溢出视觉
    this.deathHeat[ci] = Math.min(40, this.deathHeat[ci] + 1);
  }

  /** swap-remove：数组末尾元素换到 index（末尾元素尚未在本 tick 处理） */
  private removeAgent(index: number): void {
    const last = this.agents.length - 1;
    if (index !== last) this.agents[index] = this.agents[last];
    this.agents.pop();
  }

  drainEvents(): SimEvent[] {
    if (this.pendingEvents.length === 0) return [];
    const out = this.pendingEvents;
    this.pendingEvents = [];
    return out;
  }

  drainMetrics(): MetricSample[] {
    if (this.pendingMetrics.length === 0) return [];
    const out = this.pendingMetrics;
    this.pendingMetrics = [];
    return out;
  }
}
