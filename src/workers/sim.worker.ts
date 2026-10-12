/// <reference lib="webworker" />
import { Simulation } from '../engine/sim';
import { describeGenome } from '../engine/naming';
import type { WorldSpec, SimState, MetricSample, SimEvent, SpeciesInfo } from '../engine/types';
import { AGENT_STRIDE, type FrameData, type FrameSpecies, type ToWorker, type FromWorker } from '../client/protocol';

/**
 * 模拟 Worker：拥有 Simulation 实例，自主调度 tick 循环。
 * 每个迭代（~16ms）以时间预算（12ms）内能跑完的 tick 数推进，
 * 然后回传一帧。渲染节奏由主线程决定，与模拟解耦。
 */

let sim: Simulation | null = null;
let running = false;
let tps = 60;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastFoodSentTick = -Infinity;
let needWorldData = true;

function post(msg: FromWorker, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

/** 旧快照恢复的物种缺特征描述：惰性补算（确定性纯函数，代价一次性） */
function ensureDescription(s: SpeciesInfo): void {
  if (!s.tags || !s.niche || !s.latin) {
    const d = describeGenome(s.centroid);
    s.tags = d.tags;
    s.niche = d.niche;
    s.latin = d.latin;
  }
}

function buildFrame(): { frame: FrameData; transfer: Transferable[] } {
  const agents = sim!.agents;
  const n = agents.length;
  const arr = new Float32Array(n * AGENT_STRIDE);
  const speciesList: FrameSpecies[] = [];
  const speciesIdxById = new Map<number, number>();
  // 全量物种名单（含已灭绝），UI 据此展示完整族谱
  for (const s of sim!.species.all) {
    ensureDescription(s);
    speciesIdxById.set(s.id, speciesList.length);
    speciesList.push({
      id: s.id,
      name: s.name,
      color: s.color,
      count: 0,
      tags: s.tags,
      niche: s.niche,
      latin: s.latin,
      parentId: s.parentSpeciesId,
      foundedTick: s.foundedTick,
      extinctTick: s.extinctTick,
      extinct: s.extinctTick !== null,
    });
  }
  for (let i = 0; i < n; i++) {
    const a = agents[i];
    const o = i * AGENT_STRIDE;
    arr[o] = a.id;
    arr[o + 1] = a.x;
    arr[o + 2] = a.y;
    arr[o + 3] = a.genome.hue;
    arr[o + 4] = a.genome.size;
    arr[o + 5] = Math.max(0, Math.min(1, a.energy / (60 + 60 * a.genome.size)));
    let idx = speciesIdxById.get(a.speciesId);
    if (idx === undefined) {
      // 已灭绝物种可能仍被本帧个体引用（同一 tick 内死亡），兜底加入
      const info = sim!.species.all.find((s) => s.id === a.speciesId);
      idx = speciesList.length;
      speciesList.push({
        id: a.speciesId,
        name: info?.name ?? `未知物种 #${a.speciesId}`,
        color: info?.color ?? '#888888',
        count: 0,
        tags: info?.tags,
        niche: info?.niche,
        latin: info?.latin,
        parentId: info?.parentSpeciesId,
        extinct: info ? info.extinctTick !== null : undefined,
      });
      speciesIdxById.set(a.speciesId, idx);
    }
    speciesList[idx].count++;
    arr[o + 6] = idx;
    arr[o + 7] = a.genome.sense;
  }

  // 食物网格与死亡热区节流：至少间隔 max(30, tps/5) 个 tick
  const foodInterval = Math.max(30, tps / 5);
  let food: Float32Array | null = null;
  const transfer: Transferable[] = [arr.buffer];
  if (sim!.tick - lastFoodSentTick >= foodInterval || !running) {
    food = sim!.world.food.slice();
    transfer.push(food.buffer);
    lastFoodSentTick = sim!.tick;
  }
  const deathHeat = food ? sim!.deathHeat.slice() : undefined;
  if (deathHeat) transfer.push(deathHeat.buffer);

  const frame: FrameData = {
    tick: sim!.tick,
    pop: n,
    agents: arr,
    food,
    deathHeat,
    species: speciesList,
    samples: [] as MetricSample[],
    events: [] as SimEvent[],
  };

  if (needWorldData) {
    frame.worldData = {
      width: sim!.world.width,
      height: sim!.world.height,
      terrain: sim!.world.terrain.slice(),
      fertility: sim!.world.fertility.slice(),
      foodMaxPerCell: sim!.spec.food.maxPerCell,
    };
    needWorldData = false;
  }

  return { frame, transfer };
}

function postFrame(): void {
  if (!sim) return;
  const { frame, transfer } = buildFrame();
  frame.samples = sim.drainMetrics();
  frame.events = sim.drainEvents();
  post({ type: 'frame', frame, running }, transfer);
}

function loop(): void {
  if (!running || !sim) return;
  const start = Date.now();
  const target = Math.max(1, Math.round(tps / 62.5));
  let done = 0;
  while (done < target) {
    sim.tickOnce();
    done++;
    if (Date.now() - start > 12) break; // 时间预算：让出线程回传帧
  }
  postFrame();
  const elapsed = Date.now() - start;
  timer = setTimeout(loop, Math.max(1, 16 - elapsed));
}

function stopTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init': {
        sim = new Simulation(msg.spec as WorldSpec);
        needWorldData = true;
        postFrame();
        post({ type: 'inited', tick: sim.tick, paused: true });
        break;
      }
      case 'restore': {
        sim = Simulation.fromState(msg.state as SimState);
        needWorldData = true;
        lastFoodSentTick = -Infinity;
        postFrame();
        post({ type: 'inited', tick: sim.tick, paused: true });
        break;
      }
      case 'run': {
        if (!sim) return;
        if (!running) {
          running = true;
          timer = setTimeout(loop, 0);
        }
        break;
      }
      case 'pause': {
        running = false;
        stopTimer();
        postFrame();
        break;
      }
      case 'setSpeed': {
        tps = Math.max(5, Math.min(12000, msg.tps));
        break;
      }
      case 'step': {
        if (!sim || running) return;
        const n = Math.max(1, Math.min(10000, msg.ticks));
        for (let i = 0; i < n; i++) sim.tickOnce();
        postFrame();
        break;
      }
      case 'updateRules': {
        if (!sim) return;
        sim.updateRules(msg.patch, msg.via);
        postFrame();
        break;
      }
      case 'miracle': {
        if (!sim) return;
        sim.miracle(msg.kind, msg.x, msg.y, msg.radius, msg.power, msg.via);
        postFrame();
        break;
      }
      case 'snapshot': {
        if (!sim) return;
        post({ type: 'snapshot', reqId: msg.reqId, state: sim.toState() });
        break;
      }
      case 'inspect': {
        if (!sim) return;
        const agent = sim.agents.find((a) => a.id === msg.agentId) ?? null;
        let speciesName: string | undefined;
        let speciesTags: string[] | undefined;
        let speciesNiche: string | undefined;
        if (agent) {
          const s = sim.species.all.find((sp) => sp.id === agent.speciesId);
          if (s) {
            ensureDescription(s);
            speciesName = s.name;
            speciesTags = s.tags;
            speciesNiche = s.niche;
          }
        }
        post({ type: 'agentInfo', reqId: msg.reqId, agent, speciesName, speciesTags, speciesNiche });
        break;
      }
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
