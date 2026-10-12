import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/engine/sim';
import { peacefulSpec } from './helpers';

describe('能量守恒（食物再生关闭时）', () => {
  /**
   * 审计恒等式：Δ(个体能量 + 场上食物) == 尸体回归 − 系统耗散
   * 耗散 = 代谢 + 移动 + 攻击消耗 + 危险区 + 繁殖开销 + 死亡遗能
   */
  it('总能量变化与账本完全吻合', () => {
    const sim = new Simulation(peacefulSpec());

    const totalEnergy = (): number => {
      let sum = sim.world.totalFood();
      for (const a of sim.agents) sum += a.energy;
      return sum;
    };

    for (let round = 0; round < 6; round++) {
      const before = totalEnergy();
      const corpseBefore = sim.counters.corpseEnergy;
      const dissBefore = sim.counters.dissipated;
      for (let i = 0; i < 250; i++) sim.tickOnce();
      const after = totalEnergy();
      const corpseAdded = sim.counters.corpseEnergy - corpseBefore;
      const dissipated = sim.counters.dissipated - dissBefore;

      const delta = after - before;
      const expected = corpseAdded - dissipated;
      // 浮点求和顺序误差（万级格子累加）→ 相对容差 1e-6
      const tolerance = Math.abs(before) * 1e-6 + Math.abs(expected) * 1e-6 + 1e-6;
      expect(
        Math.abs(delta - expected),
        `round ${round}: delta=${delta} 期望=${expected} (corpse=${corpseAdded}, diss=${dissipated})`,
      ).toBeLessThan(tolerance);
    }
  });

  it('能量与食物永不越界', () => {
    const sim = new Simulation(peacefulSpec());
    for (let i = 0; i < 800; i++) {
      sim.tickOnce();
      for (const a of sim.agents) {
        expect(a.energy).toBeGreaterThanOrEqual(-1e-9);
      }
      sim.drainEvents();
      sim.drainMetrics();
    }
  });
});
