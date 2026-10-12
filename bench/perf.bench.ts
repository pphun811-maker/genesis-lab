/**
 * 性能基准：猎食军备竞赛预设 @ 2000 个体
 *
 * 运行：npx tsx bench/perf.bench.ts
 *
 * 不依赖 vitest，直接驱动引擎。引擎文件零改动，保证确定性语义不变。
 * 目标：平均单 tick < 8ms（2000 个体）。
 */

import { Simulation } from '../src/engine/sim';
import { PRESETS } from '../src/engine/presets';
import type { WorldSpec } from '../src/engine/types';

const SEED = 20260412;
const TARGET_POP = 1800; // 预热目标种群
const WARMUP_MIN_TICKS = 3000; // 至少预热 3000 tick
const WARMUP_MAX_TICKS = 20000; // 预热硬上限
const MEASURE_TICKS = 500; // 计时 tick 数
const BUDGET_AVG_MS = 8; // 达标线：平均单 tick 8ms

function buildSpec(): WorldSpec {
  const preset = PRESETS.find((p) => p.id === 'arms-race');
  if (!preset) throw new Error('preset "arms-race" not found');
  const spec = preset.spec(SEED);
  spec.rules.maxPopulation = 2000; // 抬高承载上限，让种群能长到 ~2000
  return spec;
}

function quantile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1)); // nearest-rank
  return sorted[idx];
}

// ---------------------------------------------------------------------------
// 1) 构造世界
// ---------------------------------------------------------------------------

const spec = buildSpec();
const sim = new Simulation(spec);

console.log(`[bench] preset = arms-race (猎食军备竞赛), seed = ${SEED}`);
console.log(
  `[bench] world ${spec.width}x${spec.height}, species = ${spec.species.length}, ` +
    `initial population = ${sim.agents.length}, maxPopulation = ${sim.spec.rules.maxPopulation}`,
);

// ---------------------------------------------------------------------------
// 2) 预热：跑到种群 >= 1800（至少 3000 tick，最多 20000 tick）
// ---------------------------------------------------------------------------

const growth: Array<{ tick: number; population: number }> = [];
const growthSampleEvery = 100;

let warmTicks = 0;
let reached = false;
growth.push({ tick: 0, population: sim.agents.length });

while (warmTicks < WARMUP_MAX_TICKS) {
  sim.tickOnce();
  warmTicks++;
  if (warmTicks % growthSampleEvery === 0) {
    growth.push({ tick: warmTicks, population: sim.agents.length });
  }
  if (warmTicks >= WARMUP_MIN_TICKS && sim.agents.length >= TARGET_POP) {
    reached = true;
    break;
  }
}

const warmupPopulation = sim.agents.length;
console.log(
  `[bench] warmup: ${warmTicks} ticks, population ${growth[0].population} -> ${warmupPopulation}` +
    `${reached ? ` (>= ${TARGET_POP} reached)` : ` (target ${TARGET_POP} NOT reached, using final population)`}`,
);

// 打印种群增长曲线（等距抽样 + 终点）
const curvePoints = 10;
const step = Math.max(1, Math.floor(growth.length / curvePoints));
const curve: string[] = [];
for (let i = 0; i < growth.length; i += step) {
  curve.push(`${growth[i].tick}:${growth[i].population}`);
}
const last = growth[growth.length - 1];
if (growth.length % step !== 0) curve.push(`${last.tick}:${last.population}`);
console.log(`[bench] growth (tick:pop) ${curve.join('  ')}`);

// ---------------------------------------------------------------------------
// 3) 计时：500 tick 的单 tick 耗时
// ---------------------------------------------------------------------------

const samples: number[] = new Array(MEASURE_TICKS);
// 先空跑 20 tick 让 JIT 充分热身，不计入样本
for (let i = 0; i < 20; i++) sim.tickOnce();

const measureStartPop = sim.agents.length;
for (let i = 0; i < MEASURE_TICKS; i++) {
  const t0 = performance.now();
  sim.tickOnce();
  samples[i] = performance.now() - t0;
}
const measureEndPop = sim.agents.length;

const sorted = [...samples].sort((a, b) => a - b);
const avg = samples.reduce((s, v) => s + v, 0) / samples.length;
const p50 = quantile(sorted, 0.5);
const p95 = quantile(sorted, 0.95);
const tps = 1000 / avg;

const round = (v: number, d = 3) => Number(v.toFixed(d));

// ---------------------------------------------------------------------------
// 4) 汇总输出（JSON 单行，便于程序读取）
// ---------------------------------------------------------------------------

const summary = {
  population: measureStartPop,
  avgTickMs: round(avg),
  p50TickMs: round(p50),
  p95TickMs: round(p95),
  ticksPerSecondEstimate: round(tps, 1),
};

console.log(
  `[bench] measured phase: ${MEASURE_TICKS} ticks, population ${measureStartPop} -> ${measureEndPop}`,
);
console.log(
  `[bench] avg=${summary.avgTickMs}ms  P50=${summary.p50TickMs}ms  P95=${summary.p95TickMs}ms  ` +
    `~${summary.ticksPerSecondEstimate} ticks/s`,
);
console.log(`[bench] target: avg tick < ${BUDGET_AVG_MS}ms @ ~2000 agents -> ${avg < BUDGET_AVG_MS ? 'PASS' : 'FAIL'}`);
console.log(JSON.stringify(summary));
