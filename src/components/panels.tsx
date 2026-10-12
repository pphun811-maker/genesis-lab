import { useEffect, useState } from 'react';
import type { EChartsCoreOption } from 'echarts';
import {
  DEATH_CAUSE_KEYS,
  DEATH_CAUSE_LABELS,
  maxEnergyOf,
  type Agent,
  type DeathCauses,
  type MetricSample,
  type SimEvent,
} from '../engine/types';
import type { ExperimentRecord } from '../store/types';
import { useExperiments } from '../store/experiments';
import { CHART_BASE, Chart } from './Chart';
import { GenomeBars } from './GenomeBars';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 特征标签 chips（物种卡与个体检查器共用） */
function TagChips({ tags }: { tags: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span
          key={t}
          className="rounded-full border border-lab-border px-1.5 py-px text-[10px] text-lab-muted"
        >
          {t}
        </span>
      ))}
    </div>
  );
}

/** 找到 t <= tick 的最近采样里某物种的个体数；找不到更早采样时返回 null */
function speciesCountAround(
  metrics: MetricSample[],
  speciesId: number,
  tick: number,
): number | null {
  for (let i = metrics.length - 1; i >= 0; i--) {
    if (metrics[i].t <= tick) {
      return metrics[i].speciesCounts.find((c) => c.id === speciesId)?.count ?? 0;
    }
  }
  return null;
}

/** 抽稀到最多 maxPoints 个点（保留首尾） */
function downsample(values: number[], maxPoints: number): number[] {
  if (values.length <= maxPoints) return values;
  const out: number[] = [];
  const step = (values.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) out.push(values[Math.round(i * step)]);
  return out;
}

