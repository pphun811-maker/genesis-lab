import { useCallback, useEffect, useState } from 'react';
import { buildWorldDigest } from '../llm/observer';
import {
  requestStewardPlan,
  STEWARD_KEYS,
  type StewardChange,
  type StewardKey,
  type StewardPlan,
  type StewardRules,
} from '../llm/steward';
import type { LlmSettings } from '../llm/types';
import { useExperiments } from '../store/experiments';
import { loadLlmSettings } from './SettingsModal';
import { Slider, type RulesPatch } from './panels';

// ---------------------------------------------------------------------------
// 世界管家面板：自然语言需求 → AI 结构化调整方案 → 勾选/微调 → 应用。
//
// 方案里的每一项都可以单独勾选保留或去掉；数值项还能用滑杆在 AI 给出的
// 基础上继续微调（值域与规则面板滑杆一致，由 steward 层 clamp 保证）。
// 应用时把勾选项合并进当前规则，经 updateRules(via='按 AI 建议') 走引擎，
// 事件流记录为「实验者按 AI 建议修改了规则：…」。
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

/** change 行的显示文案：标签 + 旧值 → 新值 */
function changeLabel(c: StewardChange, current: StewardRules): string {
  const meta = STEWARD_KEYS[c.key];
  const from = meta.format(meta.read(current));
  return `${meta.label} ${from} → ${meta.format(c.value)}`;
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
  // 每项的勾选状态与（可被滑杆微调的）目标值
  const [checked, setChecked] = useState<Partial<Record<StewardKey, boolean>>>({});
  const [values, setValues] = useState<Partial<Record<StewardKey, number | boolean>>>({});
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
    setChecked(Object.fromEntries(p.changes.map((c) => [c.key, true])));
    setValues(Object.fromEntries(p.changes.map((c) => [c.key, c.value])));
    setAppliedMsg(null);
  }, []);

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
      const p = await requestStewardPlan(digest, currentRules, req, cfg);
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

  /** 应用勾选项：以当前规则为底，逐项写入目标值 */
  const apply = useCallback((): void => {
    if (plan === null) return;
    const next = toStewardRules(current);
    let n = 0;
    for (const c of plan.changes) {
      if (checked[c.key] !== true) continue;
      const v = values[c.key];
      if (v === undefined) continue;
      STEWARD_KEYS[c.key].write(next, v);
      n++;
    }
    if (n === 0) return;
    onApply(next as RulesPatch);
    setPlan(null);
    setChecked({});
    setValues({});
    setQuestion('');
    setAppliedMsg(`已应用 ${n} 项调整，详见事件流`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, onApply, plan, values]);

  const checkedCount = plan?.changes.filter((c) => checked[c.key] === true).length ?? 0;

  return (
    <div className="pointer-events-auto w-full max-w-xl rounded-xl border border-lab-border bg-[#0d121b]/95 p-3 shadow-xl backdrop-blur">
      <div className="mb-2 flex items-center">
        <span className="text-xs tracking-[0.2em] text-lab-muted">⚙ 世界管家</span>
        <span className="ml-2 text-[10px] text-lab-muted/60">说出想法，AI 给出规则调整方案</span>
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
          {plan.changes.length === 0 ? (
            <p className="text-xs leading-5 text-lab-muted">
              管家认为当前规则已经满足这个需求，暂不建议调整。
            </p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {plan.changes.map((c) => {
                const meta = STEWARD_KEYS[c.key];
                const isOn = checked[c.key] === true;
                const v = values[c.key] ?? c.value;
                return (
                  <div key={c.key} className="rounded-lg border border-lab-border/70 bg-[#0d121b] p-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isOn}
                        onChange={() => setChecked((m) => ({ ...m, [c.key]: !isOn }))}
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
                          onChange={(nv) => setValues((m) => ({ ...m, [c.key]: nv }))}
                        />
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
            title="把勾选的调整合并进当前规则"
          >
            应用 {checkedCount} 项
          </button>
        )}
      </div>
    </div>
  );
}
