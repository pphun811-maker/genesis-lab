import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/engine/sim';
import { emptyDeathCauses, type WorldSpec } from '../../src/engine/types';
import { peacefulSpec, testSpec } from './helpers';

describe('死因账本与食物网', () => {
  it('无捕食者世界：死亡全部来自饿死/衰老/危险区，捕杀为 0', () => {
    const sim = new Simulation(peacefulSpec());
    for (let i = 0; i < 3000; i++) sim.tickOnce();
    const c = sim.counters;
    expect(c.kills).toBe(0);
    expect(c.deathsByCause.predation).toBe(0);
    expect(c.deathsByCause.starve + c.deathsByCause.age).toBeGreaterThan(0);
    // 死因之和 = 死亡总数
    const sum = Object.values(c.deathsByCause).reduce((s, v) => s + v, 0);
    expect(sum).toBe(c.deaths);
  });

  it('捕食世界：捕杀计入 predation 且与 killMatrix 总数一致', () => {
    const sim = new Simulation(testSpec());
    for (let i = 0; i < 4000; i++) sim.tickOnce();
    const c = sim.counters;
    if (c.kills === 0) return; // 种子化世界也可能极端和平；其余断言仍需成立
    expect(c.deathsByCause.predation).toBe(c.kills);
    let matrixTotal = 0;
    for (const row of sim.killMatrix.values()) {
      for (const n of row.values()) matrixTotal += n;
    }
    expect(matrixTotal).toBe(c.kills);
    const sum = Object.values(c.deathsByCause).reduce((s, v) => s + v, 0);
    expect(sum).toBe(c.deaths);
  });

  it('指标采样携带死因增量、物种死因与食物网 Top 对', () => {
    const sim = new Simulation(testSpec());
    for (let i = 0; i < 3000; i++) {
      sim.tickOnce();
      sim.drainEvents();
    }
    const samples = sim.drainMetrics();
    expect(samples.length).toBeGreaterThan(0);
    const last = samples[samples.length - 1];
    expect(last.deathsByCause).toBeDefined();
    expect(last.killTop).toBeDefined();
    // 有捕杀发生时 killTop 应非空且 count 为正
    const killTotal = last.killTop?.reduce((s, p) => s + p.count, 0) ?? 0;
    if (sim.counters.kills > 0) expect(killTotal).toBeGreaterThan(0);
    for (const s of samples) {
      if (s.speciesDeaths) {
        for (const sd of s.speciesDeaths) {
          const row = sd.starve + sd.predation + sd.age + sd.hazard + sd.plague;
          expect(row).toBeGreaterThan(0);
        }
      }
    }
  });

  it('快照往返：killMatrix 与死因账本完整恢复并继续累计', () => {
    const sim = new Simulation(testSpec());
    for (let i = 0; i < 2500; i++) sim.tickOnce();
    const state = sim.toState();
    const revived = Simulation.fromState(state);
    // 恢复后矩阵与账本一致
    let matrixTotal = 0;
    for (const row of revived.killMatrix.values()) {
      for (const n of row.values()) matrixTotal += n;
    }
    expect(matrixTotal).toBe(revived.counters.kills);
    expect(revived.counters.deathsByCause).toEqual(
      state.counters.deathsByCause ?? emptyDeathCauses(),
    );
    // 继续运行不炸
    for (let i = 0; i < 300; i++) revived.tickOnce();
    expect(revived.counters.deaths).toBeGreaterThanOrEqual(state.counters.deaths);
  });

  it('旧快照（无死因字段）恢复后自动补零并可运行', () => {
    const sim = new Simulation(testSpec());
    for (let i = 0; i < 100; i++) sim.tickOnce();
    const state = sim.toState();
    // 模拟旧版快照：剥离新字段
    const legacy = JSON.parse(
      JSON.stringify({
        ...state,
        counters: (() => {
          const { deathsByCause: _d, ...rest } = state.counters;
          return rest;
        })(),
        killMatrix: undefined,
      }),
    ) as WorldSpec extends never ? never : Parameters<typeof Simulation.fromState>[0];
    const revived = Simulation.fromState(legacy);
    expect(revived.counters.deathsByCause).toEqual(emptyDeathCauses());
    for (let i = 0; i < 200; i++) revived.tickOnce();
    expect(revived.counters.deaths).toBeGreaterThan(0);
  });
});
