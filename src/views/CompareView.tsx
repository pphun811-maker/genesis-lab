import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { EChartsCoreOption, SeriesOption } from 'echarts';
import { GENE_RANGE, type GeneAverages } from '../engine/types';
import { useExperiments } from '../store/experiments';
import { CHART_BASE, Chart } from '../components/Chart';

const PALETTE = ['#34d399', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#f87171'];

const GENE_OPTIONS: Array<{ key: keyof GeneAverages; label: string }> = [
  { key: 'speed', label: '速度' },
  { key: 'sense', label: '感知' },
  { key: 'size', label: '体型' },
  { key: 'metabolism', label: '代谢' },
  { key: 'aggression', label: '攻击性' },
  { key: 'fear', label: '恐惧' },
  { key: 'sociability', label: '群聚性' },
];

export function CompareView() {
  const navigate = useNavigate();
  const records = useExperiments((s) => s.records);
  const all = Object.values(records).sort((a, b) => b.createdAt - a.createdAt);
  const [selected, setSelected] = useState<string[]>([]);
  const [gene, setGene] = useState<keyof GeneAverages>('aggression');

  useEffect(() => {
    // 默认选前两个
    if (selected.length === 0 && all.length >= 2) {
      setSelected(all.slice(0, 2).map((r) => r.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all.length]);

  const chosen = selected.map((id) => records[id]).filter(Boolean);

  const toggle = (id: string): void => {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(0, 6)));
  };

  const popOption = useMemo<EChartsCoreOption>(() => {
    const series: SeriesOption[] = chosen.map((r, i) => ({
      name: r.name,
      type: 'line',
      showSymbol: false,
      lineStyle: { width: 1.6, color: PALETTE[i % PALETTE.length] },
      itemStyle: { color: PALETTE[i % PALETTE.length] },
      data: r.metrics.map((m) => [m.t, m.pop]),
    }));
    return { ...CHART_BASE, legend: { bottom: 0, textStyle: { color: '#7d8899', fontSize: 10 } }, series };
  }, [chosen]);

  const geneOption = useMemo<EChartsCoreOption>(() => {
    const span = GENE_RANGE[gene as keyof typeof GENE_RANGE];
    const norm = span ? (v: number) => (v - span[0]) / (span[1] - span[0]) : (v: number) => v;
    const series: SeriesOption[] = chosen.map((r, i) => ({
      name: r.name,
      type: 'line',
      showSymbol: false,
      lineStyle: { width: 1.6, color: PALETTE[i % PALETTE.length] },
      itemStyle: { color: PALETTE[i % PALETTE.length] },
      data: r.metrics.map((m) => [m.t, Number(norm(m.genes[gene]).toFixed(4))]),
    }));
    return {
      ...CHART_BASE,
      legend: { bottom: 0, textStyle: { color: '#7d8899', fontSize: 10 } },
      yAxis: { ...CHART_BASE.yAxis, max: gene === 'speed' || gene === 'sense' ? undefined : 1 },
      series,
    };
  }, [chosen, gene]);

  const speciesOption = useMemo<EChartsCoreOption>(() => {
    const series: SeriesOption[] = chosen.map((r, i) => ({
      name: r.name,
      type: 'line',
      showSymbol: false,
      step: 'end',
      lineStyle: { width: 1.4, color: PALETTE[i % PALETTE.length] },
      itemStyle: { color: PALETTE[i % PALETTE.length] },
      data: r.metrics.map((m) => [m.t, m.species]),
    }));
    return { ...CHART_BASE, legend: { bottom: 0, textStyle: { color: '#7d8899', fontSize: 10 } }, series };
  }, [chosen]);

  return (
    <div className="mx-auto max-w-5xl p-8">
      <button onClick={() => navigate('/')} className="mb-6 text-lab-muted hover:text-lab-text">
        ← 返回
      </button>
      <h1 className="mb-1 text-xl font-semibold">⚖ 实验对比</h1>
      <p className="mb-6 text-sm text-lab-muted">
        勾选 2~6 个实验，叠加它们的命运曲线。分叉实验会显示与母体共享的历史。
      </p>

      {all.length === 0 ? (
        <div className="mt-20 text-center text-lab-muted">
          <p className="text-sm">还没有实验可对比。</p>
          <Link to="/create" className="mt-3 inline-block text-lab-accent hover:underline">
            去创建一个世界 →
          </Link>
        </div>
      ) : (
        <>
          {/* 选择器 */}
          <div className="mb-6 flex flex-wrap gap-2">
            {all.map((r) => (
              <button
                key={r.id}
                onClick={() => toggle(r.id)}
                className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                  selected.includes(r.id)
                    ? 'border-lab-accent bg-lab-accent/10 text-lab-text'
                    : 'border-lab-border text-lab-muted hover:text-lab-text'
                }`}
              >
                {selected.includes(r.id) ? '☑' : '☐'} {r.name}
                <span className="ml-1 opacity-60">t={r.lastTick.toLocaleString()}</span>
              </button>
            ))}
          </div>

          {chosen.length >= 2 ? (
            <>
              <section className="mb-4 rounded-xl border border-lab-border bg-lab-panel p-4">
                <h2 className="mb-2 text-sm font-medium">种群曲线</h2>
                <Chart option={popOption} height={260} />
              </section>

              <section className="mb-4 rounded-xl border border-lab-border bg-lab-panel p-4">
                <div className="mb-2 flex items-center gap-3">
                  <h2 className="text-sm font-medium">基因演化</h2>
                  <select
                    value={gene}
                    onChange={(e) => setGene(e.target.value as keyof GeneAverages)}
                    className="ml-auto rounded border border-lab-border bg-[#0d121b] px-2 py-1 text-xs outline-none"
                  >
                    {GENE_OPTIONS.map((g) => (
                      <option key={g.key} value={g.key}>
                        {g.label}
                      </option>
                    ))}
                  </select>
                </div>
                <Chart option={geneOption} height={240} />
              </section>

              <section className="mb-4 rounded-xl border border-lab-border bg-lab-panel p-4">
                <h2 className="mb-2 text-sm font-medium">物种数量</h2>
                <Chart option={speciesOption} height={200} />
              </section>

              {/* 汇总表 */}
              <section className="rounded-xl border border-lab-border bg-lab-panel p-4">
                <h2 className="mb-3 text-sm font-medium">关键数字</h2>
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-lab-muted">
                      <th className="pb-2">实验</th>
                      <th className="pb-2 text-right">当前 tick</th>
                      <th className="pb-2 text-right">个体</th>
                      <th className="pb-2 text-right">物种</th>
                      <th className="pb-2 text-right">出生累计</th>
                      <th className="pb-2 text-right">死亡累计</th>
                      <th className="pb-2 text-right">捕杀累计</th>
                      <th className="pb-2">来源</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {chosen.map((r, i) => {
                      const births = r.metrics.reduce((s, m) => s + m.births, 0);
                      const deaths = r.metrics.reduce((s, m) => s + m.deaths, 0);
                      const kills = r.metrics.reduce((s, m) => s + m.kills, 0);
                      const last = r.metrics[r.metrics.length - 1];
                      return (
                        <tr key={r.id} className="border-t border-lab-border">
                          <td className="py-2">
                            <span
                              className="mr-1.5 inline-block h-2 w-2 rounded-full"
                              style={{ backgroundColor: PALETTE[i % PALETTE.length] }}
                            />
                            <span className="font-sans">{r.name}</span>
                          </td>
                          <td className="py-2 text-right">{r.lastTick.toLocaleString()}</td>
                          <td className="py-2 text-right">{last?.pop.toLocaleString() ?? '—'}</td>
                          <td className="py-2 text-right">{last?.species ?? '—'}</td>
                          <td className="py-2 text-right">{births.toLocaleString()}</td>
                          <td className="py-2 text-right">{deaths.toLocaleString()}</td>
                          <td className="py-2 text-right">{kills.toLocaleString()}</td>
                          <td className="py-2 font-sans text-lab-muted">
                            {r.parentId && records[r.parentId]
                              ? `↳ ${records[r.parentId].name} @${r.forkedAtTick ?? 0}`
                              : '独立实验'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
            </>
          ) : (
            <p className="text-sm text-lab-muted">至少选择两个实验。</p>
          )}
        </>
      )}
    </div>
  );
}
