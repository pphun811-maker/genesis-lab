import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/engine/sim';
import { geneticDistance } from '../../src/engine/genome';
import { DEFAULT_GENOME, type WorldSpec } from '../../src/engine/types';
import { testSpec } from './helpers';

describe('物种与演化', () => {
  it('遗传距离：相同基因距离 0，差异越大距离越大', () => {
    const a = { ...DEFAULT_GENOME };
    const b = { ...DEFAULT_GENOME, aggression: 1, size: 3, hue: 180 };
    expect(geneticDistance(a, { ...a })).toBe(0);
    expect(geneticDistance(a, b)).toBeGreaterThan(0.3);
  });

  it('高突变率下会出现物种分化事件', () => {
    const spec: WorldSpec = {
      ...testSpec(99),
      rules: { mutationRate: 0.5, maxPopulation: 1200 },
      species: testSpec(99).species.map((s) => ({ ...s, count: 60 })),
    };
    const sim = new Simulation(spec);
    for (let i = 0; i < 4000; i++) {
      sim.tickOnce();
      sim.drainEvents();
      sim.drainMetrics();
    }
    console.log('物种总数:', sim.species.all.length, '分化次数:', sim.counters.speciations);
    expect(sim.counters.speciations).toBeGreaterThan(0);
    expect(sim.species.all.length).toBeGreaterThan(2);
  });

  it('初始物种按模板建立且个体归入正确物种', () => {
    const spec = testSpec();
    const sim = new Simulation(spec);
    expect(sim.species.active.length).toBe(spec.species.length);
    for (const a of sim.agents) {
      expect(sim.species.active.some((s) => s.id === a.speciesId)).toBe(true);
    }
  });
});
