import { PRESETS } from '../../src/engine/presets';
import type { WorldSpec } from '../../src/engine/types';

/** 测试用小世界：跑得快，动态齐全（含捕食者） */
export function testSpec(seed = 42): WorldSpec {
  const spec = PRESETS.find((p) => p.id === 'arms-race')!.spec(seed);
  return {
    ...spec,
    width: 120,
    height: 120,
    species: spec.species.map((s) => ({ ...s, count: Math.round(s.count / 3) })),
  };
}

/** 无捕食者的纯食草世界（守恒测试用） */
export function peacefulSpec(seed = 7): WorldSpec {
  const spec = PRESETS.find((p) => p.id === 'primordial')!.spec(seed);
  return {
    ...spec,
    width: 100,
    height: 100,
    food: { maxPerCell: 40, regrow: 0 },
    species: spec.species.map((s) => ({ ...s, count: 60 })),
  };
}

/** 世界状态的粗略指纹（用于确定性比较） */
export function stateFingerprint(sim: {
  tick: number;
  agents: Array<{ id: number; x: number; y: number; energy: number; genome: object; alive: boolean }>;
  counters: { births: number; deaths: number; kills: number; corpseEnergy: number };
}): string {
  const parts: string[] = [
    String(sim.tick),
    String(sim.agents.length),
    String(sim.counters.births),
    String(sim.counters.deaths),
    String(sim.counters.kills),
    sim.counters.corpseEnergy.toFixed(6),
  ];
  for (const a of sim.agents) {
    parts.push(
      `${a.id}:${a.x.toFixed(4)},${a.y.toFixed(4)},${a.energy.toFixed(4)},${JSON.stringify(a.genome)}`,
    );
  }
  return parts.join('|');
}
