/**
 * IndexedDB 持久层测试。
 *
 * 通过 `fake-indexeddb/auto` 在 Node 环境注入全局 indexedDB 实现；
 * 结构化克隆语义（typed array 类型保留、深拷贝）由 fake-indexeddb 提供。
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteDB } from 'idb';
import type {
  Genome,
  MetricSample,
  SimEvent,
  SimState,
  WorldSpec,
} from '../../src/engine/types';
import type { ExperimentRecord } from '../../src/store/types';
import {
  closeDb,
  deleteExperiment,
  getExperiment,
  getSetting,
  listExperiments,
  saveExperiment,
  setSetting,
} from '../../src/persistence/db';

const DB_NAME = 'genesis-lab';

// ---------------------------------------------------------------------------
// 测试数据构造
// ---------------------------------------------------------------------------

function makeGenome(overrides: Partial<Genome> = {}): Genome {
  return {
    speed: 0.55,
    sense: 8,
    size: 1,
    metabolism: 1,
    aggression: 0.15,
    fear: 0.4,
    sociability: 0.35,
    reproThreshold: 110,
    hue: 140,
    ...overrides,
  };
}

function makeSpec(): WorldSpec {
  return {
    name: '原始汤',
    seed: 20260101,
    width: 64,
    height: 48,
    food: { maxPerCell: 50, regrow: 0.8 },
    terrain: { obstacleRatio: 0.05, hazardRatio: 0.02 },
    species: [
      {
        name: '蓝藻',
        color: '#38bdf8',
        count: 40,
        genome: { speed: 0.6, aggression: 0.1 },
        variance: { speed: 0.05, hue: 4 },
      },
      {
        name: '草履虫',
        color: '#f59e0b',
        count: 25,
        genome: { sense: 10, sociability: 0.6 },
      },
    ],
    rules: { mutationRate: 0.03, maxPopulation: 2000 },
  };
}

/** 构造含 typed array 的真实感快照（64×48 网格） */
function makeSnapshot(spec: WorldSpec): SimState {
  const cells = spec.width * spec.height;
  const food = new Float32Array(cells);
  const fertility = new Float32Array(cells);
  const terrain = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) {
    food[i] = (i * 7) % 53 + 0.5;
    fertility[i] = ((i * 13) % 100) / 100;
    terrain[i] = i % 17 === 0 ? 1 : i % 41 === 0 ? 2 : 0;
  }

  return {
    version: 1,
    spec: structuredClone(spec),
    tick: 1234,
    rngState: 0x9e3779b9,
    nextAgentId: 3,
    nextSpeciesId: 2,
    agents: [
      {
        id: 1,
        speciesId: 0,
        lineageId: 1,
        x: 12.5,
        y: 30.25,
        dirX: 1,
        dirY: 0,
        energy: 88.5,
        age: 42,
        genome: makeGenome(),
        attackCooldown: 0,
        memoryX: 10,
        memoryY: 28,
        memoryTick: 1200,
        alive: true,
      },
      {
        id: 2,
        speciesId: 1,
        lineageId: 2,
        x: 40,
        y: 8.75,
        dirX: -0.6,
        dirY: 0.8,
        energy: 120,
        age: 7,
        genome: makeGenome({ hue: 210, speed: 0.72 }),
        attackCooldown: 3,
        memoryX: 40,
        memoryY: 9,
        memoryTick: 1233,
        alive: true,
      },
    ],
    food,
    fertility,
    terrain,
    species: [
      {
        id: 0,
        name: '蓝藻',
        color: '#38bdf8',
        centroid: makeGenome(),
        foundedTick: 0,
        extinctTick: null,
        parentSpeciesId: null,
      },
      {
        id: 1,
        name: '草履虫',
        color: '#f59e0b',
        centroid: makeGenome({ hue: 35, sense: 10 }),
        foundedTick: 500,
        extinctTick: null,
        parentSpeciesId: 0,
      },
    ],
    counters: {
      births: 10,
      deaths: 4,
      kills: 1,
      speciations: 1,
      corpseEnergy: 25.5,
      dissipated: 130.75,
      deathsByCause: { starve: 2, predation: 1, age: 1, hazard: 0, plague: 0 },
    },
  };
}

