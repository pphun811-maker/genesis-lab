import { useEffect, useState, type ReactNode } from 'react';
import {
  DEATH_CAUSE_KEYS,
  DEATH_CAUSE_LABELS,
  GENE_RANGE,
  type DeathCauses,
  type GeneAverages,
  type MetricSample,
  type SimEvent,
} from '../engine/types';
import { useExperiments } from '../store/experiments';

// ---------------------------------------------------------------------------
// 世界报告：多节详细报告
//   ① 总览（2×3 指标格） ② 种群与资源（含死因构成） ③ 势力格局（物种条形榜）
//   ④ 食物网（捕杀 Top 对） ⑤ 基因演化 ⑥ 物种兴衰（近 3000 tick） ⑦ 大事记
// 纯派生计算，不写 store、不引图表库；1 秒定时器驱动重算。
// ---------------------------------------------------------------------------

const GOOD = '#34d399';
const DANGER = '#f87171';
const WARN = '#fbbf24';
const MUTED = '#7d8899';

/** 趋势比较窗口（tick） */
const TREND_WINDOW = 2000;
/** 物种兴衰统计窗口（tick） */
const HISTORY_WINDOW = 3000;
/** 势力榜最多展示的物种数 */
const TOP_N = 5;
/** 大事记条数 */
const CHRONICLE_N = 6;
/** 种群趋势判定阈值（尾段均值相对前段均值的变化） */
const POP_TREND_THRESHOLD = 0.15;
/** 食物趋势阈值（%） */
const FOOD_TREND_THRESHOLD = 8;
/** 基因行箭头阈值 / 总结句阈值（归一化变化，%） */
const GENE_ARROW_THRESHOLD = 2;
const GENE_SUMMARY_THRESHOLD = 8;

/** 事件种类 → 圆点颜色（与事件流保持一致） */
const KIND_COLOR: Record<SimEvent['kind'], string> = {
  speciation: '#a78bfa',
  extinction: '#f87171',
  rule: '#38bdf8',
  milestone: '#fbbf24',
  system: MUTED,
  miracle: '#e879f9',
};

/** 大事记收录的事件种类 */
const CHRONICLE_KINDS: ReadonlySet<SimEvent['kind']> = new Set([
  'speciation',
  'extinction',
  'milestone',
  'rule',
]);

/** 基因均值键（按报告展示顺序） */
const GENE_KEYS: Array<keyof GeneAverages> = [
  'speed',
  'sense',
  'size',
  'metabolism',
  'aggression',
  'fear',
  'sociability',
  'reproThreshold',
];

const GENE_LABEL: Record<keyof GeneAverages, string> = {
  speed: '速度',
  sense: '感知',
  size: '体型',
  metabolism: '代谢',
  aggression: '攻击性',
  fear: '恐惧',
  sociability: '群聚性',
  reproThreshold: '繁殖阈值',
};

/** 基因演化的总结文案（按方向区分），取归一化变化最大者 */
const GENE_SUMMARY: Record<keyof GeneAverages, { up: string; down: string }> = {
  speed: { up: '军备竞赛加速，生灵越跑越快', down: '军备竞赛降温，世界慢了下来' },
  sense: { up: '感知越来越敏锐，视野即生存', down: '感官日渐迟钝' },
  size: { up: '巨兽化进行中', down: '体型愈发纤巧' },
  metabolism: { up: '代谢之火烧得更旺，世界节奏加快', down: '代谢放缓，节能度日' },
  aggression: { up: '世界正变得更危险', down: '獠牙正在收起' },
  fear: { up: '草木皆兵，恐惧蔓延', down: '恐惧消退，胆大包天' },
  sociability: { up: '聚落成形，群居本能增强', down: '独行者渐多，聚落松散' },
  reproThreshold: { up: '繁殖门槛抬高，生养更谨慎', down: '生养变得更急切' },
};

