import { describe, expect, it } from 'vitest';
import { generateWorldSpecByRules } from '../../src/llm/rulesFallback';
import { normalizeSpec } from '../../src/engine/presets';
import { GENE_KEYS, GENE_RANGE } from '../../src/engine/types';

describe('规则兜底生成（generateWorldSpecByRules）', () => {
  it('沙漠主题：食物稀少、危险偏高、色系偏黄', () => {
    const { spec, applied } = generateWorldSpecByRules('一个干旱的沙漠世界，生命稀少', 1);

    expect(spec.food.maxPerCell).toBeGreaterThanOrEqual(2);
    expect(spec.food.maxPerCell).toBeLessThanOrEqual(7); // 基础 18 × 0.35 ≈ 6.3
    expect(spec.terrain.hazardRatio).toBeGreaterThanOrEqual(0.07); // 0.02 + 0.06
    expect(spec.terrain.hazardRatio).toBeLessThanOrEqual(0.2);

    for (const s of spec.species) {
      const hue = s.genome.hue ?? -1;
      expect(hue).toBeGreaterThan(20); // 黄色系
      expect(hue).toBeLessThan(90);
    }

    expect(spec.name).toContain('荒漠');
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.some((m) => m.includes('沙漠'))).toBe(true);
  });

  it('「快速演化的海洋世界，3种生物」：高突变、3 支物种、蓝色系', () => {
    const { spec } = generateWorldSpecByRules('快速演化的海洋世界，3种生物', 2);

    expect(spec.rules.mutationRate).toBeGreaterThanOrEqual(0.4);
    expect(spec.species).toHaveLength(3);
    for (const s of spec.species) {
      const hue = s.genome.hue ?? -1;
      expect(hue).toBeGreaterThanOrEqual(180); // 蓝色系
      expect(hue).toBeLessThanOrEqual(260);
    }
  });

  it('和平世界：全部攻击性为 0、没有危险区、食物丰富', () => {
    const { spec } = generateWorldSpecByRules('一个和平无害的花园世界', 3);

    expect(spec.terrain.hazardRatio).toBe(0);
    expect(spec.food.maxPerCell).toBeGreaterThan(18); // 基础 18 × 1.5
    for (const s of spec.species) {
      expect(s.genome.aggression).toBe(0);
    }
  });

  it('捕食者主题：追加猎手物种（高攻击大体型高速，数量为基础种群 1/8）', () => {
    const { spec } = generateWorldSpecByRules('凶猛的捕食者与成群的食草动物', 4);

    expect(spec.species).toHaveLength(2);
    const prey = spec.species[0];
    const hunter = spec.species[1];
    expect(prey.genome.aggression).toBe(0); // 猎物/食草 → 攻击性归零
    expect(hunter.genome.aggression).toBeGreaterThanOrEqual(0.9);
    expect(hunter.genome.size).toBeGreaterThanOrEqual(1.5);
    expect(hunter.genome.speed).toBeGreaterThanOrEqual(1.0);
    expect(hunter.count).toBe(Math.round(prey.count / 8));
  });

  it('数字解析：N 种生物 → N 支物种（上限 6）', () => {
    expect(generateWorldSpecByRules('一个世界，8种生物', 5).spec.species).toHaveLength(6);
    expect(generateWorldSpecByRules('一个世界，2种生物', 5).spec.species).toHaveLength(2);
  });

  it('各种组合的输出经 normalizeSpec 后仍在全部合法范围内', () => {
    const inputs = [
      '广阔的大世界，凶猛的捕食者猎杀温顺的食草动物，危险致命，快速演化，贫瘠荒芜',
      '富饶肥沃的小世界，安全稳定，低突变，5种物种',
      '炎热的热带海洋，8种生物',
      '寒冷极地冰原，荒芜贫瘠，2种生物，和平',
      '一个普通的世界',
    ];

    inputs.forEach((nl, i) => {
      const seed = 100 + i;
      const { spec, applied } = generateWorldSpecByRules(nl, seed);
      expect(applied.length).toBeGreaterThan(0); // 每个输入至少有一条规则生效或兜底说明

      const re = normalizeSpec(spec, seed); // 再次钳制应保持稳定
      expect(re.width).toBeGreaterThanOrEqual(40);
      expect(re.width).toBeLessThanOrEqual(280);
      expect(re.height).toBeGreaterThanOrEqual(40);
      expect(re.height).toBeLessThanOrEqual(280);
      expect(re.food.maxPerCell).toBeGreaterThanOrEqual(2);
      expect(re.food.maxPerCell).toBeLessThanOrEqual(60);
      expect(re.food.regrow).toBeGreaterThanOrEqual(0.001);
      expect(re.food.regrow).toBeLessThanOrEqual(0.1);
      expect(re.terrain.obstacleRatio).toBeGreaterThanOrEqual(0);
      expect(re.terrain.obstacleRatio).toBeLessThanOrEqual(0.3);
      expect(re.terrain.hazardRatio).toBeGreaterThanOrEqual(0);
      expect(re.terrain.hazardRatio).toBeLessThanOrEqual(0.2);
      expect(re.rules.mutationRate).toBeGreaterThanOrEqual(0);
      expect(re.rules.mutationRate).toBeLessThanOrEqual(0.6);
      expect(re.rules.maxPopulation).toBeGreaterThanOrEqual(100);
      expect(re.rules.maxPopulation).toBeLessThanOrEqual(20000);
      expect(re.species.length).toBeGreaterThanOrEqual(1);
      expect(re.species.length).toBeLessThanOrEqual(6);

      for (const s of re.species) {
        expect(s.name.length).toBeGreaterThan(0);
        expect(s.name.length).toBeLessThanOrEqual(12);
        expect(s.color).toMatch(/^#[0-9a-f]{6}$/);
        expect(s.count).toBeGreaterThanOrEqual(1);
        expect(s.count).toBeLessThanOrEqual(600);
        for (const key of GENE_KEYS) {
          const v = s.genome[key];
          if (v === undefined) continue;
          const [lo, hi] = GENE_RANGE[key];
          expect(v).toBeGreaterThanOrEqual(lo);
          expect(v).toBeLessThanOrEqual(hi);
        }
      }
    });
  });
});