function makeMetrics(): MetricSample[] {
  return [
    {
      t: 0,
      pop: 65,
      food: 4800,
      species: 2,
      births: 0,
      deaths: 0,
      kills: 0,
      genes: {
        speed: 0.56,
        sense: 8.1,
        size: 1,
        metabolism: 1,
        aggression: 0.14,
        fear: 0.4,
        sociability: 0.36,
        reproThreshold: 110,
      },
      speciesCounts: [
        { id: 0, count: 40 },
        { id: 1, count: 25 },
      ],
    },
    {
      t: 100,
      pop: 71,
      food: 4520.5,
      species: 2,
      births: 9,
      deaths: 3,
      kills: 1,
      genes: {
        speed: 0.58,
        sense: 8.3,
        size: 1.02,
        metabolism: 0.99,
        aggression: 0.16,
        fear: 0.41,
        sociability: 0.35,
        reproThreshold: 108.5,
      },
      speciesCounts: [
        { id: 0, count: 44 },
        { id: 1, count: 27 },
      ],
    },
  ];
}

function makeEvents(): SimEvent[] {
  return [
    { t: 500, kind: 'speciation', msg: '草履虫从蓝藻分化', speciesId: 1 },
    { t: 1200, kind: 'milestone', msg: '种群突破 70' },
  ];
}

function makeRecord(overrides: Partial<ExperimentRecord> = {}): ExperimentRecord {
  const spec = makeSpec();
  return {
    id: 'exp-0001',
    name: '初始实验：原始汤',
    spec,
    createdAt: 1_700_000_000_000,
    lastTick: 1234,
    lastPop: 65,
    running: false,
    snapshot: makeSnapshot(spec),
    metrics: makeMetrics(),
    events: makeEvents(),
    species: {
      0: { name: '蓝藻', color: '#38bdf8' },
      1: { name: '草履虫', color: '#f59e0b' },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('persistence/db', () => {
  afterEach(async () => {
    // 关闭连接后删除库，保证每个用例拿到干净环境
    await closeDb();
    await deleteDB(DB_NAME);
  });

  it('保存 → 读取 round-trip：typed array 类型保留且整体深相等', async () => {
    const rec = makeRecord({ parentId: 'exp-0000', forkedAtTick: 800 });

    await saveExperiment(rec);
    const read = await getExperiment(rec.id);

    expect(read).toBeDefined();
    // 结构化克隆语义下 typed array 保留具体类型
    expect(read!.snapshot).not.toBeNull();
    expect(read!.snapshot!.food instanceof Float32Array).toBe(true);
    expect(read!.snapshot!.fertility instanceof Float32Array).toBe(true);
    expect(read!.snapshot!.terrain instanceof Uint8Array).toBe(true);
    expect(read!.snapshot!.food.length).toBe(rec.spec.width * rec.spec.height);
    // 整体深相等（含嵌套对象、typed array、Map 风格 Record）
    expect(read).toEqual(rec);
  });

  it('listExperiments 按 createdAt 降序返回', async () => {
    const a = makeRecord({ id: 'exp-a', createdAt: 1_000, snapshot: null });
    const b = makeRecord({ id: 'exp-b', createdAt: 3_000, snapshot: null });
    const c = makeRecord({ id: 'exp-c', createdAt: 2_000, snapshot: null });

    // 乱序写入
    await saveExperiment(c);
    await saveExperiment(a);
    await saveExperiment(b);

    const list = await listExperiments();
    const ids = list.map((r) => r.id);
    expect(ids).toEqual(['exp-b', 'exp-c', 'exp-a']);
  });

  it('deleteExperiment 之后 getExperiment 返回 undefined', async () => {
    const rec = makeRecord({ snapshot: null });
    await saveExperiment(rec);
    expect(await getExperiment(rec.id)).toBeDefined();

    await deleteExperiment(rec.id);
    expect(await getExperiment(rec.id)).toBeUndefined();
  });

  it('settings 的 set/get round-trip', async () => {
    await setSetting('ui', { theme: 'dark', tickRate: 30, showGrid: true });
    await setSetting('autosaveInterval', 15_000);

    expect(await getSetting('ui')).toEqual({ theme: 'dark', tickRate: 30, showGrid: true });
    expect(await getSetting<number>('autosaveInterval')).toBe(15_000);
    expect(await getSetting('missing-key')).toBeUndefined();
  });

  it('同 id 二次保存覆盖旧值', async () => {
    const v1 = makeRecord({ id: 'exp-0001', name: '第一版', lastTick: 100 });
    const v2 = makeRecord({
      id: 'exp-0001',
      name: '第二版',
      lastTick: 2000,
      running: true,
      snapshot: null,
      metrics: [],
      events: [],
      species: {},
    });

    await saveExperiment(v1);
    await saveExperiment(v2);

    const read = await getExperiment('exp-0001');
    expect(read).toBeDefined();
    expect(read!.name).toBe('第二版');
    expect(read!.lastTick).toBe(2000);
    expect(read!.running).toBe(true);
    expect(read!.metrics).toHaveLength(0);
    // 记录总数不变（覆盖而非追加）
    expect(await listExperiments()).toHaveLength(1);
  });
});