/** 死因 → 颜色（死因构成条与图例共用，与物种下钻保持一致） */
const CAUSE_COLORS: Record<keyof DeathCauses, string> = {
  starve: '#f87171',
  predation: '#fbbf24',
  age: '#7d8899',
  hazard: '#a78bfa',
  plague: '#fb7185',
};
/** 死因构成聚合的采样数窗口 */
const CAUSE_WINDOW = 30;

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 找到 t <= tick 的最近一个采样（从尾部向前找） */
function sampleAtOrBefore(metrics: MetricSample[], tick: number): MetricSample | null {
  for (let i = metrics.length - 1; i >= 0; i--) {
    if (metrics[i].t <= tick) return metrics[i];
  }
  return null;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** #rrggbb → 追加 alpha 的八位 hex；非法颜色原样返回 */
function withAlpha(hex: string, alpha: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}${alpha}` : hex;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString();
}

function fmtPct(n: number): string {
  return `${Math.round(n).toLocaleString()}%`;
}

function fmtSignedPct(n: number): string {
  const r = Math.round(n);
  if (r === 0) return '0%';
  return `${r > 0 ? '+' : '-'}${Math.abs(r).toLocaleString()}%`;
}

function fmtRate(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function meanPop(samples: MetricSample[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((s, m) => s + m.pop, 0) / samples.length;
}

function aliveCountOf(s: MetricSample): number {
  return s.speciesCounts.reduce((n, c) => (c.count > 0 ? n + 1 : n), 0);
}

/** 窗口速率：base 之后所有采样的计数和 ÷ 覆盖 tick 数 × 1000 */
function windowRate(
  metrics: MetricSample[],
  base: MetricSample,
  key: 'births' | 'deaths' | 'kills',
): number {
  const latest = metrics[metrics.length - 1];
  if (!latest) return 0;
  let sum = 0;
  for (const m of metrics) {
    if (m.t > base.t && m.t <= latest.t) sum += m[key];
  }
  const span = latest.t - base.t;
  return span > 0 ? (sum / span) * 1000 : 0;
}

/** 从事件 msg 中提取「」内的物种名；查不到则回退到 物种 #id */
function speciesNameFromMsg(msg: string, speciesId: number | undefined): string {
  const m = msg.match(/「(.+?)」/);
  if (m?.[1]) return m[1];
  return speciesId !== undefined ? `物种 #${speciesId}` : '未知物种';
}

/** 聚合最近 ≤maxSamples 个采样的死因增量；窗口内无任何死因数据（旧记录）返回 null */
function aggregateCauses(metrics: MetricSample[], maxSamples: number): DeathCauses | null {
  let agg: DeathCauses | null = null;
  const start = Math.max(0, metrics.length - maxSamples);
  for (let i = start; i < metrics.length; i++) {
    const d = metrics[i].deathsByCause;
    if (!d) continue;
    if (agg === null) agg = { starve: 0, predation: 0, age: 0, hazard: 0, plague: 0 };
    for (const k of DEATH_CAUSE_KEYS) agg[k] += d[k] ?? 0;
  }
  return agg;
}

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------

