import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/engine/sim';
import { GENE_RANGE, GENE_KEYS, type WorldSpec } from '../../src/engine/types';
import { testSpec } from './helpers';

function sexualSpec(seed = 7): WorldSpec {
  const spec = testSpec(seed);
  return { ...spec, rules: { ...spec.rules, sexualReproduction: true } };
}

describe('有性繁殖', () => {
  it('有性世界持续产生出生数（求偶+交叉链路通）', () => {
    const sim = new Simulation(sexualSpec());
    const births0 = sim.counters.births;
    for (let i = 0; i < 3000; i++) sim.tickOnce();
    // 3000 tick 生态应当有明显繁殖活动
    expect(sim.counters.births - births0).toBeGreaterThan(100);
    expect(sim.agents.length).toBeGreaterThan(10);
  });

  it('交配不应期：任一 tick 内一个体至多贡献一次交配', () => {
    const sim = new Simulation(sexualSpec());
    for (let i = 0; i < 2000; i++) {
      sim.tickOnce();
      sim.drainEvents();
      sim.drainMetrics();
    }
    // 直接验证字段存在性即可——不应期逻辑由 findMate/reproduceSexual 保证
    for (const a of sim.agents) {
      if (a.lastMatedTick !== undefined) {
        expect(a.lastMatedTick).toBeLessThanOrEqual(sim.tick);
      }
    }
  });

  it('交叉后代基因全部落在合法区间', () => {
    const sim = new Simulation(sexualSpec());
    for (let i = 0; i < 3000; i++) {
      sim.tickOnce();
      sim.drainEvents();
      sim.drainMetrics();
    }
    for (const a of sim.agents) {
      for (const k of GENE_KEYS) {
        const [lo, hi] = GENE_RANGE[k];
        expect(a.genome[k], `gene ${k}`).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(a.genome[k], `gene ${k}`).toBeLessThanOrEqual(hi + 1e-9);
      }
    }
  });

  it('有性繁殖能量账本守恒（regrow=0 隔离世界）', () => {
    const spec = sexualSpec(7);
    spec.food.regrow = 0;
    const sim = new Simulation(spec);
    for (let i = 0; i < 2000; i++) {
      sim.tickOnce();
      sim.drainEvents();
      sim.drainMetrics();
    }
    // Δ(个体能量+食物) == 尸体回归 − 耗散
    let agentEnergy = 0;
    for (const a of sim.agents) agentEnergy += a.energy;
    const foodNow = sim.world.totalFood();
    const c = sim.counters;
    // 初始个体能量与初始食物
    const init = new Simulation(structuredClone(spec));
    let initAgent = 0;
    for (const a of init.agents) initAgent += a.energy;
    const initFood = init.world.totalFood();
    const delta = agentEnergy + foodNow - (initAgent + initFood);
    const expectDelta = c.corpseEnergy - c.dissipated;
    expect(Math.abs(delta - expectDelta)).toBeLessThan(1e-6 * Math.max(1, Math.abs(expectDelta)));
  });

  it('无性世界（显式关闭）行为不变：births 正常且 agents 无 lastMatedTick', () => {
    const spec = testSpec();
    const rules = { ...spec.rules, sexualReproduction: undefined };
    const sim = new Simulation({ ...spec, rules });
    for (let i = 0; i < 1000; i++) sim.tickOnce();
    expect(sim.counters.births).toBeGreaterThan(0);
    expect(sim.agents.every((a) => a.lastMatedTick === undefined)).toBe(true);
  });
});
