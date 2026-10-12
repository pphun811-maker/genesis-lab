import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { simManager } from '../client/simManager';
import { hexToHue } from '../engine/genome';
import { PRESETS, normalizeSpec } from '../engine/presets';
import {
  DEFAULT_GENOME,
  GENE_RANGE,
  type GeneKey,
  type Genome,
  type SpeciesTemplate,
  type WorldSpec,
} from '../engine/types';
import { Slider } from '../components/panels';
import { SettingsModal } from '../components/SettingsModal';
import { useExperiments } from '../store/experiments';

/** 各基因初始方差基准（× 多样性乘数） */
const BASE_VARIANCE: Record<GeneKey, number> = {
  speed: 0.1,
  sense: 1,
  size: 0.15,
  metabolism: 0.1,
  aggression: 0.15,
  fear: 0.15,
  sociability: 0.15,
  reproThreshold: 10,
  hue: 20,
};

const GENE_SLIDERS: Array<{ key: keyof Genome; label: string }> = [
  { key: 'speed', label: '速度' },
  { key: 'sense', label: '感知' },
  { key: 'size', label: '体型' },
  { key: 'metabolism', label: '代谢' },
  { key: 'aggression', label: '攻击性' },
  { key: 'fear', label: '恐惧' },
  { key: 'sociability', label: '群聚性' },
  { key: 'reproThreshold', label: '繁殖阈值' },
];

