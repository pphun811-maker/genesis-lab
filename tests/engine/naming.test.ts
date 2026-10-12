import { describe, expect, it } from 'vitest';
import { describeGenome } from '../../src/engine/naming';
import { Simulation } from '../../src/engine/sim';
import { DEFAULT_GENOME, type Genome, type WorldSpec } from '../../src/engine/types';
import { testSpec } from './helpers';

describe('物种命名器（现实生物命名风格）', () => {
  it('纯函数确定性：相同基因组必得相同描述', () => {
    const g: Genome = { ...DEFAULT_GENOME, speed: 1.8, aggression: 0.8 };
    const a = describeGenome(g);
    const b = describeGenome({ ...g });
    expect(b).toEqual(a);
    expect(a.name.length).toBeGreaterThan(0);
    expect(a.latin).toMatch(/^[A-Z][a-z]+ [a-z]+$/);
    expect(a.tags.length).toBeGreaterThan(0);
  });

  it('默认基因组 → 「绿狐」（色相 140 = 绿，默认性状 = 狐）+ Vulpes vulgaris', () => {
    const d = describeGenome({ ...DEFAULT_GENOME });
    expect(d.name).toBe('绿狐');
    expect(d.latin).toBe('Vulpes vulgaris');
    expect(d.tags).toEqual(['均衡']);
  });

  it('颜色字随色相基因变化：hue 200 → 蓝', () => {
    const d = describeGenome({ ...DEFAULT_GENOME, hue: 200 });
    expect(d.name).toBe('蓝狐');
  });

  it('凶猛巨兽 → 「尖牙虎」（尖牙描述符 + 虎类群）+ Panthera ferox', () => {
    const d = describeGenome({ ...DEFAULT_GENOME, size: 2.4, aggression: 0.9 });
    expect(d.name).toBe('尖牙虎');
    expect(d.latin).toBe('Panthera ferox');
    expect(d.tags).toContain('凶猛');
    expect(d.tags).toContain('巨躯');
    expect(d.niche).toContain('掠食者');
  });

  it('迅捷个体 → 「疾羚」（疾描述符 + 羚类群）+ Gazella celer', () => {
    const d = describeGenome({ ...DEFAULT_GENOME, speed: 2.0 });
    expect(d.name).toBe('疾羚');
    expect(d.latin).toBe('Gazella celer');
    expect(d.tags).toContain('迅捷');
  });

  it('胆小群居个体 → 「绿兔」+ Lepus gregarius + 胆小/群居标签', () => {
    const d = describeGenome({ ...DEFAULT_GENOME, fear: 0.9, sociability: 0.9 });
    expect(d.name).toBe('绿兔');
    expect(d.latin).toBe('Lepus gregarius');
    expect(d.tags).toContain('胆小');
    expect(d.tags).toContain('群居');
  });

  it('体型描述符采用「大灰狼」语序：体型 1.5 → 大绿鹿；体型 1.5 + 攻击性 0.7 → 大绿狼', () => {
    // 体型 1.5 命中鹿类群（≥1.3），描述符「大」插在颜色前
    const deer = describeGenome({ ...DEFAULT_GENOME, size: 1.5 });
    expect(deer.name).toBe('大绿鹿');
    expect(deer.latin).toBe('Cervus magnus');
    // 狼类群（攻击性 ≥0.5 但 <0.65 不触发「尖牙」）验证同款语序
    const wolf = describeGenome({ ...DEFAULT_GENOME, size: 1.5, aggression: 0.55 });
    expect(wolf.name).toBe('大绿狼');
    expect(wolf.latin).toBe('Canis ferox');
  });

  it('极端基因组：俗名全中文、拉丁名格式合法、无 NaN', () => {
    const extremes: Genome[] = [
      { speed: 0.1, sense: 2, size: 0.4, metabolism: 0.4, aggression: 0, fear: 0, sociability: 0, reproThreshold: 40, hue: 0 },
      { speed: 2.4, sense: 20, size: 3, metabolism: 2, aggression: 1, fear: 1, sociability: 1, reproThreshold: 320, hue: 359 },
    ];
    for (const g of extremes) {
      const d = describeGenome(g);
      expect(d.name).toMatch(/^[\u4e00-\u9fa5]{2,4}$/);
      expect(d.latin).toMatch(/^[A-Z][a-z]+ [a-z]+$/);
      expect(d.tags.every((t) => /^[\u4e00-\u9fa5]+$/.test(t))).toBe(true);
    }
  });
});

describe('物种事件叙事', () => {
  it('高突变率下分化事件带俗名、拉丁名与特征标签', () => {
    const spec: WorldSpec = {
      ...testSpec(99),
      rules: { mutationRate: 0.5, maxPopulation: 1200 },
      species: testSpec(99).species.map((s) => ({ ...s, count: 60 })),
    };
    const sim = new Simulation(spec);
    let speciationMsg = '';
    for (let i = 0; i < 4000 && !speciationMsg; i++) {
      sim.tickOnce();
      for (const ev of sim.drainEvents()) {
        if (ev.kind === 'speciation') speciationMsg = ev.msg;
      }
      sim.drainMetrics();
    }
    expect(speciationMsg).toMatch(
      /「[\u4e00-\u9fa5·]+」（[A-Z][a-z]+ [a-z]+）自「[\u4e00-\u9fa5·]+」中分化而出 · 特征：.+/,
    );
  });

  it('新物种种名在历史中唯一（重名追加序号）', () => {
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
    const names = sim.species.all.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => !n.startsWith('物种 #'))).toBe(true);
  });

  it('里程碑事件随模拟推进产生（种群/主导/纪录）', () => {
    const sim = new Simulation(testSpec());
    for (let i = 0; i < 6000; i++) {
      sim.tickOnce();
      sim.drainMetrics();
    }
    const milestones = [...sim.drainEvents().filter((e) => e.kind === 'milestone')];
    // 6000 tick 的生态动态足够产生至少一条里程碑
    expect(milestones.length).toBeGreaterThan(0);
    for (const m of milestones) {
      expect(m.msg).not.toMatch(/undefined|NaN/);
    }
  });

  it('初始物种携带特征描述（标签 + 生态位 + 拉丁名）', () => {
    const sim = new Simulation(testSpec());
    for (const s of sim.species.active) {
      expect(s.tags?.length ?? 0).toBeGreaterThan(0);
      expect(s.niche).toBeTruthy();
      expect(s.latin).toMatch(/^[A-Z][a-z]+ [a-z]+$/);
    }
  });
});
