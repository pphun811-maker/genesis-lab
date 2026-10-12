import { GENE_RANGE, type Genome } from '../engine/types';

export const GENE_LABELS: Array<{ key: keyof Genome; label: string; fmt?: (v: number) => string }> = [
  { key: 'speed', label: '速度', fmt: (v) => v.toFixed(2) },
  { key: 'sense', label: '感知', fmt: (v) => v.toFixed(1) },
  { key: 'size', label: '体型', fmt: (v) => v.toFixed(2) },
  { key: 'metabolism', label: '代谢', fmt: (v) => v.toFixed(2) },
  { key: 'aggression', label: '攻击性', fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'fear', label: '恐惧', fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'sociability', label: '群聚性', fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'reproThreshold', label: '繁殖阈值', fmt: (v) => v.toFixed(0) },
  { key: 'hue', label: '色相', fmt: (v) => `${Math.round(v)}°` },
];

/** 基因组可视化：每个基因一根归一化进度条 */
export function GenomeBars({ genome }: { genome: Genome }) {
  return (
    <div className="flex flex-col gap-1.5">
      {GENE_LABELS.map(({ key, label, fmt }) => {
        const [min, max] = GENE_RANGE[key];
        const pct = Math.min(100, Math.max(0, ((genome[key] - min) / (max - min)) * 100));
        return (
          <div key={key} className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-xs text-lab-muted">{label}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-lab-border">
              <div
                className="h-full rounded-full bg-lab-accent"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="w-12 shrink-0 text-right font-mono text-xs text-lab-text">
              {fmt ? fmt(genome[key]) : genome[key].toFixed(2)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