export function CreateView() {
  const navigate = useNavigate();
  const create = useExperiments((s) => s.create);
  const [spec, setSpec] = useState<WorldSpec>(() => PRESETS[0].spec(Math.floor(Math.random() * 1e9)));
  const [nl, setNl] = useState('');
  const [nlStatus, setNlStatus] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [openSpecies, setOpenSpecies] = useState<number>(0);

  const patch = (p: Partial<WorldSpec>): void => setSpec((s) => ({ ...s, ...p }));

  const applyPreset = (id: string): void => {
    const preset = PRESETS.find((p) => p.id === id)!;
    setSpec(preset.spec(spec.seed));
    setOpenSpecies(0);
  };

  const randomizeSeed = (): void => patch({ seed: Math.floor(Math.random() * 1e9) });

  const patchSpecies = (index: number, p: Partial<SpeciesTemplate>): void => {
    setSpec((s) => ({
      ...s,
      species: s.species.map((sp, i) => (i === index ? { ...sp, ...p } : sp)),
    }));
  };

  const patchGenome = (index: number, key: keyof Genome, value: number): void => {
    setSpec((s) => ({
      ...s,
      species: s.species.map((sp, i) =>
        i === index ? { ...sp, genome: { ...sp.genome, [key]: value } } : sp,
      ),
    }));
  };

  const patchVariance = (index: number, value: number): void => {
    setSpec((s) => ({
      ...s,
      species: s.species.map((sp, i) => {
        if (i !== index) return sp;
        const variance = Object.fromEntries(
          Object.entries(BASE_VARIANCE).map(([k, v]) => [k, v * value]),
        ) as Partial<Record<GeneKey, number>>;
        return { ...sp, variance };
      }),
    }));
  };

  const varianceOf = (sp: SpeciesTemplate): number => {
    const v = sp.variance?.speed ?? BASE_VARIANCE.speed;
    return Math.round((v / BASE_VARIANCE.speed) * 10) / 10;
  };

  const addSpecies = (): void => {
    if (spec.species.length >= 6) return;
    const hues = [140, 200, 0, 60, 280, 320];
    const hue = hues[spec.species.length % hues.length];
    patchSpecies(spec.species.length, {
      name: `物种 #${spec.species.length + 1}`,
      color: hueToHex(hue),
      count: 80,
      genome: { ...DEFAULT_GENOME, hue },
    });
  };

  const launch = (): void => {
    const clean = normalizeSpec(spec, spec.seed);
    const id = create(clean);
    simManager.ensure(id, { spec: clean });
    navigate(`/exp/${id}`);
    simManager.get(id)?.run();
  };

  const preview = useMemo(
    () => JSON.stringify({ ...spec, species: `${spec.species.length} 支初始种群` }, null, 2),
    [spec],
  );

  return (
    <div className="mx-auto max-w-3xl p-8">
      <button onClick={() => navigate('/')} className="mb-6 text-lab-muted hover:text-lab-text">
        ← 返回
      </button>
      <div className="mb-1 flex items-center">
        <h1 className="text-xl font-semibold">创造一个世界</h1>
        <button
          onClick={() => setShowSettings(true)}
          className="ml-auto rounded border border-lab-border px-3 py-1 text-xs text-lab-muted hover:text-lab-text"
        >
          ⚙ AI 设置
        </button>
      </div>
      <p className="mb-6 text-sm text-lab-muted">
        用一句话描述，或手动调节每个参数——一切尽在你的掌控。
      </p>

      {/* 自然语言创世 */}
      <section className="mb-6 rounded-xl border border-lab-border bg-lab-panel p-4">
        <div className="mb-2 flex items-center">
          <h2 className="text-sm font-medium">🗣 用自然语言创世</h2>
          <span className="ml-auto text-xs text-lab-muted">LLM 可用，否则规则解析</span>
        </div>
        <textarea
          value={nl}
          onChange={(e) => setNl(e.target.value)}
          rows={2}
          placeholder="例如：一片贫瘠的红色荒漠，幸存者们进化出了极高的感知能力，还有一支凶猛的猎手部落"
          className="w-full resize-none rounded-lg border border-lab-border bg-[#0d121b] px-3 py-2 text-sm outline-none focus:border-lab-accent"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={() => void generateFromNl(nl, spec.seed, setSpec, setNlStatus, () => setOpenSpecies(0))}
            disabled={nl.trim().length === 0}
            className={`rounded-lg px-4 py-1.5 text-sm ${
              nl.trim()
                ? 'bg-lab-accent text-lab-bg hover:bg-lab-accent-dim'
                : 'cursor-not-allowed bg-lab-border text-lab-muted'
            }`}
          >
            ✦ 生成世界
          </button>
          {nlStatus && <span className="text-xs text-lab-muted">{nlStatus}</span>}
        </div>
      </section>

      {/* 预设 */}
      <div className="mb-6 grid grid-cols-3 gap-3">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => applyPreset(p.id)}
            className={`rounded-xl border p-3 text-left transition-colors ${
              spec.name === p.title
                ? 'border-lab-accent bg-lab-accent/5'
                : 'border-lab-border bg-lab-panel hover:border-[#2f3b4c]'
            }`}
          >
            <div className="text-sm font-medium">{p.title}</div>
            <div className="mt-0.5 text-xs leading-4 text-lab-muted">{p.desc}</div>
          </button>
        ))}
      </div>

      {/* 世界参数 */}
      <section className="mb-6 rounded-xl border border-lab-border bg-lab-panel p-4">
        <h2 className="mb-3 text-sm font-medium">🌍 世界</h2>
        <div className="mb-3 flex gap-4">
          <label className="flex-1">
            <span className="mb-1 block text-xs text-lab-muted">名称</span>
            <input
              value={spec.name}
              onChange={(e) => patch({ name: e.target.value })}
              className="w-full rounded-lg border border-lab-border bg-[#0d121b] px-3 py-2 text-sm outline-none focus:border-lab-accent"
            />
          </label>
          <label className="w-52">
            <span className="mb-1 block text-xs text-lab-muted">种子（决定地形与命运）</span>
            <div className="flex gap-2">
              <input
                type="number"
                value={spec.seed}
                onChange={(e) => patch({ seed: Number(e.target.value) || 0 })}
                className="w-full rounded-lg border border-lab-border bg-[#0d121b] px-3 py-2 font-mono text-sm outline-none focus:border-lab-accent"
              />
              <button
                onClick={randomizeSeed}
                className="shrink-0 rounded-lg border border-lab-border px-3 text-sm hover:text-lab-text"
                title="随机种子"
              >
                🎲
              </button>
            </div>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <Slider label="宽度" value={spec.width} min={40} max={280} step={10}
            display={`${spec.width} 格`}
            onChange={(v) => patch({ width: Math.round(v) })} />
          <Slider label="高度" value={spec.height} min={40} max={280} step={10}
            display={`${spec.height} 格`}
            onChange={(v) => patch({ height: Math.round(v) })} />
          <Slider label="食物上限" value={spec.food.maxPerCell} min={2} max={60} step={1}
            display={`${spec.food.maxPerCell}/格`}
            onChange={(v) => patch({ food: { ...spec.food, maxPerCell: v } })} />
          <Slider label="食物再生" value={spec.food.regrow} min={0.001} max={0.08} step={0.001}
            display={spec.food.regrow.toFixed(3)}
            onChange={(v) => patch({ food: { ...spec.food, regrow: v } })} />
          <Slider label="障碍物" value={spec.terrain.obstacleRatio} min={0} max={0.3} step={0.01}
            display={`${Math.round(spec.terrain.obstacleRatio * 100)}%`}
            onChange={(v) => patch({ terrain: { ...spec.terrain, obstacleRatio: v } })} />
          <Slider label="危险区" value={spec.terrain.hazardRatio} min={0} max={0.2} step={0.01}
            display={`${Math.round(spec.terrain.hazardRatio * 100)}%`}
            onChange={(v) => patch({ terrain: { ...spec.terrain, hazardRatio: v } })} />
        </div>
      </section>

      {/* 物种 */}
      <section className="mb-6 rounded-xl border border-lab-border bg-lab-panel p-4">
        <div className="mb-3 flex items-center">
          <h2 className="text-sm font-medium">🧬 初始物种（{spec.species.length}/6）</h2>
          <button
            onClick={addSpecies}
            disabled={spec.species.length >= 6}
            className={`ml-auto rounded border border-lab-border px-3 py-1 text-xs ${
              spec.species.length >= 6 ? 'cursor-not-allowed text-lab-muted' : 'hover:text-lab-text'
            }`}
          >
            ＋ 添加物种
          </button>
        </div>
        <div className="flex flex-col gap-2">
          {spec.species.map((sp, i) => {
            const open = openSpecies === i;
            return (
              <div key={i} className="rounded-lg border border-lab-border bg-[#0d121b]">
                <div className="flex items-center gap-3 p-2.5">
                  <input
                    type="color"
                    value={sp.color}
                    onChange={(e) => patchSpecies(i, { color: e.target.value, genome: { ...sp.genome, hue: hexToHue(e.target.value) } })}
                    className="h-6 w-6 rounded"
                  />
                  <input
                    value={sp.name}
                    onChange={(e) => patchSpecies(i, { name: e.target.value })}
                    className="w-28 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm outline-none hover:border-lab-border focus:border-lab-accent"
                  />
                  <div className="flex w-44 items-center gap-2">
                    <span className="text-xs text-lab-muted">数量</span>
                    <input
                      type="range" min={1} max={600} value={sp.count}
                      onChange={(e) => patchSpecies(i, { count: Number(e.target.value) })}
                      className="flex-1"
                    />
                    <span className="w-8 text-right font-mono text-xs">{sp.count}</span>
                  </div>
                  <button
                    onClick={() => setOpenSpecies(open ? -1 : i)}
                    className="ml-auto text-xs text-lab-muted hover:text-lab-text"
                  >
                    {open ? '收起 ▲' : '基因 ▼'}
                  </button>
                  {spec.species.length > 1 && (
                    <button
                      onClick={() => setSpec((s) => ({ ...s, species: s.species.filter((_, j) => j !== i) }))}
                      className="text-xs text-lab-muted hover:text-red-400"
                      title="删除该物种"
                    >
                      ✕
                    </button>
                  )}
                </div>
                {open && (
                  <div className="border-t border-lab-border p-3">
                    <div className="mb-3 flex items-center gap-3">
                      <span className="w-16 text-xs text-lab-muted">多样性</span>
                      <input
                        type="range" min={0} max={3} step={0.1} value={varianceOf(sp)}
                        onChange={(e) => patchVariance(i, Number(e.target.value))}
                        className="flex-1"
                      />
                      <span className="w-10 text-right font-mono text-xs">{varianceOf(sp).toFixed(1)}x</span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                      {GENE_SLIDERS.map(({ key, label }) => {
                        const [min, max] = GENE_RANGE[key];
                        const value = sp.genome[key] ?? DEFAULT_GENOME[key];
                        return (
                          <Slider
                            key={key}
                            label={label}
                            value={value}
                            min={min}
                            max={max}
                            step={(max - min) / 100}
                            display={String(Math.round(value * 100) / 100)}
                            onChange={(v) => patchGenome(i, key, v)}
                          />
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* 规则 */}
      <section className="mb-6 rounded-xl border border-lab-border bg-lab-panel p-4">
        <h2 className="mb-3 text-sm font-medium">⚖ 世界法则</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <Slider label="突变率" value={spec.rules.mutationRate} min={0} max={0.6} step={0.01}
            display={`${Math.round(spec.rules.mutationRate * 100)}%`}
            onChange={(v) => patch({ rules: { ...spec.rules, mutationRate: v } })} />
          <Slider label="种群上限" value={spec.rules.maxPopulation} min={100} max={20000} step={100}
            display={spec.rules.maxPopulation.toLocaleString()}
            onChange={(v) => patch({ rules: { ...spec.rules, maxPopulation: Math.round(v) } })} />
          <Slider label="灾变强度" value={spec.rules.disasters?.severity ?? 0.5} min={0.1} max={1} step={0.05}
            display={`${Math.round((spec.rules.disasters?.severity ?? 0.5) * 100)}%`}
            onChange={(v) => patch({
              rules: {
                ...spec.rules,
                disasters: { enabled: spec.rules.disasters?.enabled ?? true, severity: v },
              },
            })} />
          <label className="flex cursor-pointer items-center gap-2 self-end pb-1 text-xs text-lab-muted">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-lab-accent"
              checked={spec.rules.disasters?.enabled ?? true}
              onChange={(e) => patch({
                rules: {
                  ...spec.rules,
                  disasters: {
                    enabled: e.target.checked,
                    severity: spec.rules.disasters?.severity ?? 0.5,
                  },
                },
              })}
            />
            灾变事件（旱灾 / 瘟疫）
          </label>
          <label className="flex cursor-pointer items-center gap-2 self-end pb-1 text-xs text-lab-muted">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-lab-accent"
              checked={spec.rules.sexualReproduction ?? false}
              onChange={(e) => patch({
                rules: { ...spec.rules, sexualReproduction: e.target.checked },
              })}
            />
            有性繁殖（求偶 + 基因交叉）
          </label>
        </div>
      </section>

      {/* 预览 + 创世 */}
      <details className="mb-6 rounded-xl border border-lab-border bg-[#0d121b] p-4">
        <summary className="cursor-pointer text-xs text-lab-muted">世界定义 JSON 预览</summary>
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-5 text-lab-muted">
          {preview}
        </pre>
      </details>

      <button
        onClick={launch}
        className="w-full rounded-xl bg-lab-accent py-3 text-sm font-medium text-lab-bg hover:bg-lab-accent-dim"
      >
        ▶ 创世
      </button>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 自然语言生成（LLM 优先，规则兜底）
// ---------------------------------------------------------------------------

async function generateFromNl(
  nl: string,
  seed: number,
  setSpec: (s: WorldSpec) => void,
  setStatus: (s: string | null) => void,
  afterApply: () => void,
): Promise<void> {
  setStatus('生成中…');
  try {
    const [{ generateWorldSpec }, { generateWorldSpecByRules }, { loadLlmSettings }] = await Promise.all([
      import('../llm/worldgen'),
      import('../llm/rulesFallback'),
      import('../components/SettingsModal'),
    ]);
    const settings = await loadLlmSettings();
    if (settings) {
      try {
        const { spec } = await generateWorldSpec(nl, settings, seed);
        setSpec(spec);
        setStatus('✦ AI 生成的世界已填入下方参数，可微调后创世');
        afterApply();
        return;
      } catch (err) {
        setStatus(`AI 生成失败（${err instanceof Error ? err.message : err}），已退回规则解析`);
      }
    }
    const { spec, applied } = generateWorldSpecByRules(nl, seed);
    setSpec(spec);
    setStatus(`规则解析：${applied.join('；') || '使用默认世界'}`);
    afterApply();
  } catch (err) {
    setStatus(`生成失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

function hueToHex(h: number): string {
  const c = (1 - Math.abs(2 * 0.62 - 1)) * 0.72;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = 0.62 - c / 2;
  const to = (v: number): string => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}