/** 归一化历史为 polyline 的 points 字符串（viewBox 0 0 100 22，上下各留 2px） */
function sparkPoints(values: number[]): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  return values
    .map((v, i) => {
      const x = values.length === 1 ? 0 : (i / (values.length - 1)) * 100;
      const y = range === 0 ? 11 : 20 - ((v - min) / range) * 18;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

// ---------------------------------------------------------------------------
// 物种下钻（传记视图）
// ---------------------------------------------------------------------------

/** 死因 → 颜色（与 WorldPulse 死因构成保持一致） */
const CAUSE_COLORS: Record<keyof DeathCauses, string> = {
  starve: '#f87171',
  predation: '#fbbf24',
  age: '#7d8899',
  hazard: '#a78bfa',
  plague: '#fb7185',
};

/** 死因构成：水平堆叠条 + 图例行 */
function CauseBar({ causes, total }: { causes: DeathCauses; total: number }) {
  const keys = DEATH_CAUSE_KEYS.filter((k) => causes[k] > 0);
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-lab-border/60">
        {keys.map((k) => (
          <div
            key={k}
            title={`${DEATH_CAUSE_LABELS[k]} ${causes[k].toLocaleString()}`}
            style={{
              width: `${((causes[k] / total) * 100).toFixed(2)}%`,
              backgroundColor: CAUSE_COLORS[k],
            }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
        {keys.map((k) => (
          <span key={k} className="flex items-center gap-1 text-[11px] leading-4 text-lab-muted">
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: CAUSE_COLORS[k] }}
            />
            {DEATH_CAUSE_LABELS[k]} {Math.round((causes[k] / total) * 100)}%
            <span className="font-mono text-lab-muted/70">{causes[k].toLocaleString()}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** 物种下钻的聚合结果（对 metrics 单次遍历得出） */
interface DrillStats {
  /** 完整数量史 [tick, count]（灭绝后补 0） */
  series: Array<[number, number]>;
  /** 历史峰值个体数 */
  peak: number;
  /** 全史死因聚合；无任何 speciesDeaths 数据（旧记录）为 null */
  causes: DeathCauses | null;
  /** 它捕食的物种 → 捕杀数（killTop 为累计值，取各对历史最大即最新，稳定不回退） */
  prey: Array<{ id: number; count: number }>;
  /** 捕食它的物种 → 捕杀数（同上） */
  predators: Array<{ id: number; count: number }>;
}

function collectDrillStats(metrics: MetricSample[], id: number): DrillStats {
  const series: Array<[number, number]> = [];
  let peak = 0;
  let causes: DeathCauses | null = null;
  const prey = new Map<number, number>();
  const predators = new Map<number, number>();
  for (const m of metrics) {
    // 数量史：speciesCounts 只含存续物种，灭绝后的采样默认为 0
    let count = 0;
    for (const c of m.speciesCounts) {
      if (c.id === id) {
        count = c.count;
        break;
      }
    }
    if (count > peak) peak = count;
    series.push([m.t, count]);

    const sd = m.speciesDeaths;
    if (sd !== undefined) {
      for (const d of sd) {
        if (d.id !== id) continue;
        if (causes === null) causes = { starve: 0, predation: 0, age: 0, hazard: 0, plague: 0 };
        for (const k of DEATH_CAUSE_KEYS) causes[k] += d[k] ?? 0;
      }
    }

    const kt = m.killTop;
    if (kt !== undefined) {
      for (const p of kt) {
        if (p.killer === id) {
          if (p.count > (prey.get(p.victim) ?? 0)) prey.set(p.victim, p.count);
        } else if (p.victim === id) {
          if (p.count > (predators.get(p.killer) ?? 0)) predators.set(p.killer, p.count);
        }
      }
    }
  }
  const rank = (map: Map<number, number>): Array<{ id: number; count: number }> =>
    [...map.entries()]
      .map(([sid, count]) => ({ id: sid, count }))
      .sort((a, b) => b.count - a.count);
  return { series, peak, causes, prey: rank(prey), predators: rank(predators) };
}

/** 物种下钻：单支物种的传记（头部 / 状态 / 数量史 / 死因 / 猎物与天敌 / 相关事件） */
function SpeciesDrill({
  record,
  id,
  onBack,
}: {
  record: ExperimentRecord;
  id: number;
  onBack: () => void;
}) {
  const meta = record.species[id];
  const name = meta?.name ?? `未知物种 #${id}`;
  const color = meta?.color ?? '#7d8899';
  const parentId = meta?.parentId;
  const tags = meta?.tags;
  const niche = meta?.niche;
  const latin = meta?.latin;
  const extinctFlag = meta?.extinct ?? false;

  // 单次遍历聚合全部指标（每次渲染重算一次，≤8000 采样无压力）
  const stats = collectDrillStats(record.metrics, id);
  const lastPoint = stats.series[stats.series.length - 1];
  const current = lastPoint !== undefined ? lastPoint[1] : 0;

  // 灭绝 tick：从事件流倒序找该物种最近一条 extinction 事件
  let extinctAt: number | null = null;
  for (let i = record.events.length - 1; i >= 0; i--) {
    const e = record.events[i];
    if (e.kind === 'extinction' && e.speciesId === id) {
      extinctAt = e.t;
      break;
    }
  }

  const causes = stats.causes;
  const causeTotal = causes !== null ? DEATH_CAUSE_KEYS.reduce((s, k) => s + causes[k], 0) : 0;

  const relatedEvents = record.events.filter((e) => e.speciesId === id).slice(-8).reverse();

  const chartOption: EChartsCoreOption = {
    ...CHART_BASE,
    series: [
      {
        name,
        type: 'line',
        showSymbol: false,
        lineStyle: { width: 1.6, color },
        itemStyle: { color },
        areaStyle: { opacity: 0.12, color },
        data: stats.series,
      },
    ],
  };

  const relationRow = (rel: { id: number; count: number }) => {
    const m = record.species[rel.id];
    return (
      <span key={rel.id} className="flex items-center gap-1">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: m?.color ?? '#7d8899' }}
        />
        <span className="text-lab-text">{m?.name ?? `未知物种 #${rel.id}`}</span>
        <span className="font-mono text-lab-muted">×{rel.count.toLocaleString()}</span>
      </span>
    );
  };

  return (
    <div className="flex flex-col gap-2 p-3">
      <button
        type="button"
        onClick={onBack}
        className="self-start rounded border border-lab-border px-2 py-1 text-xs text-lab-muted transition-colors hover:text-lab-text"
      >
        ← 返回物种列表
      </button>

      {/* 传记头部 + 状态行 */}
      <div className="rounded-lg border border-lab-border bg-[#0d121b] p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="h-3.5 w-3.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
          <span className="text-lg font-semibold leading-6 text-lab-text">{name}</span>
          {latin && <span className="text-xs italic text-lab-muted/80">{latin}</span>}
          {parentId === null ? (
            <span className="rounded bg-lab-border px-1.5 py-px text-[10px] text-lab-muted">
              初始
            </span>
          ) : parentId !== undefined && parentId !== null ? (
            <span className="rounded bg-lab-border px-1.5 py-px text-[10px] text-lab-muted">
              演化自 {record.species[parentId]?.name ?? `祖先 #${parentId}`}
            </span>
          ) : null}
          {(extinctFlag || extinctAt !== null) && (
            <span className="ml-auto rounded border border-[#f87171]/40 px-1.5 py-px text-[10px] text-[#f87171]">
              已灭绝
            </span>
          )}
        </div>
        {tags !== undefined && tags.length > 0 && (
          <div className="mt-1.5">
            <TagChips tags={tags} />
          </div>
        )}
        {niche && <p className="mt-1 text-xs leading-5 text-lab-muted">{niche}</p>}

        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-lab-border/60 pt-2 text-xs">
          <span className="text-lab-muted">
            当前个体 <span className="font-mono text-lab-text">{current.toLocaleString()}</span>
          </span>
          <span className="text-lab-muted">
            历史峰值 <span className="font-mono text-lab-text">{stats.peak.toLocaleString()}</span>
          </span>
          {extinctAt !== null && (
            <span className="text-lab-muted">
              灭绝于{' '}
              <span className="font-mono text-[#f87171]">tick {extinctAt.toLocaleString()}</span>
            </span>
          )}
        </div>
      </div>

      {/* 数量史 */}
      <div className="rounded-lg border border-lab-border bg-[#0d121b] p-2.5">
        <h4 className="text-xs text-lab-muted">数量史</h4>
        {stats.series.length >= 2 ? (
          <div className="mt-1">
            <Chart option={chartOption} height={150} />
          </div>
        ) : (
          <p className="mt-1.5 text-xs text-lab-muted">暂无采样数据。</p>
        )}
      </div>

      {/* 死因构成 */}
      <div className="rounded-lg border border-lab-border bg-[#0d121b] p-2.5">
        <h4 className="text-xs text-lab-muted">死因构成</h4>
        {causes === null || causeTotal <= 0 ? (
          <p className="mt-1.5 text-xs text-lab-muted">暂无死亡记录</p>
        ) : (
          <div className="mt-2">
            <CauseBar causes={causes} total={causeTotal} />
          </div>
        )}
      </div>

      {/* 猎物与天敌 */}
      <div className="rounded-lg border border-lab-border bg-[#0d121b] p-2.5">
        <h4 className="text-xs text-lab-muted">猎物与天敌</h4>
        <div className="mt-1.5 space-y-1.5 text-xs leading-5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="shrink-0 text-lab-muted">它捕食：</span>
            {stats.prey.length === 0 ? (
              <span className="text-lab-muted">暂无</span>
            ) : (
              stats.prey.map(relationRow)
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="shrink-0 text-lab-muted">捕食它的：</span>
            {stats.predators.length === 0 ? (
              <span className="text-lab-muted">暂无</span>
            ) : (
              stats.predators.map(relationRow)
            )}
          </div>
        </div>
      </div>

      {/* 相关事件 */}
      <div className="rounded-lg border border-lab-border bg-[#0d121b] p-2.5">
        <h4 className="text-xs text-lab-muted">相关事件</h4>
        {relatedEvents.length === 0 ? (
          <p className="mt-1.5 text-xs text-lab-muted">暂无</p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {relatedEvents.map((e, i) => (
              <li key={`${e.t}-${i}`} className="flex items-start gap-2 text-xs leading-5">
                <span
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: EVENT_COLOR[e.kind] }}
                />
                <span className="w-12 shrink-0 font-mono text-[10px] leading-5 text-lab-muted">
                  {e.t.toLocaleString()}
                </span>
                <span className="min-w-0 text-lab-text">{e.msg}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 物种面板
// ---------------------------------------------------------------------------

/** 卡片点击 = 高亮切换；右上「ⓘ 详情」进入单物种传记下钻视图 */

export function SpeciesPanel({
  expId,
  highlightId = null,
  onHighlight,
}: {
  expId: string;
  highlightId?: number | null;
  onHighlight?: (id: number | null) => void;
}) {
  const [tickTock, setTickTock] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTickTock((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // 下钻状态：进入某物种的传记视图；切换实验（expId 变化）时重置回列表
  const [drillId, setDrillId] = useState<number | null>(null);
  useEffect(() => {
    setDrillId(null);
  }, [expId]);

  const record = useExperiments.getState().records[expId];
  void tickTock;
  if (!record) return null;

  // 下钻视图替换整个列表；高亮状态不受影响（返回列表后保持原样）
  if (drillId !== null) {
    return <SpeciesDrill record={record} id={drillId} onBack={() => setDrillId(null)} />;
  }

  const metrics = record.metrics;
  const latest = metrics[metrics.length - 1];
  const counts = new Map(latest?.speciesCounts.map((c) => [c.id, c.count]) ?? []);
  const countSum = latest?.speciesCounts.reduce((s, c) => s + c.count, 0) ?? 0;
  const total = latest ? latest.pop || countSum || 1 : 1;

  const entries = Object.entries(record.species)
    .map(([id, meta]) => ({ id: Number(id), ...meta, count: counts.get(Number(id)) ?? 0 }))
    .sort((a, b) => {
      // 灭绝种沉底，其余按数量降序
      if (!!a.extinct !== !!b.extinct) return a.extinct ? 1 : -1;
      return b.count - a.count;
    });

  return (
    <div className="flex flex-col gap-2 p-3">
      {entries.length === 0 && <p className="text-xs text-lab-muted">尚无物种数据</p>}
      {entries.map((e) => {
        const selected = e.id === highlightId;
        const pct = Math.round((e.count / total) * 100);

        // 趋势箭头：与 ~1000 tick 前最近一次采样比较
        const oldCount =
          latest !== undefined ? speciesCountAround(metrics, e.id, latest.t - 1000) : null;
        let arrow = '→';
        let arrowCls = 'text-lab-muted';
        if (oldCount !== null && e.count > oldCount) {
          arrow = '↑';
          arrowCls = 'text-lab-accent';
        } else if (oldCount !== null && e.count < oldCount) {
          arrow = '↘';
          arrowCls = 'text-[#f87171]';
        }

        // 迷你走势线：最近 ≤60 个采样点，抽稀后画 polyline
        const history = downsample(
          metrics.slice(-60).map((s) => s.speciesCounts.find((c) => c.id === e.id)?.count ?? 0),
          30,
        );
        const drawLine = history.length >= 2 && !(e.count === 0 && !e.extinct);

        return (
          <div
            key={e.id}
            className={`rounded-lg border bg-[#0d121b] p-2.5 transition-colors ${
              selected ? 'border-lab-accent' : 'border-lab-border'
            } ${e.extinct ? 'opacity-60' : ''}`}
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onHighlight?.(selected ? null : e.id)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                title="点击高亮该物种"
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: e.color }}
                />
                <span className="min-w-0 truncate text-[15px] font-semibold text-lab-text">
                  {e.name}
                </span>
                {e.parentId === null ? (
                  <span className="shrink-0 rounded bg-lab-border px-1.5 py-px text-[10px] text-lab-muted">
                    初始
                  </span>
                ) : e.parentId !== undefined ? (
                  <span className="shrink-0 rounded bg-lab-border px-1.5 py-px text-[10px] text-lab-muted">
                    演化自 {record.species[e.parentId]?.name ?? `祖先 #${e.parentId}`}
                  </span>
                ) : null}
                {e.extinct && (
                  <span className="ml-auto shrink-0 rounded border border-[#f87171]/40 px-1.5 py-px text-[10px] text-[#f87171]">
                    已灭绝
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  setDrillId(e.id);
                }}
                className="shrink-0 rounded border border-lab-border px-1.5 py-px text-[10px] text-lab-muted transition-colors hover:border-lab-accent/60 hover:text-lab-text"
                title="查看物种详情"
              >
                ⓘ 详情
              </button>
            </div>
            {e.latin && e.parentId !== null && (
              <p className="mt-0.5 text-[11px] italic leading-4 text-lab-muted/80">{e.latin}</p>
            )}

            <div className="mt-1.5 flex items-center gap-2 text-xs">
              <span className="text-lab-muted">
                个体 <span className="font-mono text-lab-text">{e.count.toLocaleString()}</span>
              </span>
              <span className="text-lab-muted">
                占比 <span className="font-mono text-lab-text">{pct}%</span>
              </span>
              <span className={`ml-auto font-mono ${arrowCls}`}>{arrow}</span>
            </div>

            {drawLine && (
              <svg
                viewBox="0 0 100 22"
                preserveAspectRatio="none"
                className="mt-1.5 h-[22px] w-full"
                aria-hidden
              >
                <polyline
                  points={sparkPoints(history)}
                  fill="none"
                  stroke={e.color}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  opacity={0.9}
                />
              </svg>
            )}

            {e.tags && e.tags.length > 0 && (
              <div className="mt-1.5">
                <TagChips tags={e.tags} />
              </div>
            )}
            {e.niche && <p className="mt-1 text-xs leading-5 text-lab-muted">{e.niche}</p>}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 个体检查器
// ---------------------------------------------------------------------------

/** 行为意图 → chip 文案与配色 */
const INTENT_META: Array<{ label: string; cls: string }> = [
  { label: '游荡', cls: 'bg-lab-border text-lab-muted' },
  { label: '逃逸！', cls: 'bg-[#f87171]/15 text-[#f87171]' },
  { label: '追捕！', cls: 'bg-[#fbbf24]/15 text-[#fbbf24]' },
  { label: '觅食', cls: 'bg-[#34d399]/15 text-[#34d399]' },
  { label: '归群', cls: 'bg-[#38bdf8]/15 text-[#38bdf8]' },
];

export function AgentInspector({
  agent,
  speciesName,
  speciesTags,
  speciesNiche,
  intent,
  follow,
  onToggleFollow,
}: {
  agent: Agent | null;
  speciesName?: string;
  speciesTags?: string[];
  speciesNiche?: string;
  intent?: number;
  follow: boolean;
  onToggleFollow: () => void;
}) {
  if (!agent) {
    return (
      <p className="p-3 text-xs text-lab-muted">
        在画面中点击一个个体，查看它的基因组、能量与状态。
      </p>
    );
  }
  const maxE = maxEnergyOf(agent.genome.size);
  const intentMeta = intent !== undefined ? INTENT_META[intent] : undefined;
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm">
          #{agent.id} · {speciesName ?? '未知物种'}
        </span>
        {intentMeta !== undefined && (
          <span className={`rounded-full px-2 py-0.5 text-[10px] ${intentMeta.cls}`}>
            {intentMeta.label}
          </span>
        )}
        <button
          onClick={onToggleFollow}
          className={`ml-auto rounded px-2 py-1 text-xs transition-colors ${
            follow ? 'bg-lab-accent/20 text-lab-accent' : 'bg-lab-border text-lab-muted hover:text-lab-text'
          }`}
        >
          {follow ? '取消跟随' : '跟随镜头'}
        </button>
      </div>

      {(speciesTags !== undefined || speciesNiche !== undefined) && (
        <div className="flex flex-col gap-1.5">
          {speciesTags !== undefined && speciesTags.length > 0 && (
            <TagChips tags={speciesTags} />
          )}
          {speciesNiche !== undefined && (
            <p className="text-xs leading-5 text-lab-muted">{speciesNiche}</p>
          )}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="能量" value={`${agent.energy.toFixed(0)}/${maxE.toFixed(0)}`} />
        <Stat label="年龄" value={agent.age.toLocaleString()} />
        <Stat label="位置" value={`${agent.x.toFixed(0)},${agent.y.toFixed(0)}`} />
      </div>

      <div>
        <div className="mb-1 flex justify-between text-xs text-lab-muted">
          <span>能量状态</span>
          <span>{Math.round((agent.energy / maxE) * 100)}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-lab-border">
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${Math.min(100, Math.max(0, (agent.energy / maxE) * 100))}%`,
              backgroundColor: agent.energy / maxE < 0.25 ? '#f87171' : '#34d399',
            }}
          />
        </div>
      </div>

      <div>
        <h4 className="mb-1.5 text-xs text-lab-muted">基因组</h4>
        <GenomeBars genome={agent.genome} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-lab-border bg-[#0d121b] px-1 py-2">
      <div className="text-xs text-lab-muted">{label}</div>
      <div className="font-mono text-sm">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 事件流
// ---------------------------------------------------------------------------

const EVENT_COLOR: Record<SimEvent['kind'], string> = {
  speciation: '#a78bfa',
  extinction: '#f87171',
  rule: '#38bdf8',
  milestone: '#fbbf24',
  system: '#7d8899',
};

export function EventFeed({ expId }: { expId: string }) {
  const [tickTock, setTickTock] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTickTock((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const events = useExperiments.getState().records[expId]?.events ?? [];
  void tickTock;

  if (events.length === 0) {
    return (
      <p className="p-3 text-xs text-lab-muted">
        还没有事件。物种分化、灭绝、世界大事（繁荣/饥荒/纪录）和规则修改都会记录在这里。
      </p>
    );
  }
  return (
    <div className="flex flex-col-reverse gap-1.5 overflow-y-auto p-3">
      {events.map((e, i) => (
        <div key={`${e.t}-${i}`} className="flex gap-2 text-xs leading-5">
          <span className="w-16 shrink-0 text-right font-mono text-lab-muted">
            {e.t.toLocaleString()}
          </span>
          <span
            className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: EVENT_COLOR[e.kind] }}
          />
          <span className="text-lab-text">{e.msg}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 规则热修改面板
// ---------------------------------------------------------------------------

export interface RulesPatch {
  mutationRate: number;
  foodRegrow: number;
  maxPopulation: number;
  sexualReproduction: boolean;
  disasters: { enabled: boolean; severity: number };
}

export function RulesPanel({
  current,
  onApply,
}: {
  current: RulesPatch;
  onApply: (patch: RulesPatch) => void;
}) {
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);

  const dirty =
    draft.mutationRate !== current.mutationRate ||
    draft.foodRegrow !== current.foodRegrow ||
    draft.maxPopulation !== current.maxPopulation ||
    draft.sexualReproduction !== current.sexualReproduction ||
    draft.disasters.enabled !== current.disasters.enabled ||
    draft.disasters.severity !== current.disasters.severity;

  return (
    <div className="flex flex-col gap-4 p-3">
      <p className="text-xs text-lab-muted">
        修改立即生效并记入事件流——这是「干预实验」的核心手段。
      </p>
      <Slider
        label="突变率"
        value={draft.mutationRate}
        min={0}
        max={0.6}
        step={0.01}
        display={`${(draft.mutationRate * 100).toFixed(0)}%`}
        onChange={(v) => setDraft((d) => ({ ...d, mutationRate: v }))}
      />
      <Slider
        label="食物再生"
        value={draft.foodRegrow}
        min={0}
        max={0.08}
        step={0.001}
        display={draft.foodRegrow.toFixed(3)}
        onChange={(v) => setDraft((d) => ({ ...d, foodRegrow: v }))}
      />
      <Slider
        label="种群上限"
        value={draft.maxPopulation}
        min={100}
        max={20000}
        step={100}
        display={draft.maxPopulation.toLocaleString()}
        onChange={(v) => setDraft((d) => ({ ...d, maxPopulation: Math.round(v) }))}
      />

      {/* 繁殖方式 */}
      <div className="rounded-lg border border-lab-border bg-[#0d121b] p-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs text-lab-muted">繁殖方式</span>
          <span className="text-[10px] text-lab-muted/70">有性=求偶+基因交叉，多样性更快</span>
          <div className="ml-auto flex gap-1">
            {[false, true].map((v) => (
              <button
                key={String(v)}
                onClick={() => setDraft((d) => ({ ...d, sexualReproduction: v }))}
                className={`rounded-full px-2.5 py-0.5 text-[10px] transition-colors ${
                  draft.sexualReproduction === v
                    ? 'bg-lab-accent/15 text-lab-accent'
                    : 'bg-lab-border text-lab-muted'
                }`}
              >
                {v ? '有性' : '无性'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 灾变 */}
      <div className="rounded-lg border border-lab-border bg-[#0d121b] p-2.5">
        <div className="flex items-center gap-2">
          <span className="text-xs text-lab-muted">灾变事件</span>
          <span className="text-[10px] text-lab-muted/70">旱灾 / 瘟疫，随机打破稳态</span>
          <button
            onClick={() =>
              setDraft((d) => ({
                ...d,
                disasters: { ...d.disasters, enabled: !d.disasters.enabled },
              }))
            }
            className={`ml-auto rounded-full px-2.5 py-0.5 text-[10px] transition-colors ${
              draft.disasters.enabled
                ? 'bg-[#f87171]/15 text-[#f87171]'
                : 'bg-lab-border text-lab-muted'
            }`}
          >
            {draft.disasters.enabled ? '已开启' : '已关闭'}
          </button>
        </div>
        {draft.disasters.enabled && (
          <div className="mt-2">
            <Slider
              label="灾变强度"
              value={draft.disasters.severity}
              min={0.1}
              max={1}
              step={0.05}
              display={`${Math.round(draft.disasters.severity * 100)}%`}
              onChange={(v) => setDraft((d) => ({ ...d, disasters: { ...d.disasters, severity: v } }))}
            />
          </div>
        )}
      </div>

      <button
        disabled={!dirty}
        onClick={() => onApply(draft)}
        className={`rounded-lg py-2 text-sm transition-colors ${
          dirty
            ? 'bg-lab-accent text-lab-bg hover:bg-lab-accent-dim'
            : 'cursor-not-allowed bg-lab-border text-lab-muted'
        }`}
      >
        应用修改
      </button>
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="text-lab-muted">{label}</span>
        <span className="font-mono text-lab-text">{display}</span>
      </div>
      <input
        type="range"
        className="w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
