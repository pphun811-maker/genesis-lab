import { useEffect, useMemo, useRef, useState } from 'react';
import type { EChartsCoreOption, SeriesOption } from 'echarts';
import { GENE_RANGE, type GeneAverages } from '../engine/types';
import { useExperiments } from '../store/experiments';
import { CHART_BASE, Chart, fmtK } from './Chart';

type DetailKey = 'pop' | 'gene' | 'food';

const DETAILS: Array<{ key: DetailKey; title: string }> = [
  { key: 'pop', title: '种群详情' },
  { key: 'gene', title: '基因演化' },
  { key: 'food', title: '食物能量' },
];

/** 详情折叠状态的本地持久化 key：默认全部展开，且跨页面切换/会话记忆 */
const CHARTS_OPEN_KEY = 'gl-charts-open-v1';

function loadChartsOpen(): Record<DetailKey, boolean> {
  const fallback: Record<DetailKey, boolean> = { pop: true, gene: true, food: true };
  try {
    const raw = localStorage.getItem(CHARTS_OPEN_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Record<DetailKey, unknown>>;
    return {
      pop: typeof parsed.pop === 'boolean' ? parsed.pop : true,
      gene: typeof parsed.gene === 'boolean' ? parsed.gene : true,
      food: typeof parsed.food === 'boolean' ? parsed.food : true,
    };
  } catch {
    return fallback;
  }
}

function saveChartsOpen(open: Record<DetailKey, boolean>): void {
  try {
    localStorage.setItem(CHARTS_OPEN_KEY, JSON.stringify(open));
  } catch {
    // localStorage 不可用时静默降级：仅本次会话内生效
  }
}

const GENE_LINES: Array<{ key: keyof GeneAverages; label: string; color: string }> = [
  { key: 'speed', label: '速度', color: '#38bdf8' },
  { key: 'sense', label: '感知', color: '#a78bfa' },
  { key: 'size', label: '体型', color: '#fbbf24' },
  { key: 'aggression', label: '攻击性', color: '#f87171' },
  { key: 'sociability', label: '群聚性', color: '#34d399' },
  { key: 'fear', label: '恐惧', color: '#94a3b8' },
];

/**
 * 实时指标面板：顶部常驻「总览」（种群 + 食物双轴），下方三个详情卡片
 * 默认折叠、点标题展开。数据每秒拉取一次，仅在真正变化时重绘。
 */
export function MetricCharts({ expId }: { expId: string }) {
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<Record<DetailKey, boolean>>(loadChartsOpen);
  const lastLenRef = useRef(-1);

  useEffect(() => {
    lastLenRef.current = -1;
    // 仅当指标序列真正增长时才重绘——暂停时图表完全静止，悬停读数不被打断
    const timer = setInterval(() => {
      const len = useExperiments.getState().records[expId]?.metrics.length ?? 0;
      if (len !== lastLenRef.current) {
        lastLenRef.current = len;
        setVersion((v) => v + 1);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [expId]);

  const toggle = (key: DetailKey): void =>
    setOpen((o) => {
      const next = { ...o, [key]: !o[key] };
      saveChartsOpen(next);
      return next;
    });

  // ---- 总览：种群（左轴）+ 食物（右轴）----
  const overviewOption = useMemo<EChartsCoreOption>(() => {
    const ms = useExperiments.getState().records[expId]?.metrics ?? [];
    return {
      ...CHART_BASE,
      series: [
        {
          name: '种群总数',
          type: 'line',
          showSymbol: false,
          lineStyle: { width: 2, color: '#e2e8f0' },
          itemStyle: { color: '#e2e8f0' },
          data: ms.map((s) => [s.t, s.pop]),
        },
        {
          name: '食物能量',
          type: 'line',
          yAxisIndex: 1,
          showSymbol: false,
          areaStyle: { opacity: 0.14 },
          lineStyle: { width: 1.4, color: '#4ade80' },
          itemStyle: { color: '#4ade80' },
          data: ms.map((s) => [s.t, Math.round(s.food)]),
        },
      ] satisfies SeriesOption[],
      yAxis: [
        { ...CHART_BASE.yAxis },
        {
          ...CHART_BASE.yAxis,
          splitLine: { show: false },
          axisLabel: { color: 'rgba(74, 222, 128, 0.75)', hideOverlap: true, formatter: fmtK },
        },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, expId]);

  const popOption = useMemo<EChartsCoreOption>(() => {
    const record = useExperiments.getState().records[expId];
    const ms = record?.metrics ?? [];
    const latest = ms[ms.length - 1];
    const topIds =
      latest?.speciesCounts
        .slice()
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .map((s) => s.id) ?? [];
    const active = Object.entries(record?.species ?? {});
    const series: SeriesOption[] = [
      {
        name: '总数',
        type: 'line',
        showSymbol: false,
        lineStyle: { width: 2.2, color: '#e2e8f0' },
        itemStyle: { color: '#e2e8f0' },
        data: ms.map((s) => [s.t, s.pop]),
      },
    ];
    for (const id of topIds) {
      const meta = active.find(([sid]) => Number(sid) === id)?.[1];
      series.push({
        name: meta?.name ?? `物种 ${id}`,
        type: 'line',
        showSymbol: false,
        lineStyle: { width: 1.2, color: meta?.color },
        itemStyle: { color: meta?.color },
        data: ms.map((s) => [s.t, s.speciesCounts.find((c) => c.id === id)?.count ?? 0]),
      });
    }
    return { ...CHART_BASE, series };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, expId]);

  const geneOption = useMemo<EChartsCoreOption>(() => {
    const ms = useExperiments.getState().records[expId]?.metrics ?? [];
    const span = (k: keyof GeneAverages) => GENE_RANGE[k][1] - GENE_RANGE[k][0];
    return {
      ...CHART_BASE,
      legend: {
        top: 0,
        type: 'scroll' as const,
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
        itemGap: 10,
        textStyle: { color: '#7d8899', fontSize: 10 },
      },
      grid: { ...CHART_BASE.grid, top: 34 },
      series: GENE_LINES.map((g) => ({
        name: g.label,
        type: 'line',
        showSymbol: false,
        lineStyle: { width: 1.3, color: g.color },
        itemStyle: { color: g.color },
        data: ms.map((s) => [s.t, Number(((s.genes[g.key] ?? 0) / span(g.key)).toFixed(4))]),
      })),
      yAxis: { ...CHART_BASE.yAxis, max: 1 },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, expId]);

  const foodOption = useMemo<EChartsCoreOption>(() => {
    const ms = useExperiments.getState().records[expId]?.metrics ?? [];
    return {
      ...CHART_BASE,
      series: [
        {
          name: '食物能量',
          type: 'line',
          showSymbol: false,
          areaStyle: { opacity: 0.18 },
          lineStyle: { width: 1.6, color: '#4ade80' },
          itemStyle: { color: '#4ade80' },
          data: ms.map((s) => [s.t, Math.round(s.food)]),
        },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, expId]);

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* 总览（常驻） */}
      <section className="rounded-xl border border-lab-border bg-lab-panel2 p-3">
        <div className="mb-2 flex items-center">
          <h3 className="text-xs font-medium text-lab-text">总览</h3>
          <div className="ml-auto flex items-center gap-2 text-[10px] text-lab-muted">
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-[#e2e8f0]" />
              种群
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-[#4ade80]" />
              食物
            </span>
          </div>
        </div>
        <Chart option={overviewOption} height={210} />
        <StatRow expId={expId} version={version} />
      </section>

      {/* 详情折叠卡片 */}
      {DETAILS.map((d) => (
        <section
          key={d.key}
          className="overflow-hidden rounded-xl border border-lab-border bg-lab-panel2"
        >
          <button
            onClick={() => toggle(d.key)}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[#121a26]"
          >
            <span
              className={`text-[10px] text-lab-muted transition-transform duration-150 ${
                open[d.key] ? 'rotate-90' : ''
              }`}
            >
              ▶
            </span>
            <span className="text-xs font-medium">{d.title}</span>
            <span className="ml-auto text-[10px] text-lab-muted">{open[d.key] ? '收起' : '展开'}</span>
          </button>
          {open[d.key] && (
            <div className="border-t border-lab-border p-3">
              {d.key === 'pop' && (
                <>
                  <Chart option={popOption} height={240} />
                  <div className="mt-2">
                    <SpeciesChips expId={expId} version={version} />
                  </div>
                </>
              )}
              {d.key === 'gene' && <Chart option={geneOption} height={240} />}
              {d.key === 'food' && <Chart option={foodOption} height={220} />}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

/** 关键数字：最近一个采样窗口（10 tick）的出生/死亡/捕杀 */
function StatRow({ expId, version }: { expId: string; version: number }) {
  const record = useExperiments.getState().records[expId];
  void version;
  const latest = record?.metrics[record.metrics.length - 1];
  return (
    <div className="mt-2 grid grid-cols-3 gap-2">
      <Stat label="出生" value={latest?.births ?? 0} color="#34d399" />
      <Stat label="死亡" value={latest?.deaths ?? 0} color="#f87171" />
      <Stat label="捕杀" value={latest?.kills ?? 0} color="#fbbf24" />
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border border-lab-border bg-lab-bg/60 px-2 py-1.5 text-center">
      <div className="text-[10px] text-lab-muted">
        {label} · 每采样
      </div>
      <div className="font-mono text-sm" style={{ color }}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

/** 种群详情的颜色说明：白色=总数，其后为数量前五的物种 */
function SpeciesChips({ expId, version }: { expId: string; version: number }) {
  const record = useExperiments.getState().records[expId];
  void version;
  const latest = record?.metrics[record.metrics.length - 1];
  const top = (latest?.speciesCounts ?? [])
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Chip color="#e2e8f0" label="总数" />
      {top.map((s) => {
        const meta = record?.species[s.id];
        return (
          <Chip
            key={s.id}
            color={meta?.color ?? '#888888'}
            label={meta?.name ?? `物种 ${s.id}`}
            count={s.count}
          />
        );
      })}
      {top.length === 0 && <span className="text-xs text-lab-muted">暂无物种数据</span>}
    </div>
  );
}

function Chip({ color, label, count }: { color: string; label: string; count?: number }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-lab-border bg-lab-bg/60 px-2 py-0.5 text-xs text-lab-muted">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="truncate">{label}</span>
      {count !== undefined && <span className="font-mono text-lab-text">{count}</span>}
    </span>
  );
}
