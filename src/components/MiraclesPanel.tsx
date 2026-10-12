import { useState } from 'react';
import { simManager } from '../client/simManager';

// ---------------------------------------------------------------------------
// 神迹面板：雨露（撒食）/ 天罚（定向击杀）/ 丰饶（食物回满）。
//
// 以「当前选中的个体」为圆心释放——观察者的干预永远有一个具体的落点。
// 每类神迹有 300 tick 冷却（会话内内存态，切实验重置），释放即写入事件流。
// ---------------------------------------------------------------------------

/** 单类神迹的冷却时长（tick） */
const MIRACLE_COOLDOWN_TICKS = 300;

/** 神迹定义 */
interface MiracleDef {
  kind: 'bloom' | 'smite' | 'bless';
  name: string;
  tagline: string;
  desc: string;
}

const MIRACLES: MiracleDef[] = [
  {
    kind: 'bloom',
    name: '雨露',
    tagline: '撒下食物',
    desc: '在选中个体周围投下一片食物，吸引族群聚集、救助弱势者。',
  },
  {
    kind: 'smite',
    name: '天罚',
    tagline: '定向雷击',
    desc: '雷落在选中个体周围，随机带走一部分生灵——削弱过强的族群。',
  },
  {
    kind: 'bless',
    name: '丰饶',
    tagline: '土地回满',
    desc: '选中个体周围的土地瞬间恢复全部承载能力，拯救饥荒。',
  },
];

/** 会话内的冷却记录：expId → kind → 上次释放的 tick（切实验不串台，刷新归零） */
const cooldowns = new Map<string, Partial<Record<'bloom' | 'smite' | 'bless', number>>>();

export function MiraclesPanel({
  expId,
  currentTick,
  center,
  onClose,
}: {
  expId: string;
  currentTick: number;
  /** 选中个体的世界坐标（null = 未选中，无法定位） */
  center: { x: number; y: number } | null;
  onClose: () => void;
}) {
  // 每类神迹的本地参数草稿
  const [radius, setRadius] = useState(20);
  const [bloomPower, setBloomPower] = useState(3);
  const [smiteRatio, setSmiteRatio] = useState(0.1);
  // 触发重渲以刷新冷却倒计时（释放后 setCooldown 会走这里）
  const [, forceRender] = useState(0);

  const record = cooldowns.get(expId) ?? {};
  const remaining = (kind: 'bloom' | 'smite' | 'bless'): number => {
    const at = record[kind];
    if (at === undefined) return 0;
    return Math.max(0, MIRACLE_COOLDOWN_TICKS - (currentTick - at));
  };

  const release = (kind: 'bloom' | 'smite' | 'bless'): void => {
    if (!center) return;
    if (remaining(kind) > 0) return;
    const client = simManager.get(expId);
    if (!client) return;
    const power = kind === 'bloom' ? bloomPower : kind === 'smite' ? smiteRatio : 0;
    client.miracle(kind, center.x, center.y, radius, power);
    const rec = cooldowns.get(expId) ?? {};
    rec[kind] = currentTick;
    cooldowns.set(expId, rec);
    forceRender((v) => v + 1);
  };

  return (
    <div className="pointer-events-auto absolute right-3 top-12 z-20 w-72 rounded-xl border border-lab-border bg-[#0d121b]/95 p-3 shadow-xl backdrop-blur">
      <div className="mb-2 flex items-center">
        <span className="text-xs tracking-[0.2em] text-lab-muted">✦ 神迹</span>
        <button
          onClick={onClose}
          className="ml-auto rounded px-1.5 text-sm leading-none text-lab-muted transition-colors hover:text-lab-text"
          title="关闭"
        >
          ×
        </button>
      </div>

      {center === null ? (
        <p className="mb-2 text-xs leading-5 text-[#fbbf24]">先在画面中点击一个个体定位神迹落点。</p>
      ) : (
        <p className="mb-2 text-[11px] leading-4 text-lab-muted">
          落点：选中个体周围（{Math.round(center.x)}, {Math.round(center.y)}）
        </p>
      )}

      <div className="mb-2.5">
        <SliderRow label="作用半径" value={radius} min={5} max={60} step={1} display={`${radius} 格`} onChange={setRadius} />
      </div>

      <div className="flex flex-col gap-2">
        {MIRACLES.map((m) => {
          const cd = remaining(m.kind);
          const disabled = center === null || cd > 0;
          return (
            <div key={m.kind} className="rounded-lg border border-lab-border/70 bg-[#0d121b] p-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-lab-text">
                  {m.name}
                  <span className="ml-1.5 text-[10px] text-lab-muted/70">{m.tagline}</span>
                </span>
                {cd > 0 && (
                  <span className="ml-auto font-mono text-[10px] text-lab-muted">
                    冷却 {cd} tick
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11px] leading-4 text-lab-muted">{m.desc}</p>
              {m.kind === 'bloom' && (
                <div className="mt-1.5">
                  <SliderRow label="每格食物" value={bloomPower} min={1} max={8} step={0.5} display={bloomPower.toFixed(1)} onChange={setBloomPower} />
                </div>
              )}
              {m.kind === 'smite' && (
                <div className="mt-1.5">
                  <SliderRow
                    label="击杀比例"
                    value={smiteRatio}
                    min={0.01}
                    max={0.5}
                    step={0.01}
                    display={`${Math.round(smiteRatio * 100)}%`}
                    onChange={setSmiteRatio}
                  />
                </div>
              )}
              <button
                onClick={() => release(m.kind)}
                disabled={disabled}
                className={`mt-2 w-full rounded-lg py-1.5 text-xs transition-colors ${
                  disabled
                    ? 'cursor-not-allowed bg-lab-border text-lab-muted'
                    : 'bg-lab-accent/15 text-lab-accent hover:bg-lab-accent/25'
                }`}
              >
                降下「{m.name}」
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 面板内的小滑杆行（与规则面板 Slider 同款布局，紧凑版） */
function SliderRow({
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
      <div className="mb-0.5 flex justify-between text-[11px]">
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
