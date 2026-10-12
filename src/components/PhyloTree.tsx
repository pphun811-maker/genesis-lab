import { useEffect, useState } from 'react';
import { useExperiments } from '../store/experiments';
import type { SpeciesMeta } from '../store/types';

// ---------------------------------------------------------------------------
// 谱系树（系统发生树）：时间轴上的物种分化史
// x 轴 = tick（0..lastTick 线性映射），y 轴 = 物种行。
// 行分配：从初始种（parentId 为空）按 id 序 DFS，先父后子，子种排在父种之后，
// 天然形成分支展开；边为「父点 → 父行水平 → 圆角转弯 → 垂直落到子点」的肘形折线。
// ---------------------------------------------------------------------------

/** 时间轴映射宽度（px）；侧栏更宽/更窄时交给容器横向滚动 */
const PLOT_W = 340;
/** 时间轴左右留白 */
const PAD_X = 8;
/** 每个物种占一行的高度 */
const ROW_H = 24;
/** 顶部留白 */
const TOP_PAD = 12;
/** 最小高度 */
const MIN_H = 200;

/** 数字缩写：0 → "0"，12345 → "12.3k"，1234567 → "1.2M" */
function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) {
    const k = n / 1000;
    return `${(k >= 100 ? Math.round(k) : Number(k.toFixed(1))).toLocaleString()}k`;
  }
  return String(n);
}

/** 名字截断到 8 字（超长加省略号） */
function truncName(s: string): string {
  return s.length > 8 ? `${s.slice(0, 8)}…` : s;
}

/** 肘形折线：父点沿父行水平前进，圆角转弯后垂直落到子点 */
function elbowPath(px: number, py: number, cx: number, cy: number): string {
  if (cx - px < 1 || cy - py < 1) return `M ${px} ${py} L ${cx} ${cy}`;
  const r = Math.min(4, (cx - px) / 2, (cy - py) / 2);
  return `M ${px} ${py} H ${cx - r} Q ${cx} ${py} ${cx} ${py + r} V ${cy}`;
}

/** 树节点（字段容错解析后的视图模型） */
interface PhyloNode {
  id: number;
  name: string;
  color: string;
  latin?: string;
  foundedTick: number;
  isExtinct: boolean;
  extinctTick: number | null;
  /** 已解析：父种不在场或自指时视为初始种（null） */
  parentId: number | null;
  row: number;
  x: number;
  y: number;
}

