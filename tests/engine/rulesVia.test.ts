import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/engine/sim';
import { testSpec } from './helpers';

describe('updateRules via 来源标注', () => {
  it('无 via → 「实验者修改了规则：…」（保持历史文案）', () => {
    const sim = new Simulation(testSpec());
    sim.updateRules({ mutationRate: 0.4 });
    const events = sim.drainEvents();
    const ruleEv = events.find((e) => e.kind === 'rule');
    expect(ruleEv).toBeDefined();
    expect(ruleEv?.msg).toBe('实验者修改了规则：突变率 → 40.0%');
  });

  it("via='按 AI 建议' → 「实验者按 AI 建议修改了规则：…」", () => {
    const sim = new Simulation(testSpec());
    sim.updateRules({ mutationRate: 0.4, foodRegrow: 0.02 }, '按 AI 建议');
    const events = sim.drainEvents();
    const ruleEv = events.find((e) => e.kind === 'rule');
    expect(ruleEv).toBeDefined();
    expect(ruleEv?.msg).toBe('实验者按 AI 建议修改了规则：突变率 → 40.0%，食物再生 → 0.0200');
  });

  it('规则值不变时无论 via 与否都不产生事件', () => {
    const spec = testSpec();
    const sim = new Simulation(spec);
    sim.updateRules({ mutationRate: spec.rules.mutationRate }, '按 AI 建议');
    expect(sim.drainEvents().some((e) => e.kind === 'rule')).toBe(false);
  });
});
