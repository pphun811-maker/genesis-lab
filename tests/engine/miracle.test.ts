import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/engine/sim';
import { testSpec } from './helpers';

/** 圆内个体数（与引擎天罚的选点逻辑一致：以个体坐标判距离） */
function countInCircle(sim: Simulation, x: number, y: number, r: number): number {
  let n = 0;
  for (const a of sim.agents) {
    if (!a.alive) continue;
    const dx = a.x - x;
    const dy = a.y - y;
    if (dx * dx + dy * dy <= r * r) n++;
  }
  return n;
}

describe('神迹 · 雨露（bloom）', () => {
  it('圆内可通行格食物增加且不超承载上限，事件带 via 前缀', () => {
    const sim = new Simulation(testSpec());
    const w = sim.world;
    // 找一个有存活个体的位置作为圆心
    const a = sim.agents[0];
    const r = 10;

    // 圆内某格的释放前食物
    const ci = w.cellIndex(Math.max(0, Math.min(w.width - 1, a.x | 0)), Math.max(0, Math.min(w.height - 1, a.y | 0)));
    const before = w.terrain[ci] === 0 ? w.food[ci] : -1;

    const affected = sim.miracle('bloom', a.x, a.y, r, 3, '按 AI 建议');

    expect(affected).toBeGreaterThan(0);
    if (before >= 0) {
      const cap = w.foodCap(ci);
      expect(w.food[ci]).toBeGreaterThan(before);
      expect(w.food[ci]).toBeLessThanOrEqual(cap);
    }
    const events = sim.drainEvents();
    const ev = events.find((e) => e.kind === 'miracle');
    expect(ev?.msg).toContain('实验者按 AI 建议降下神迹「雨露」');
  });

  it('多次注入不越过格子承载上限', () => {
    const sim = new Simulation(testSpec());
    const w = sim.world;
    const a = sim.agents[0];
    // 连续多次大雨露
    for (let i = 0; i < 5; i++) sim.miracle('bloom', a.x, a.y, 8, 8);
    // 圆内所有可通行格都不得超过自身承载
    const gx0 = Math.max(0, ((a.x - 8) | 0) - 1);
    const gx1 = Math.min(w.width - 1, ((a.x + 8) | 0) + 1);
    for (let gy = 0; gy < w.height; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const i = w.cellIndex(gx, gy);
        if (w.terrain[i] !== 0) continue;
        if (w.food[i] > 0) {
          expect(w.food[i]).toBeLessThanOrEqual(w.foodCap(i) + 1e-6);
        }
      }
    }
  });
});

describe('神迹 · 丰饶（bless）', () => {
  it('圆内可通行格食物回满承载上限', () => {
    const sim = new Simulation(testSpec());
    const w = sim.world;
    const a = sim.agents[0];
    const r = 12;
    sim.miracle('bless', a.x, a.y, r, 0);

    const gx0 = Math.max(0, ((a.x - r) | 0) - 1);
    const gx1 = Math.min(w.width - 1, ((a.x + r) | 0) + 1);
    const gy0 = Math.max(0, ((a.y - r) | 0) - 1);
    const gy1 = Math.min(w.height - 1, ((a.y + r) | 0) + 1);
    let checked = 0;
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const dx = gx + 0.5 - a.x;
        const dy = gy + 0.5 - a.y;
        if (dx * dx + dy * dy > r * r) continue;
        const i = w.cellIndex(gx, gy);
        if (w.terrain[i] !== 0) continue;
        const cap = w.foodCap(i);
        if (cap <= 0) continue;
        checked++;
        expect(w.food[i]).toBeCloseTo(cap, 5);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('神迹 · 天罚（smite）', () => {
  it('击杀数 = 圆内个体数 × 比例（至少 1），死因归天灾，账本一致', () => {
    const sim = new Simulation(testSpec());
    const a = sim.agents[0];
    const r = 25;
    const inCircle = countInCircle(sim, a.x, a.y, r);
    expect(inCircle).toBeGreaterThan(0);
    const deathsBefore = sim.counters.deaths;
    const hazardBefore = sim.counters.deathsByCause.hazard;
    const corpseBefore = sim.counters.corpseEnergy;

    const killed = sim.miracle('smite', a.x, a.y, r, 0.5);
    const expected = Math.max(1, Math.floor(inCircle * 0.5));

    expect(killed).toBe(Math.min(expected, inCircle));
    expect(sim.counters.deaths - deathsBefore).toBe(killed);
    // 新构造世界个体均为幼年，天罚死因全部归 hazard
    expect(sim.counters.deathsByCause.hazard - hazardBefore).toBe(killed);
    // 尸体能量入账（账本恒等式的 smite 侧）
    expect(sim.counters.corpseEnergy).toBeGreaterThanOrEqual(corpseBefore);
    // 存活个体数同步减少
    expect(sim.agents.filter((ag) => ag.alive).length).toBe(
      sim.agents.length,
    ); // 数组里已无死个体（swap-remove）
    const events = sim.drainEvents();
    const ev = events.find((e) => e.kind === 'miracle');
    expect(ev?.msg).toContain(`实验者降下神迹「天罚」`);
    expect(ev?.msg).toContain(`${killed} 只生灵殒命`);
  });

  it('比例钳制到 0.5 上限：power 0.9 与 0.5 效果一致', () => {
    const simA = new Simulation(testSpec());
    const simB = new Simulation(testSpec());
    const a = simA.agents[0];
    const r = 20;
    const killedA = simA.miracle('smite', a.x, a.y, r, 0.9);
    const b = simB.agents[0];
    const killedB = simB.miracle('smite', b.x, b.y, r, 0.5);
    expect(killedA).toBe(killedB);
  });
});

describe('神迹 · 确定性', () => {
  it('同 seed 同参数下天罚结果一致（rng 走 sim.rng）', () => {
    const run = (): { killed: number; pop: number } => {
      const sim = new Simulation(testSpec());
      const a = sim.agents[0];
      const killed = sim.miracle('smite', a.x, a.y, 30, 0.4);
      return { killed, pop: sim.agents.length };
    };
    const r1 = run();
    const r2 = run();
    expect(r1).toEqual(r2);
  });
});