export function PhyloTree({
  expId,
  highlightId,
  onHighlight,
}: {
  expId: string;
  highlightId: number | null;
  onHighlight: (id: number | null) => void;
}) {
  // 与 SpeciesPanel 相同的节流策略：每秒重读一次 store，避免运行中逐帧重渲整棵树
  const [, setTickTock] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTickTock((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const record = useExperiments.getState().records[expId];
  const rawEntries = record ? Object.entries(record.species) : [];

  if (!record || rawEntries.length === 0) {
    return (
      <div className="m-3 rounded-xl border border-lab-border bg-[#0d121b] p-4">
        <p className="text-xs text-lab-muted">尚无谱系数据</p>
      </div>
    );
  }

  // --- 解析节点：旧记录缺 foundedTick 按 0，缺 extinctTick 用 extinct 布尔近似 ---
  const entries: Array<{ id: number; meta: SpeciesMeta }> = [];
  for (const [key, meta] of rawEntries) {
    const idNum = Number(key);
    if (Number.isFinite(idNum)) entries.push({ id: idNum, meta });
  }

  const nodes = new Map<number, PhyloNode>();
  for (const { id, meta } of entries) {
    nodes.set(id, {
      id,
      name: meta.name || `物种 #${id}`,
      color: meta.color || '#7d8899',
      latin: meta.latin,
      foundedTick:
        typeof meta.foundedTick === 'number' && meta.foundedTick >= 0 ? meta.foundedTick : 0,
      isExtinct: meta.extinct === true || typeof meta.extinctTick === 'number',
      extinctTick: typeof meta.extinctTick === 'number' ? meta.extinctTick : null,
      parentId: null,
      row: 0,
      x: 0,
      y: 0,
    });
  }
  // 父链解析（第二遍，避免构建顺序影响）：父种不在场或自指 → 视为初始种
  for (const { id, meta } of entries) {
    const p = meta.parentId;
    const node = nodes.get(id);
    if (node && typeof p === 'number' && p !== id && nodes.has(p)) node.parentId = p;
  }

  // 子种按（诞生 tick, id）排序，保证分支按时间先后展开
  const childrenOf = new Map<number, number[]>();
  for (const n of nodes.values()) {
    if (n.parentId === null) continue;
    const list = childrenOf.get(n.parentId);
    if (list) list.push(n.id);
    else childrenOf.set(n.parentId, [n.id]);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => {
      const na = nodes.get(a);
      const nb = nodes.get(b);
      return (na?.foundedTick ?? 0) - (nb?.foundedTick ?? 0) || (na?.id ?? 0) - (nb?.id ?? 0);
    });
  }

  // 行分配：初始种按 id 序 DFS，先父后子，访问顺序即行号
  const order: PhyloNode[] = [];
  const visited = new Set<number>();
  const visit = (id: number): void => {
    const node = nodes.get(id);
    if (!node || visited.has(id)) return;
    visited.add(id);
    node.row = order.length;
    order.push(node);
    for (const child of childrenOf.get(id) ?? []) visit(child);
  };
  const roots = [...nodes.values()]
    .filter((n) => n.parentId === null)
    .sort((a, b) => a.id - b.id);
  for (const root of roots) visit(root.id);
  // 兜底：脏数据成环等漏网节点按 id 补在末尾
  for (const n of [...nodes.values()].sort((a, b) => a.id - b.id)) visit(n.id);

  // 坐标：时间线性映射到绘图宽，行从上往下
  let maxT = record.lastTick;
  for (const n of order) maxT = Math.max(maxT, n.foundedTick);
  maxT = Math.max(1, maxT);
  const xOf = (t: number): number => PAD_X + (t / maxT) * (PLOT_W - PAD_X * 2);
  for (const n of order) {
    n.x = xOf(n.foundedTick);
    n.y = TOP_PAD + n.row * ROW_H + ROW_H / 2;
  }

  // 当前个体数：取最新指标采样的 speciesCounts（查不到则省略）
  const latest = record.metrics[record.metrics.length - 1];
  const counts = new Map<number, number>(latest?.speciesCounts.map((c) => [c.id, c.count]) ?? []);

  // 底部时间轴
  const axisY = TOP_PAD + order.length * ROW_H + 10;
  const svgH = Math.max(MIN_H, axisY + 20);
  const tickVals: number[] = [];
  for (let i = 0; i < 4; i++) {
    const v = Math.round((maxT * i) / 3);
    if (!tickVals.includes(v)) tickVals.push(v);
  }

  return (
    <div className="m-3 overflow-x-auto rounded-xl border border-lab-border bg-[#0d121b] p-3">
      <svg
        width={PLOT_W}
        height={svgH}
        role="img"
        aria-label="系统发生树"
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* 分化边：颜色取子物种色，60% 透明度 */}
        {order.map((n) => {
          if (n.parentId === null) return null;
          const parent = nodes.get(n.parentId);
          if (!parent) return null;
          return (
            <path
              key={`edge-${n.id}`}
              d={elbowPath(parent.x, parent.y, n.x, n.y)}
              fill="none"
              stroke={n.color}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={0.6}
            />
          );
        })}

        {/* 底部时间轴刻度 */}
        <line
          x1={PAD_X}
          y1={axisY}
          x2={PLOT_W - PAD_X}
          y2={axisY}
          stroke="#1e2633"
          strokeWidth={1}
        />
        {tickVals.map((v, i) => {
          const x = xOf(v);
          const anchor = i === 0 ? 'start' : i === tickVals.length - 1 ? 'end' : 'middle';
          return (
            <g key={`tick-${v}`}>
              <line x1={x} y1={axisY} x2={x} y2={axisY + 3} stroke="#1e2633" strokeWidth={1} />
              <text x={x} y={axisY + 14} fontSize={10} textAnchor={anchor} className="fill-lab-muted">
                {fmtK(v)}
              </text>
            </g>
          );
        })}

        {/* 节点：存续=实心圆点，灭绝=同位置「×」；点击切换高亮，与物种卡联动 */}
        {order.map((n) => {
          const selected = n.id === highlightId;
          const count = n.isExtinct ? undefined : counts.get(n.id);
          const fate = n.isExtinct
            ? n.extinctTick !== null
              ? `灭绝 tick ${n.extinctTick.toLocaleString()}`
              : '已灭绝（时间未知）'
            : '存续中';
          const lines = [n.name];
          if (n.latin) lines.push(n.latin);
          lines.push(`诞生 tick ${n.foundedTick.toLocaleString()} · ${fate}`);
          if (count !== undefined) lines.push(`当前个体 ${count.toLocaleString()}`);

          return (
            <g
              key={n.id}
              onClick={() => onHighlight(selected ? null : n.id)}
              style={{ cursor: 'pointer' }}
            >
              <title>{lines.join('\n')}</title>
              {n.isExtinct ? (
                <g stroke={n.color} strokeWidth={1.5} strokeLinecap="round" opacity={0.55}>
                  <line x1={n.x - 3} y1={n.y - 3} x2={n.x + 3} y2={n.y + 3} />
                  <line x1={n.x - 3} y1={n.y + 3} x2={n.x + 3} y2={n.y - 3} />
                </g>
              ) : (
                <circle cx={n.x} cy={n.y} r={4} fill={n.color} />
              )}
              {selected && (
                <circle cx={n.x} cy={n.y} r={6.5} fill="none" stroke="#ffffff" strokeWidth={1.5} />
              )}
              <text
                x={n.x + 8}
                y={n.y + 3.5}
                fontSize={11}
                className={n.isExtinct ? 'fill-lab-muted' : 'fill-lab-text'}
              >
                {truncName(n.name)}
                {n.isExtinct ? '†' : ''}
                {count !== undefined && (
                  <tspan className="fill-lab-muted"> · {count.toLocaleString()}</tspan>
                )}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
