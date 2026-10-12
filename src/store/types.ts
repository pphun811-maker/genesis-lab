import type { MetricSample, SimEvent, SimState, WorldSpec } from '../engine/types';

export interface SpeciesMeta {
  name: string;
  color: string;
  /** 特征标签（迅捷/锐目…） */
  tags?: string[];
  /** 一句话生态位 */
  niche?: string;
  /** 拉丁双名 */
  latin?: string;
  /** 祖先物种 id；null = 初始物种 */
  parentId?: number | null;
  /** 诞生 tick（谱系树用） */
  foundedTick?: number;
  /** 灭绝 tick；null = 存续 */
  extinctTick?: number | null;
  /** 已灭绝 */
  extinct?: boolean;
}

export interface ExperimentRecord {
  id: string;
  name: string;
  spec: WorldSpec;
  parentId?: string;
  forkedAtTick?: number;
  createdAt: number;
  lastTick: number;
  lastPop: number;
  running: boolean;
  /** 最新快照（暂停/定期保存），用于续跑与分叉 */
  snapshot: SimState | null;
  metrics: MetricSample[];
  events: SimEvent[];
  species: Record<number, SpeciesMeta>;
}

/** 指标序列超长时抽稀，避免长实验内存无限增长 */
export function decimateMetrics(samples: MetricSample[]): void {
  if (samples.length <= 8000) return;
  const kept: MetricSample[] = [];
  for (let i = 0; i < samples.length; i += 2) kept.push(samples[i]);
  samples.length = 0;
  for (const s of kept) samples.push(s);
}
