import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../src/engine/presets';
import { Simulation } from '../../src/engine/sim';
import { deserializeExperiment, serializeExperiment } from '../../src/persistence/serialize';
import type { ExperimentRecord } from '../../src/store/types';

function makeRecord(): ExperimentRecord {
  const spec = PRESETS[0].spec(42);
  const sim = new Simulation(spec);
  for (let i = 0; i < 50; i++) sim.tickOnce();
  return {
    id: 'test-exp-1',
    name: '序列化测试',
    spec,
    createdAt: 1700000000000,
    lastTick: 50,
    lastPop: sim.agents.length,
    running: false,
    snapshot: sim.toState(),
    metrics: [
      {
        t: 10,
        pop: 100,
        food: 1234.5,
        species: 2,
        births: 3,
        deaths: 1,
        kills: 0,
        genes: {
          speed: 0.5, sense: 8, size: 1, metabolism: 1,
          aggression: 0.2, fear: 0.4, sociability: 0.3, reproThreshold: 110,
        },
        speciesCounts: [{ id: 1, count: 60 }],
      },
    ],
    events: [{ t: 10, kind: 'system', msg: '测试事件' }],
    species: { 1: { name: '绿藻', color: '#4ade80' } },
  };
}

describe('实验导出/导入序列化', () => {
  it('JSON round-trip 后 typed array 类型与内容一致', () => {
    const rec = makeRecord();
    const json = serializeExperiment(rec);
    const back = deserializeExperiment(json);

    expect(back.id).toBe(rec.id);
    expect(back.name).toBe(rec.name);
    expect(back.snapshot!.food).toBeInstanceOf(Float32Array);
    expect(back.snapshot!.terrain).toBeInstanceOf(Uint8Array);
    expect(back.snapshot!.fertility).toBeInstanceOf(Float32Array);
    expect(back.snapshot!.food.length).toBe(rec.snapshot!.food.length);
    expect(Array.from(back.snapshot!.terrain)).toEqual(Array.from(rec.snapshot!.terrain));
    expect(back.metrics).toEqual(rec.metrics);
    expect(back.events).toEqual(rec.events);
  });

  it('恢复的快照可以继续模拟（与原轨迹一致）', () => {
    const rec = makeRecord();
    const revived = deserializeExperiment(serializeExperiment(rec));
    const a = Simulation.fromState(rec.snapshot!);
    const b = Simulation.fromState(revived.snapshot!);
    for (let i = 0; i < 100; i++) {
      a.tickOnce();
      b.tickOnce();
    }
    expect(b.agents.length).toBe(a.agents.length);
    expect(b.agents[0]?.x).toBe(a.agents[0]?.x);
    expect(b.tick).toBe(a.tick);
  });

  it('无效文件被拒绝', () => {
    expect(() => deserializeExperiment('{"hello": 1}')).toThrow();
    expect(() => deserializeExperiment('not json')).toThrow();
  });
});
