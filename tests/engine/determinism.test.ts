import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/engine/sim';
import { stateFingerprint, testSpec } from './helpers';

describe('确定性', () => {
  it('同 seed 同定义两次运行逐 tick 一致', () => {
    const spec = testSpec();
    const a = new Simulation(structuredClone(spec));
    const b = new Simulation(structuredClone(spec));

    for (let checkpoint = 0; checkpoint < 5; checkpoint++) {
      for (let i = 0; i < 100; i++) {
        a.tickOnce();
        b.tickOnce();
      }
      expect(stateFingerprint(b)).toBe(stateFingerprint(a));
    }
  });

  it('快照恢复后继续运行与原轨迹一致（分叉点的科学意义）', () => {
    const sim = new Simulation(testSpec());
    for (let i = 0; i < 300; i++) sim.tickOnce();

    const revived = Simulation.fromState(sim.toState());
    for (let i = 0; i < 200; i++) {
      sim.tickOnce();
      revived.tickOnce();
    }
    expect(stateFingerprint(revived)).toBe(stateFingerprint(sim));
  });

  it('从同一快照出发的两个模拟彼此一致', () => {
    const sim = new Simulation(testSpec());
    for (let i = 0; i < 200; i++) sim.tickOnce();
    const state = sim.toState();

    const c1 = Simulation.fromState(state);
    const c2 = Simulation.fromState(state);
    for (let i = 0; i < 150; i++) {
      c1.tickOnce();
      c2.tickOnce();
    }
    expect(stateFingerprint(c2)).toBe(stateFingerprint(c1));
  });
});
