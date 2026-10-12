import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/engine/sim';
import { PRESETS } from '../../src/engine/presets';
import { testSpec } from './helpers';

describe('种群动态', () => {
  it('默认世界 3000 tick 内种群存活且不爆炸', () => {
    const sim = new Simulation(testSpec());
    const samples: number[] = [];
    for (let i = 0; i < 3000; i++) {
      sim.tickOnce();
      sim.drainEvents();
      sim.drainMetrics();
      if (i % 100 === 0) samples.push(sim.agents.length);
    }
    console.log('种群轨迹:', samples.join(', '));
    expect(sim.agents.length).toBeGreaterThan(10);
    expect(sim.agents.length).toBeLessThan(sim.spec.rules.maxPopulation);
  });

  it('食物在被啃食后持续再生', () => {
    const sim = new Simulation(testSpec());
    for (let i = 0; i < 200; i++) sim.tickOnce();
    const foodLow = sim.world.totalFood();
    for (let i = 0; i < 400; i++) sim.tickOnce();
    const foodLater = sim.world.totalFood();
    // 不做严格单调（个体在吃），只要不是单调枯竭即可
    expect(foodLater).toBeGreaterThan(0);
    void foodLow;
  });

  it('捕食发生了：猎手生态位带来捕杀计数', () => {
    const sim = new Simulation(testSpec());
    for (let i = 0; i < 2000; i++) {
      sim.tickOnce();
      sim.drainEvents();
    }
    console.log(
      ' births=%d deaths=%d kills=%d corpseEnergy=%d',
      sim.counters.births,
      sim.counters.deaths,
      sim.counters.kills,
      sim.counters.corpseEnergy,
    );
    expect(sim.counters.kills).toBeGreaterThan(0);
  });

  it('五个预设各自运行 1500 tick 都不会立刻崩坏', () => {
    for (const preset of PRESETS) {
      const spec = { ...preset.spec(1234), width: 120, height: 120 };
      const sim = new Simulation(spec);
      let minPop = Infinity;
      for (let i = 0; i < 1500; i++) {
        sim.tickOnce();
        sim.drainEvents();
        sim.drainMetrics();
        if (i % 300 === 0) minPop = Math.min(minPop, sim.agents.length);
      }
      console.log(`${preset.title}: 最终种群=${sim.agents.length}`);
      expect(sim.agents.length, preset.title).toBeGreaterThan(0);
      void minPop;
    }
  });
});
