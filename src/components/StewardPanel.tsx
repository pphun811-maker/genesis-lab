import { useCallback, useEffect, useState } from 'react';
import { buildWorldDigest } from '../llm/observer';
import {
  requestStewardPlan,
  MIRACLE_LIMITS,
  STEWARD_KEYS,
  type StewardChange,
  type StewardMiracle,
  type StewardPlan,
  type StewardRules,
} from '../llm/steward';
import type { LlmSettings } from '../llm/types';
import { speciesCentroidOf } from '../client/simClient';
import { simManager } from '../client/simManager';
import { useExperiments } from '../store/experiments';
import { loadLlmSettings } from './SettingsModal';
import { Slider, type RulesPatch } from './panels';

// ---------------------------------------------------------------------------
// 世界管家面板：自然语言需求 → AI 组合干预方案 → 勾选/微调 → 应用。
//
// 方案可包含两类动作：
// - 规则调整（rule）：勾选保留/去掉，数值项用滑杆微调（值域与规则面板一致）；
// - 神迹（miracle）：勾选保留/去掉，半径与强度可滑杆微调；应用时把目标物种名
//   解析成该物种当前质心（最新帧实时计算），经 simClient.miracle 释放。
// 全部经 updateRules(via='按 AI 建议') / miracle(via='按 AI 建议') 走引擎，
// 事件流记录「实验者按 AI 建议降下神迹…」等。
// ---------------------------------------------------------------------------

/** StewardRules 与 RulesPatch 结构一致（结构类型），直接复用 */
function toStewardRules(p: RulesPatch): StewardRules {
  return {
    mutationRate: p.mutationRate,
    foodRegrow: p.foodRegrow,
    maxPopulation: p.maxPopulation,
    sexualReproduction: p.sexualReproduction,
    disasters: { ...p.disasters },
  };
}

/** 神迹动作的显示名（与引擎事件文案一致） */
const MIRACLE_LABEL: Record<StewardMiracle['kind'], string> = {
  bloom: '雨露 · 撒食',
  smite: '天罚 · 击杀',
  bless: '丰饶 · 回满',
};

/** change 行的显示文案：标签 + 旧值 → 新值 */
function changeLabel(c: StewardChange, current: StewardRules): string {
  const meta = STEWARD_KEYS[c.key];
  const from = meta.format(meta.read(current));
  return `${meta.label} ${from} → ${meta.format(c.value)}`;
}

/** 神迹行的参数显示 */
function miracleDesc(m: StewardMiracle): string {
  if (m.kind === 'bloom') return `${MIRACLE_LABEL[m.kind]} · 每格 +${m.power.toFixed(1)} 食物`;
  if (m.kind === 'smite') return `${MIRACLE_LABEL[m.kind]} · 击杀 ${Math.round(m.power * 100)}%`;
  return MIRACLE_LABEL[m.kind];
}