function ReportHeader({ tick }: { tick: number }) {
  return (
    <div className="flex items-baseline">
      <h3 className="text-sm font-medium text-lab-text">世界报告</h3>
      <span className="ml-auto font-mono text-xs text-lab-muted">
        第 {tick.toLocaleString()} tick
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-3 border-t border-lab-border pt-3">
      <h4 className="text-xs tracking-[0.2em] text-lab-muted">{title}</h4>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function StatCell({
  label,
  value,
  sub,
  danger,
}: {
  label: string;
  value: string;
  sub?: string;
  danger?: boolean;
}) {
  return (
    <div className="rounded-md border border-lab-border bg-lab-bg/40 px-2 py-1.5">
      <div className="text-[10px] text-lab-muted">{label}</div>
      <div
        className={`font-mono text-sm leading-5 ${danger ? 'text-[#f87171]' : 'text-lab-text'}`}
      >
        {value}
      </div>
      {/* 占位保持六格等高 */}
      <div className="text-[10px] leading-4 text-lab-muted">{sub ?? '\u00A0'}</div>
    </div>
  );
}

/** 死因构成：水平堆叠条 + 图例行（「饿死 42%」式，附数量） */
function CauseBar({ causes, total }: { causes: DeathCauses; total: number }) {
  const keys = DEATH_CAUSE_KEYS.filter((k) => causes[k] > 0);
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-lab-border/60">
        {keys.map((k) => (
          <div
            key={k}
            title={`${DEATH_CAUSE_LABELS[k]} ${fmtInt(causes[k])}`}
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
            <span className="font-mono text-lab-muted/70">{fmtInt(causes[k])}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export function WorldPulse({ expId }: { expId: string }) {
  const [tickTock, setTickTock] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTickTock((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const record = useExperiments.getState().records[expId];
  void tickTock;
  if (!record) return null;

  const metrics = record.metrics;
  const latest = metrics[metrics.length - 1];

  // ---- 空态：尚无采样 ----
  if (!latest) {
    return (
      <div className="rounded-lg border border-lab-border bg-[#0d121b] p-3">
        <ReportHeader tick={record.lastTick} />
        <p className="mt-2 text-xs text-lab-muted">模拟启动后，世界报告会出现在这里。</p>
      </div>
    );
  }

  // ---- 基础派生数据 ----
  // ~2000 tick 前的比较基准（历史不足时退化为最早采样）
  const base = sampleAtOrBefore(metrics, latest.t - TREND_WINDOW) ?? metrics[0];
  const hasBase = base.t < latest.t;

  const alive = latest.speciesCounts.filter((c) => c.count > 0);
  const aliveNow = alive.length;
  const totalPop = latest.pop || alive.reduce((s, c) => s + c.count, 0);
  const peakPop = metrics.reduce((mx, m) => Math.max(mx, m.pop), 0);
  const peakSpecies = metrics.reduce((mx, m) => Math.max(mx, aliveCountOf(m)), 0);

  const foodCap =
    typeof latest.foodCap === 'number' && latest.foodCap > 0 ? latest.foodCap : null;
  const foodRatio = foodCap !== null ? latest.food / foodCap : null;

  const baseCounts = hasBase
    ? new Map(base.speciesCounts.map((c): [number, number] => [c.id, c.count]))
    : null;

  // ---- ① 总览：窗口速率 ----
  const birthRate = windowRate(metrics, base, 'births');
  const deathRate = windowRate(metrics, base, 'deaths');
  const killRate = windowRate(metrics, base, 'kills');

  // ---- ② 种群动态：尾段（最后 1/4）均值 vs 前段均值 ----
  let popPara: ReactNode;
  if (metrics.length >= 8) {
    const cut = Math.floor(metrics.length * 0.75);
    const tailMean = meanPop(metrics.slice(cut));
    const prevMean = meanPop(metrics.slice(0, cut));
    const change = prevMean > 0 ? (tailMean - prevMean) / prevMean : 0;
    const trend =
      change >= POP_TREND_THRESHOLD
        ? { word: '正在增长', color: GOOD }
        : change <= -POP_TREND_THRESHOLD
          ? { word: '正在下滑', color: DANGER }
          : { word: '总体平稳', color: undefined };

    let peakClause: string | null = null;
    if (peakPop > 0) {
      peakClause =
        latest.pop < peakPop
          ? `距历史峰值 ${fmtInt(peakPop)} 还差 ${fmtInt(peakPop - latest.pop)}（${fmtSignedPct(((latest.pop - peakPop) / peakPop) * 100)}）`
          : `正处于历史峰值 ${fmtInt(peakPop)}`;
    }

    popPara = (
      <p>
        <span style={trend.color ? { color: trend.color } : undefined}>种群{trend.word}</span>
        ，近期均值约 {fmtInt(tailMean)}（{fmtSignedPct(change * 100)}）
        {peakClause !== null && <>，{peakClause}</>}。
      </p>
    );
  } else {
    popPara = (
      <p className="text-lab-muted">种群样本尚少（{fmtInt(metrics.length)} 次采样），趋势待观察。</p>
    );
  }

  // ---- ② 食物：状态词 + 趋势（与 ~2000 tick 前比较）----
  let foodTrend = '食物储备平稳';
  let foodTrendColor: string | undefined;
  if (hasBase && base.food > 0) {
    const d = ((latest.food - base.food) / base.food) * 100;
    if (d <= -FOOD_TREND_THRESHOLD) {
      foodTrend = `食物储备正在流失（${fmtSignedPct(d)}）`;
      foodTrendColor = DANGER;
    } else if (d >= FOOD_TREND_THRESHOLD) {
      foodTrend = `食物储备正在回升（${fmtSignedPct(d)}）`;
      foodTrendColor = GOOD;
    }
  }

  let foodPara: ReactNode;
  if (foodRatio !== null) {
    const pct = foodRatio * 100;
    const status =
      pct >= 50
        ? { word: '丰饶', color: GOOD }
        : pct >= 30
          ? { word: '正常', color: undefined }
          : pct >= 15
            ? { word: '紧张', color: WARN }
            : { word: '饥荒', color: DANGER };
    foodPara = (
      <p>
        食物
        <span style={status.color ? { color: status.color } : undefined}>{status.word}</span>
        （占比 {fmtPct(pct)}），
        <span style={foodTrendColor ? { color: foodTrendColor } : undefined}>{foodTrend}</span>。
      </p>
    );
  } else {
    foodPara = (
      <p>
        食物储备约 {fmtInt(latest.food)}（容量未知），
        <span style={foodTrendColor ? { color: foodTrendColor } : undefined}>{foodTrend}</span>。
      </p>
    );
  }

  // ---- ② 死因构成：聚合最近 ≤30 次采样的死因增量（旧记录无数据 → 整块隐藏）----
  const windowCauses = aggregateCauses(metrics, CAUSE_WINDOW);
  const windowCauseTotal =
    windowCauses !== null ? DEATH_CAUSE_KEYS.reduce((s, k) => s + windowCauses[k], 0) : 0;

  // ---- ③ 势力格局：排名与权力更迭 ----
  const ranked = alive.slice().sort((a, b) => b.count - a.count);
  const shareTotal = ranked.reduce((s, c) => s + c.count, 0) || 1;
  const top5 = ranked.slice(0, TOP_N);
  const rest = ranked.slice(TOP_N);
  const restPop = rest.reduce((s, c) => s + c.count, 0);

  let powerShift: { from: string; to: string } | null = null;
  if (baseCounts !== null && ranked.length > 0) {
    let oldTop: { id: number; count: number } | null = null;
    for (const c of base.speciesCounts) {
      if (c.count > 0 && (oldTop === null || c.count > oldTop.count)) oldTop = c;
    }
    const curTop = ranked[0];
    if (oldTop !== null && curTop !== undefined && oldTop.id !== curTop.id) {
      powerShift = {
        from: record.species[oldTop.id]?.name ?? `物种 #${oldTop.id}`,
        to: record.species[curTop.id]?.name ?? `物种 #${curTop.id}`,
      };
    }
  }

  // ---- ④ 食物网：最新非空的累计捕杀 Top 对（旧记录无 killTop → 显示空态文案）----
  let killTop: Array<{ killer: number; victim: number; count: number }> = [];
  for (let i = metrics.length - 1; i >= 0; i--) {
    const kt = metrics[i].killTop;
    if (kt !== undefined && kt.length > 0) {
      killTop = kt;
      break;
    }
  }
  const killMaxCount = killTop.reduce((mx, p) => Math.max(mx, p.count), 0) || 1;

  // ---- ⑤ 基因演化：归一化进度与变化 ----
  const geneRows = GENE_KEYS.map((k) => {
    const range = GENE_RANGE[k];
    const span = range[1] - range[0] || 1;
    const norm = clamp01((latest.genes[k] - range[0]) / span);
    const deltaPct = hasBase ? ((latest.genes[k] - base.genes[k]) / span) * 100 : null;
    return { key: k, norm, deltaPct };
  });

  let geneHeadline: ReactNode = <span className="text-lab-muted">基因构成总体稳定。</span>;
  if (hasBase) {
    let bestKey: keyof GeneAverages | null = null;
    let bestDelta = 0;
    for (const row of geneRows) {
      if (row.deltaPct !== null && Math.abs(row.deltaPct) > Math.abs(bestDelta)) {
        bestDelta = row.deltaPct;
        bestKey = row.key;
      }
    }
    if (bestKey !== null && Math.abs(bestDelta) > GENE_SUMMARY_THRESHOLD) {
      const copy = GENE_SUMMARY[bestKey][bestDelta > 0 ? 'up' : 'down'];
      geneHeadline = (
        <>
          {copy}
          <span className="text-lab-muted">
            （{GENE_LABEL[bestKey]} {fmtSignedPct(bestDelta)}）。
          </span>
        </>
      );
    }
  }

  // ---- ⑥ 物种兴衰：近 3000 tick 的诞生 / 灭绝 ----
  const histStart = latest.t - HISTORY_WINDOW;
  const specEvents = record.events.filter((e) => e.kind === 'speciation' && e.t >= histStart);
  const extEvents = record.events.filter((e) => e.kind === 'extinction' && e.t >= histStart);

  const nameList = (evs: SimEvent[]): string => {
    const names = evs.slice(0, 4).map((e) => speciesNameFromMsg(e.msg, e.speciesId));
    return names.length > 0 ? `：${names.join('、')}${evs.length > 4 ? ' 等' : ''}` : '';
  };

  // ---- ⑦ 大事记：最近 N 条（新在上）----
  const chronicle = record.events
    .filter((e) => CHRONICLE_KINDS.has(e.kind))
    .slice(-CHRONICLE_N)
    .reverse();

  return (
    <div className="rounded-lg border border-lab-border bg-[#0d121b] p-3">
      <ReportHeader tick={latest.t} />

      {/* ① 总览 */}
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <StatCell label="当前种群" value={fmtInt(totalPop)} sub={`峰值 ${fmtInt(peakPop)}`} />
        <StatCell label="存续物种" value={fmtInt(aliveNow)} sub={`峰值 ${fmtInt(peakSpecies)}`} />
        <StatCell
          label="食物占比"
          value={foodRatio !== null ? fmtPct(foodRatio * 100) : '--'}
          danger={foodRatio !== null && foodRatio < 0.15}
          sub={foodCap !== null ? `储备 ${fmtInt(latest.food)}` : undefined}
        />
        <StatCell label="出生速率" value={fmtRate(birthRate)} sub="/千tick" />
        <StatCell label="死亡速率" value={fmtRate(deathRate)} sub="/千tick" />
        <StatCell label="捕杀速率" value={fmtRate(killRate)} sub="/千tick" />
      </div>

      {/* ② 种群与资源 */}
      <Section title="② 种群与资源">
        <div className="space-y-1.5 text-xs leading-5 text-lab-text">
          {popPara}
          {foodPara}
        </div>
        {windowCauses !== null && (
          <div className="mt-2.5 border-t border-lab-border/60 pt-2">
            <div className="flex items-baseline">
              <span className="text-[11px] text-lab-muted">死因构成</span>
              <span className="ml-auto font-mono text-[10px] text-lab-muted">
                共 {fmtInt(windowCauseTotal)} 例
              </span>
            </div>
            {windowCauseTotal < 5 ? (
              <p className="mt-1.5 text-xs text-lab-muted">近期死亡很少。</p>
            ) : (
              <div className="mt-1.5">
                <CauseBar causes={windowCauses} total={windowCauseTotal} />
              </div>
            )}
          </div>
        )}
      </Section>

      {/* ③ 势力格局 */}
      <Section title="③ 势力格局">
        {ranked.length === 0 ? (
          <p className="text-xs text-lab-muted">当前没有存续物种。</p>
        ) : (
          <>
            <div className="space-y-1.5">
              {top5.map((c) => {
                const meta = record.species[c.id];
                const name = meta?.name ?? `物种 #${c.id}`;
                const color = meta?.color ?? GOOD;
                const share = (c.count / shareTotal) * 100;
                const prev = baseCounts?.get(c.id);
                const trend =
                  prev === undefined || prev === c.count
                    ? { arrow: '→', color: MUTED }
                    : c.count > prev
                      ? { arrow: '↑', color: GOOD }
                      : { arrow: '↘', color: DANGER };
                return (
                  <div key={c.id} className="flex items-center gap-2 text-xs">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="w-20 shrink-0 truncate text-lab-text" title={name}>
                      {name}
                    </span>
                    <span className="w-10 shrink-0 text-right font-mono text-lab-muted">
                      {fmtInt(c.count)}
                    </span>
                    <div className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-lab-border/60">
                      <div
                        className="absolute inset-y-0 left-0 rounded-full"
                        style={{
                          width: `${Math.max(3, Math.min(100, share)).toFixed(1)}%`,
                          backgroundColor: withAlpha(color, '99'),
                        }}
                      />
                    </div>
                    <span className="w-9 shrink-0 text-right font-mono text-lab-muted">
                      {fmtPct(share)}
                    </span>
                    <span className="w-3 shrink-0 text-center" style={{ color: trend.color }}>
                      {trend.arrow}
                    </span>
                  </div>
                );
              })}
            </div>
            {rest.length > 0 && (
              <p className="mt-2 text-[11px] text-lab-muted">
                其余 {fmtInt(rest.length)} 种合计 {fmtInt(restPop)} 个体
              </p>
            )}
            {powerShift !== null && (
              <p className="mt-2 text-xs">
                权力更迭：<span style={{ color: DANGER }}>{powerShift.from}</span> 让位于{' '}
                <span style={{ color: GOOD }}>{powerShift.to}</span>。
              </p>
            )}
          </>
        )}
      </Section>

      {/* ④ 食物网 */}
      <Section title="④ 食物网">
        {killTop.length === 0 ? (
          <p className="text-xs text-lab-muted">尚未发生捕杀。</p>
        ) : (
          <div className="space-y-1.5">
            {killTop.map((pair) => {
              const killer = record.species[pair.killer];
              const victim = record.species[pair.victim];
              const killerName = killer?.name ?? `未知物种 #${pair.killer}`;
              const victimName = victim?.name ?? `未知物种 #${pair.victim}`;
              return (
                <div
                  key={`${pair.killer}-${pair.victim}`}
                  className="flex items-center gap-2 text-xs"
                  title={`${killerName} 捕食 ${victimName} ×${fmtInt(pair.count)}`}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: killer?.color ?? MUTED }}
                  />
                  <span className="w-16 shrink-0 truncate text-lab-text">{killerName}</span>
                  <span className="shrink-0 text-lab-muted">捕食</span>
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: victim?.color ?? MUTED }}
                  />
                  <span className="w-16 shrink-0 truncate text-lab-text">{victimName}</span>
                  <span className="shrink-0 text-right font-mono text-lab-muted">
                    ×{fmtInt(pair.count)}
                  </span>
                  <div className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-lab-border/60">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full"
                      style={{
                        width: `${Math.max(3, Math.min(100, (pair.count / killMaxCount) * 100)).toFixed(1)}%`,
                        backgroundColor: withAlpha(killer?.color ?? GOOD, '99'),
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* ⑤ 基因演化 */}
      <Section title="⑤ 基因演化">
        <div className="space-y-1">
          {geneRows.map((r) => {
            const stable = r.deltaPct === null || Math.abs(r.deltaPct) < GENE_ARROW_THRESHOLD;
            const arrow = stable
              ? { s: '→', color: MUTED }
              : r.deltaPct !== null && r.deltaPct > 0
                ? { s: '↑', color: GOOD }
                : { s: '↓', color: DANGER };
            return (
              <div
                key={r.key}
                className="grid grid-cols-[72px_1fr_76px] items-center gap-2 text-xs"
                title={`当前值 ${latest.genes[r.key].toFixed(2)}`}
              >
                <span className="text-lab-muted">{GENE_LABEL[r.key]}</span>
                <span className="relative block h-1 overflow-hidden rounded-full bg-lab-border">
                  <span
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{
                      width: `${Math.max(2, r.norm * 100).toFixed(1)}%`,
                      backgroundColor: GOOD,
                      opacity: 0.85,
                    }}
                  />
                </span>
                <span className="text-right font-mono" style={{ color: arrow.color }}>
                  {arrow.s}
                  {stable ? '' : ` ${fmtSignedPct(r.deltaPct ?? 0)}`}
                </span>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-xs leading-5 text-lab-text">{geneHeadline}</p>
      </Section>

      {/* ⑥ 物种兴衰 */}
      <Section title={`⑥ 物种兴衰（近 ${fmtInt(HISTORY_WINDOW)} tick）`}>
        <div className="space-y-1.5 text-xs leading-5 text-lab-text">
          {specEvents.length > 0 ? (
            <p>
              新物种诞生 <span style={{ color: GOOD }}>{fmtInt(specEvents.length)}</span> 种
              {nameList(specEvents)}。
            </p>
          ) : (
            <p className="text-lab-muted">期间无新物种诞生。</p>
          )}
          {extEvents.length > 0 ? (
            <p>
              物种灭绝 <span style={{ color: DANGER }}>{fmtInt(extEvents.length)}</span> 种
              {nameList(extEvents)}。
            </p>
          ) : (
            <p className="text-lab-muted">期间无物种灭绝。</p>
          )}
          <p className="text-lab-muted">
            当前存续 {fmtInt(aliveNow)} 种，历史最多 {fmtInt(peakSpecies)} 种。
          </p>
        </div>
      </Section>

      {/* ⑦ 大事记 */}
      <Section title="⑦ 大事记">
        {chronicle.length > 0 ? (
          <ul className="space-y-1.5">
            {chronicle.map((e, i) => (
              <li key={`${e.t}-${i}`} className="flex items-start gap-2 text-xs leading-5">
                <span
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: KIND_COLOR[e.kind] }}
                />
                <span className="w-12 shrink-0 font-mono text-[10px] leading-5 text-lab-muted">
                  {fmtInt(e.t)}
                </span>
                <span className="min-w-0 text-lab-text">{e.msg}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-lab-muted">暂无大事记。</p>
        )}
      </Section>
    </div>
  );
}
