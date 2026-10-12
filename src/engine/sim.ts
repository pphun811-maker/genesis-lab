import { steer, clampCell } from './behavior';
import { crossoverGenome, genomeFromTemplate, mutateGenome } from './genome';
import { Rng } from './rng';
import { SpeciesTable } from './species';
import { SpatialHash } from './spatial';
import {
  DEATH_CAUSE_KEYS,
  TERRAIN_HAZARD,
  TERRAIN_NORMAL,
  emptyDeathCauses,
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
const SENSE_COST = 0.15; // 感知半径的代谢代价系数
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
      const info = this.species.found(tpl.name, tpl.color, founderGenome, 0);
      for (let i = 0; i < tpl.count; i++) {
        const genome = genomeFromTemplate(tpl, this.rng);
        const [x, y] = this.randomPassablePos();
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

  private randomPassablePos(): [number, number] {
    for (let tries = 0; tries < 60; tries++) {
      const x = this.rng.next() * this.spec.width;
      const y = this.rng.next() * this.spec.height;
      if (this.world.passable(x | 0, y | 0)) return [x, y];
    }
    return [this.spec.width / 2, this.spec.height / 2];
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
    const ctx = { world: w, hash: this.hash, rng: this.rng, tick: t };
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
      const st = steer(a, ctx);
      a.intent = st.intent;
      a.dirX = st.dirX;
      a.dirY = st.dirY;
      let moved = 0;
      const step = a.genome.speed * st.effort;
      if (step > 0) {
        moved = this.moveAgent(a, step);
      }

      // ---- 进食与危险区 ----
      const cx = clampCell(a.x, w.width);
      const cy = clampCell(a.y, w.height);
      const ci = w.cellIndex(cx, cy);
      if (w.terrain[ci] === TERRAIN_NORMAL) {
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
      } else if (w.terrain[ci] === TERRAIN_HAZARD) {
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
      const drain =
        (BASE_METAB * a.genome.size * a.genome.metabolism * (1 + SENSE_COST * a.genome.sense) +
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

  /** 尝试朝 dirX/dirY 移动一步，返回实际位移（碰撞时尝试滑行/转向） */
  private moveAgent(a: Agent, step: number): number {
    // 内联 World.passable（全引擎最热路径之一，逐 tick 数千次调用）。
    // 语义与 World.passable 完全一致：越界或障碍格不可通行；注意
    // 分数坐标在 Uint8Array 上取值为 undefined（= 可通行），这里用
    // 整数判定走快路径，避免分数键访问 TypedArray 的慢路径。
    const w = this.world;
    const W = w.width;
    const terr = w.terrain;
    const nx = a.x + a.dirX * step;
    const ny = a.y + a.dirY * step;
    if (nx >= 0 && ny >= 0 && nx < W && ny < w.height) {
      const idx = ny * W + nx;
      if (idx !== (idx | 0) || terr[idx] !== 1) {
        a.x = nx;
        a.y = ny;
        return step;
      }
    }
    // 滑行：先试只走 x，再试只走 y，都不行则调头
    const nx2 = a.x + a.dirX * step;
    if (nx2 >= 0 && nx2 < W && a.y >= 0 && a.y < w.height) {
      const idx = a.y * W + nx2;
      if (idx !== (idx | 0) || terr[idx] !== 1) {
        a.x = nx2;
        a.dirY = -a.dirY;
        return step * 0.8;
      }
    }
    const ny2 = a.y + a.dirY * step;
    if (ny2 >= 0 && ny2 < w.height && a.x >= 0 && a.x < W) {
      const idx = ny2 * W + a.x;
      if (idx !== (idx | 0) || terr[idx] !== 1) {
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
    if (!this.world.passable(x | 0, y | 0)) {
      x = parent.x;
      y = parent.y;
    }
    const [dx, dy] = this.rng.direction();

    const assigned = this.species.assign(genome, t);
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
    const r = self.genome.sense;
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
    if (!this.world.passable(x | 0, y | 0)) {
      x = a.x;
      y = a.y;
    }
    const [dx, dy] = this.rng.direction();

    const assigned = this.species.assign(genome, t);
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