export function StewardPanel({
  expId,
  current,
  onApply,
  onClose,
}: {
  expId: string;
  current: RulesPatch;
  onApply: (patch: RulesPatch) => void;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<StewardPlan | null>(null);
  // 规则项的勾选与目标值；神迹项的勾选与微调参数（键含 kind+target 区分）
  const [checked, setChecked] = useState<Partial<Record<string, boolean>>>({});
  const [values, setValues] = useState<Partial<Record<string, number | boolean>>>({});
  const [appliedMsg, setAppliedMsg] = useState<string | null>(null);

  // 挂载时检查 AI 配置（未配置只提示，不发起请求）
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const cfg = await loadLlmSettings();
        if (alive && cfg === null) setError('先在设置里配置 AI');
      } catch {
        if (alive) setError('先在设置里配置 AI');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const currentRules = toStewardRules(current);

  /** 方案到达：全部默认勾选，目标值取 AI 给的值 */
  const acceptPlan = useCallback((p: StewardPlan): void => {
    setPlan(p);
    setChecked(() => {
      const next: Partial<Record<string, boolean>> = {};
      for (const c of p.rules) next[`rule:${c.key}`] = true;
      for (const m of p.miracles) next[`miracle:${m.kind}:${m.target}`] = true;
      return next;
    });
    setValues(() => {
      const next: Partial<Record<string, number | boolean>> = {};
      for (const c of p.rules) next[`rule:${c.key}`] = c.value;
      for (const m of p.miracles) {
        next[`miracle:${m.kind}:${m.target}:radius`] = m.radius;
        if (m.kind === 'bloom' || m.kind === 'smite') {
          next[`miracle:${m.kind}:${m.target}:power`] = m.power;
        }
      }
      return next;
    });
    setAppliedMsg(null);
  }, []);

  const numVal = (key: string, fallback: number): number => {
    const v = values[key];
    return typeof v === 'number' ? v : fallback;
  };

  const send = useCallback(async (): Promise<void> => {
    if (loading) return;
    const record = useExperiments.getState().records[expId];
    if (!record) return;
    const req = question.trim();
    if (req === '') {
      setError('先写下你想让世界发生什么');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const cfg: LlmSettings | null = await loadLlmSettings();
      if (cfg === null) {
        setError('先在设置里配置 AI');
        return;
      }
      const digest = buildWorldDigest(record);
      // 现存物种名集合：AI 神迹目标的校验依据（灭绝种不可作为目标）
      const speciesNames = Object.values(record.species)
        .filter((s) => !s.extinct)
        .map((s) => s.name);
      const p = await requestStewardPlan(digest, currentRules, req, cfg, speciesNames);
      acceptPlan(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // currentRules 随渲染更新，这里刻意只依赖 question/loading——
    // 发送瞬间的规则快照足够，避免回调身份频繁变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptPlan, expId, loading, question]);

  /** 应用勾选项：规则项合并进 RulesPatch，神迹项解析物种质心后逐个释放 */
  const apply = useCallback((): void => {
    if (plan === null) return;
    const record = useExperiments.getState().records[expId];
    if (!record) return;
    const client = simManager.get(expId);

    // ---- 规则项 ----
    let ruleCount = 0;
    const next = toStewardRules(current);
    for (const c of plan.rules) {
      if (checked[`rule:${c.key}`] !== true) continue;
      const v = values[`rule:${c.key}`];
      if (v === undefined) continue;
      STEWARD_KEYS[c.key].write(next, v);
      ruleCount++;
    }

    // ---- 神迹项 ----
    let miracleCount = 0;
    const skipped: string[] = [];
    if (client) {
      const idByName = new Map<string, number>();
      for (const [idStr, meta] of Object.entries(record.species)) {
        idByName.set(meta.name, Number(idStr));
      }
      for (const m of plan.miracles) {
        const base = `miracle:${m.kind}:${m.target}`;
        if (checked[base] !== true) continue;
        const speciesId = idByName.get(m.target);
        if (speciesId === undefined) {
          skipped.push(m.target);
          continue;
        }
        const centroid = speciesCentroidOf(client.latestFrame, speciesId);
        if (centroid === null) {
          skipped.push(m.target);
          continue;
        }
        const radius = numVal(`${base}:radius`, m.radius);
        const power =
          m.kind === 'bless' ? 0 : numVal(`${base}:power`, m.power);
        client.miracle(m.kind, centroid.x, centroid.y, radius, power, '按 AI 建议');
        miracleCount++;
      }
    }

    if (ruleCount > 0) onApply(next as RulesPatch);
    if (ruleCount + miracleCount === 0) return;
    setPlan(null);
    setChecked({});
    setValues({});
    setQuestion('');
    const parts: string[] = [];
    if (ruleCount > 0) parts.push(`${ruleCount} 项规则`);
    if (miracleCount > 0) parts.push(`${miracleCount} 个神迹`);
    setAppliedMsg(`已应用 ${parts.join(' 与 ')}，详见事件流`);
    if (skipped.length > 0) setError(`这些物种已无存活个体，神迹未释放：${skipped.join('、')}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, expId, onApply, plan, values]);

  const checkedCount = plan
    ? plan.rules.filter((c) => checked[`rule:${c.key}`] === true).length +
      plan.miracles.filter((m) => checked[`miracle:${m.kind}:${m.target}`] === true).length
    : 0;

  return (
    <div className="pointer-events-auto w-full max-w-xl rounded-xl border border-lab-border bg-[#0d121b]/95 p-3 shadow-xl backdrop-blur">
      <div className="mb-2 flex items-center">
        <span className="text-xs tracking-[0.2em] text-lab-muted">⚙ 世界管家</span>
        <span className="ml-2 text-[10px] text-lab-muted/60">说出想法，AI 给出规则与神迹的组合方案</span>
        <button
          onClick={onClose}
          className="ml-auto rounded px-1.5 text-sm leading-none text-lab-muted transition-colors hover:text-lab-text"
          title="关闭"
        >
          ×
        </button>
      </div>

      {/* 方案卡片 */}
      {plan !== null && (
        <div className="mb-2 max-h-64 overflow-y-auto rounded-lg border border-lab-border bg-lab-bg/40 p-2">
          {plan.summary !== '' && (
            <p className="mb-2 text-xs leading-5 text-lab-text/90">{plan.summary}</p>
          )}
          {plan.rules.length === 0 && plan.miracles.length === 0 ? (
            <p className="text-xs leading-5 text-lab-muted">
              管家认为当前世界已经满足这个需求，暂不建议干预。
            </p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {plan.rules.map((c) => {
                const meta = STEWARD_KEYS[c.key];
                const isOn = checked[`rule:${c.key}`] === true;
                const v = values[`rule:${c.key}`] ?? c.value;
                return (
                  <div key={`rule-${c.key}`} className="rounded-lg border border-lab-border/70 bg-[#0d121b] p-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isOn}
                        onChange={() => setChecked((m) => ({ ...m, [`rule:${c.key}`]: !isOn }))}
                        className="shrink-0"
                      />
                      <span className="min-w-0 flex-1 text-xs font-medium text-lab-text">
                        {changeLabel(c, currentRules)}
                      </span>
                    </label>
                    {c.reason !== '' && (
                      <p className="mt-1 pl-6 text-[11px] leading-4 text-lab-muted">{c.reason}</p>
                    )}
                    {meta.kind === 'number' && isOn && (
                      <div className="mt-1.5 pl-6">
                        <Slider
                          label="微调"
                          value={v as number}
                          min={meta.min ?? 0}
                          max={meta.max ?? 1}
                          step={meta.step ?? 0.01}
                          display={meta.format(v)}
                          onChange={(nv) => setValues((m) => ({ ...m, [`rule:${c.key}`]: nv }))}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
              {plan.miracles.map((m) => {
                const base = `miracle:${m.kind}:${m.target}`;
                const isOn = checked[base] === true;
                const radius = numVal(`${base}:radius`, m.radius);
                const power = numVal(`${base}:power`, m.power);
                return (
                  <div key={base} className="rounded-lg border border-lab-border/70 bg-[#0d121b] p-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isOn}
                        onChange={() => setChecked((prev) => ({ ...prev, [base]: !isOn }))}
                        className="shrink-0"
                      />
                      <span className="min-w-0 flex-1 text-xs font-medium text-lab-text">
                        {miracleDesc(m)}
                      </span>
                      <span className="shrink-0 rounded-full border border-lab-border px-1.5 py-px text-[10px] text-lab-muted">
                        {m.target}
                      </span>
                    </label>
                    {m.reason !== '' && (
                      <p className="mt-1 pl-6 text-[11px] leading-4 text-lab-muted">{m.reason}</p>
                    )}
                    {isOn && (
                      <div className="mt-1.5 pl-6">
                        <Slider
                          label="半径"
                          value={radius}
                          min={MIRACLE_LIMITS.radius.min}
                          max={MIRACLE_LIMITS.radius.max}
                          step={1}
                          display={`${Math.round(radius)} 格`}
                          onChange={(nv) => setValues((prev) => ({ ...prev, [`${base}:radius`]: nv }))}
                        />
                        {m.kind === 'bloom' && (
                          <Slider
                            label="每格食物"
                            value={power}
                            min={MIRACLE_LIMITS.bloom.min}
                            max={MIRACLE_LIMITS.bloom.max}
                            step={0.5}
                            display={power.toFixed(1)}
                            onChange={(nv) => setValues((prev) => ({ ...prev, [`${base}:power`]: nv }))}
                          />
                        )}
                        {m.kind === 'smite' && (
                          <Slider
                            label="击杀比例"
                            value={power}
                            min={MIRACLE_LIMITS.smite.min}
                            max={MIRACLE_LIMITS.smite.max}
                            step={0.01}
                            display={`${Math.round(power * 100)}%`}
                            onChange={(nv) => setValues((prev) => ({ ...prev, [`${base}:power`]: nv }))}
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {appliedMsg !== null && (
        <div className="mb-2 text-xs leading-5 text-lab-accent">{appliedMsg}</div>
      )}
      {error !== null && <div className="mb-2 text-xs leading-5 text-[#f87171]">{error}</div>}
      {loading && <div className="mb-2 text-xs text-lab-muted">管家推演中…</div>}

      <div className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && !loading) {
              void send();
            }
          }}
          placeholder="让世界和平一点 / 帮青鹿王朝翻身 / 把猎手削弱些…"
          className="min-w-0 flex-1 rounded-lg border border-lab-border bg-[#0d121b] px-3 py-1.5 text-xs outline-none focus:border-lab-accent"
        />
        {plan === null ? (
          <button
            onClick={() => void send()}
            disabled={loading}
            className="shrink-0 rounded-lg bg-lab-accent px-3 py-1.5 text-xs text-lab-bg transition-colors hover:bg-lab-accent-dim disabled:opacity-50"
          >
            生成方案
          </button>
        ) : (
          <button
            onClick={apply}
            disabled={checkedCount === 0}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-xs transition-colors ${
              checkedCount > 0
                ? 'bg-lab-accent text-lab-bg hover:bg-lab-accent-dim'
                : 'cursor-not-allowed bg-lab-border text-lab-muted'
            }`}
            title="把勾选的调整与神迹一并执行"
          >
            应用 {checkedCount} 项
          </button>
        )}
      </div>
    </div>
  );
}
