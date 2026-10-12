import { useCallback, useEffect, useRef, useState } from 'react';
import type { MetricSample } from '../engine/types';
import {
  buildWorldDigest,
  bumpSessionCallCount,
  detectDisaster,
  loadObserverPrefs,
  requestAdvice,
  requestNarration,
  type DisasterStatus,
} from '../llm/observer';
import type { LlmSettings } from '../llm/types';
import type { ExperimentRecord } from '../store/types';
import { useExperiments } from '../store/experiments';
import { loadLlmSettings } from './SettingsModal';
import { StewardPanel } from './StewardPanel';
import type { RulesPatch } from './panels';

// ---------------------------------------------------------------------------
// 世界之声：画布底部解说字幕条 + AI 说书人 / 军师。
//
// 字幕来源优先级：新事件（即时显示）> AI 自动解说（按偏好间隔，仅运行中）>
// 本地模板氛围句（每 8 秒轮换兜底，AI 关闭/未配置/失败时永远可用）。
// 所有 AI 调用都经 loadLlmSettings（SettingsModal 的存取方式）加载配置，
// 失败一律 catch 静默降级，绝不产生 unhandled rejection。
// ---------------------------------------------------------------------------

/** 字幕新鲜期 = 氛围句轮换周期（毫秒）：事件/AI 字幕在此期内不被轮换 */
const ROTATE_MS = 8000;
/** AI 自动解说循环的检查间隔（毫秒）：每秒核对偏好 / 运行状态 / 间隔 */
const AI_POLL_MS = 1000;
const AUTO_30_MS = 30_000;
const AUTO_60_MS = 60_000;

type CaptionSource = 'ai' | 'event' | 'ambient';

interface Caption {
  text: string;
  source: CaptionSource;
}

// ---------------------------------------------------------------------------
// 本地模板生成器（模板兜底路径，无任何网络请求）
// ---------------------------------------------------------------------------

interface AmbientCtx {
  dominant: string;
  sharePct: number;
  pop: number;
  tick: number;
  /** 丰饶/正常/紧张/饥荒；旧记录无 foodCap 时为 null */
  foodWord: string | null;
  disaster: DisasterStatus;
}

/** 食物占比 → 状态词（与「世界报告」的口径一致） */
function foodWordOf(latest: MetricSample): string | null {
  if (typeof latest.foodCap !== 'number' || latest.foodCap <= 0) return null;
  const pct = (latest.food / latest.foodCap) * 100;
  if (pct >= 50) return '丰饶';
  if (pct >= 30) return '正常';
  if (pct >= 15) return '紧张';
  return '饥荒';
}

/** 从记录中提取氛围句上下文；没有存续物种或尚无采样时返回 null */
function buildAmbientCtx(record: ExperimentRecord): AmbientCtx | null {
  const metrics = record.metrics;
  const latest = metrics.length > 0 ? metrics[metrics.length - 1] : null;
  if (latest === null) return null;
  const alive = latest.speciesCounts.filter((c) => c.count > 0);
  if (alive.length === 0) return null;
  const ranked = alive.slice().sort((a, b) => b.count - a.count);
  const top = ranked[0];
  const total = ranked.reduce((s, c) => s + c.count, 0) || 1;
  return {
    dominant: record.species[top.id]?.name ?? `物种#${top.id}`,
    sharePct: Math.round((top.count / total) * 100),
    pop: record.lastPop,
    tick: record.lastTick,
    foodWord: foodWordOf(latest),
    disaster: detectDisaster(record),
  };
}

/** 氛围句模板：克制、有味道，全部引用具体物种名 */
const AMBIENT_TEMPLATES: ReadonlyArray<(c: AmbientCtx) => string> = [
  (c) => `${c.dominant}的族群在这片大陆上缓缓铺展，占据着全部生灵的 ${c.sharePct.toLocaleString()}%。`,
  (c) =>
    c.disaster.drought
      ? `旱灾仍未退去，${c.dominant}在龟裂的土地上等待一场不知何时的雨。`
      : c.disaster.plague
        ? `瘟疫的阴影尚未散尽，${c.dominant}的族群正在艰难支撑。`
        : `风平浪静的一天，${c.dominant}的幼崽们在草叶之间穿行。`,
  (c) =>
    c.foodWord === '饥荒'
      ? `粮仓见底，${c.dominant}的每一次觅食都像一场豪赌。`
      : c.foodWord === '紧张'
        ? `食物紧张，${c.dominant}群内的秩序开始经受考验。`
        : `食物${c.foodWord ?? '尚可'}，${c.dominant}得以专注于生长与繁衍。`,
  (c) => `第 ${c.tick.toLocaleString()} tick，${c.dominant}依然是这片土地上最成功的故事。`,
  (c) =>
    c.sharePct >= 60
      ? `${c.dominant}几乎垄断了整个世界（${c.sharePct.toLocaleString()}%）——过分的成功，有时是危险的另一种写法。`
      : `${c.dominant}与它的邻居们维持着微妙的平衡，谁也没有压倒谁。`,
  (c) =>
    c.foodWord === '丰饶'
      ? `食物丰饶，${c.dominant}的数量正在悄然攀升。`
      : `镜头扫过大陆，${c.dominant}的身影占去了 ${c.sharePct.toLocaleString()}% 的版面。`,
  (c) => `${c.dominant}小心地绕开危险区的边界——恐惧，是祖先留给它们的礼物。`,
  (c) => `演化从不预设剧本，而${c.dominant}正在为自己写下第 ${c.tick.toLocaleString()} 行。`,
];

/** 无存续物种时的兜底句 */
const GENERIC_TEMPLATES: ReadonlyArray<() => string> = [
  () => '所有物种都已退场，世界陷入短暂的寂静。',
  () => '生命暂时缺席——这片土地正等待下一次创世。',
];

/** 生成第 templateIndex 条模板字幕（按序轮换，不重复同一句式） */
function makeAmbientCaption(expId: string, templateIndex: number): string {
  const record = useExperiments.getState().records[expId];
  if (!record) return '世界之声待命。';
  if (record.metrics.length === 0) return '生命刚刚启程，观察镜头已经就位。';
  const ctx = buildAmbientCtx(record);
  if (ctx === null) {
    return GENERIC_TEMPLATES[templateIndex % GENERIC_TEMPLATES.length]();
  }
  return AMBIENT_TEMPLATES[templateIndex % AMBIENT_TEMPLATES.length](ctx);
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export function NarratorBar({
  expId,
  rules,
  onApplyRules,
}: {
  expId: string;
  /** 当前规则值（观察舱 rules state），供世界管家读取现状 */
  rules: RulesPatch | null;
  /** 应用规则调整（观察舱统一入口：updateRules + 同步面板 + 跳事件流） */
  onApplyRules: (patch: RulesPatch, via?: string) => void;
}) {
  // 仅订阅 running（低频变化）：用于「欢迎页阶段不显示」的门控
  const running = useExperiments((s) => s.records[expId]?.running ?? false);
  // 订阅事件数组（仅新事件到达时身份变化）：驱动「最新事件即字幕」
  const events = useExperiments((s) => s.records[expId]?.events);

  const [caption, setCaption] = useState<Caption>(() => ({
    text: makeAmbientCaption(expId, 0),
    source: 'ambient',
  }));
  const [aiUnavailable, setAiUnavailable] = useState(false);
  const [advisorOpen, setAdvisorOpen] = useState(false);
  const [advisorQuestion, setAdvisorQuestion] = useState('');
  const [advisorLoading, setAdvisorLoading] = useState(false);
  const [advisorAnswer, setAdvisorAnswer] = useState<string | null>(null);
  const [advisorError, setAdvisorError] = useState<string | null>(null);
  // 长解说句展开：默认 clamp 到 2 行，点击字幕展开全文
  const [captionExpanded, setCaptionExpanded] = useState(false);
  // 世界管家面板（与军师面板互斥，避免叠两层弹窗）
  const [stewardOpen, setStewardOpen] = useState(false);

  // 卸载 / 切换实验标记：异步回调落地前检查，避免旧实验的回答串台
  const disposedRef = useRef(false);
  const genRef = useRef(0);
  const aiUnavailableRef = useRef(false);
  const lastCaptionAtRef = useRef(Date.now());
  const lastEventSigRef = useRef<string | null>(null);
  const lastAiAtRef = useRef(0);
  const templateIdxRef = useRef(0);
  const captionExpandedRef = useRef(false);

  const markAiUnavailable = useCallback((): void => {
    if (aiUnavailableRef.current) return;
    aiUnavailableRef.current = true;
    setAiUnavailable(true); // 角落一次性小字提示
  }, []);

  // AI 自动解说：成功进字幕条；未配置/失败静默标记「AI 暂不可用」并退回模板
  const runAiNarration = useCallback(async (): Promise<void> => {
    const gen = genRef.current;
    const record = useExperiments.getState().records[expId];
    if (!record) return;
    let cfg: LlmSettings | null = null;
    try {
      cfg = await loadLlmSettings();
    } catch {
      cfg = null;
    }
    if (cfg === null) {
      markAiUnavailable();
      return;
    }
    bumpSessionCallCount();
    try {
      const digest = buildWorldDigest(record);
      const text = await requestNarration(digest, cfg);
      if (disposedRef.current || gen !== genRef.current) return;
      lastCaptionAtRef.current = Date.now();
      setCaption({ text, source: 'ai' });
    } catch {
      // 静默失败：保持当前模板字幕，本会话内不再自动重试
      if (disposedRef.current || gen !== genRef.current) return;
      markAiUnavailable();
    }
  }, [expId, markAiUnavailable]);

  // 卸载 / 切换实验：重置全部状态（字幕、军师面板、AI 标记与节流时钟）
  useEffect(() => {
    disposedRef.current = false;
    genRef.current += 1;
    aiUnavailableRef.current = false;
    setAiUnavailable(false);
    templateIdxRef.current = 0;
    lastEventSigRef.current = null;
    lastAiAtRef.current = 0;
    lastCaptionAtRef.current = Date.now();
    setCaption({ text: makeAmbientCaption(expId, 0), source: 'ambient' });
    setAdvisorOpen(false);
    setAdvisorQuestion('');
    setAdvisorLoading(false);
    setAdvisorAnswer(null);
    setAdvisorError(null);
    setStewardOpen(false);
    return () => {
      disposedRef.current = true;
    };
  }, [expId]);

  // 字幕内容变化（事件插播 / AI 解说 / 氛围轮换）时收起展开态，
  // 避免展开的是旧句而显示的是新句造成误解
  useEffect(() => {
    captionExpandedRef.current = false;
    setCaptionExpanded(false);
  }, [caption.text]);

  // 最新事件即字幕：事件流身份变化 = 有新事件（首次只记基线，不抢占字幕）
  useEffect(() => {
    if (events === undefined || events.length === 0) return;
    const lastEv = events[events.length - 1];
    const sig = `${lastEv.t}:${lastEv.kind}:${lastEv.msg}`;
    if (lastEventSigRef.current === null) {
      lastEventSigRef.current = sig;
      return;
    }
    if (lastEventSigRef.current === sig) return;
    lastEventSigRef.current = sig;
    lastCaptionAtRef.current = Date.now();
    setCaption({ text: lastEv.msg, source: 'event' });
  }, [events]);

  // 氛围句轮换：事件/AI 字幕新鲜期内不打扰；用户展开阅读时不抢走字幕
  useEffect(() => {
    const t = setInterval(() => {
      if (disposedRef.current) return;
      if (captionExpandedRef.current) return;
      if (Date.now() - lastCaptionAtRef.current < ROTATE_MS) return;
      templateIdxRef.current += 1;
      const text = makeAmbientCaption(expId, templateIdxRef.current);
      lastCaptionAtRef.current = Date.now();
      setCaption({ text, source: 'ambient' });
    }, ROTATE_MS);
    return () => clearInterval(t);
  }, [expId]);

  // AI 自动解说循环：每秒核对一次；偏好关闭 / 已标记不可用 / 暂停时绝不调用
  useEffect(() => {
    const t = setInterval(() => {
      if (disposedRef.current) return;
      const prefs = loadObserverPrefs();
      if (prefs.auto === 'off') return;
      if (aiUnavailableRef.current) return;
      const record = useExperiments.getState().records[expId];
      if (!record?.running) return;
      const intervalMs = prefs.auto === '30' ? AUTO_30_MS : AUTO_60_MS;
      if (Date.now() - lastAiAtRef.current < intervalMs) return;
      lastAiAtRef.current = Date.now();
      void runAiNarration();
    }, AI_POLL_MS);
    return () => clearInterval(t);
  }, [expId, runAiNarration]);

  // 军师面板：未配置时打开即提示，不发起任何请求；打开时收起管家面板
  const handleAdvisorToggle = useCallback((): void => {
    if (advisorOpen) {
      setAdvisorOpen(false);
      return;
    }
    setStewardOpen(false);
    setAdvisorOpen(true);
    setAdvisorError(null);
    const gen = genRef.current;
    void (async () => {
      try {
        const cfg = await loadLlmSettings();
        if (disposedRef.current || gen !== genRef.current) return;
        if (cfg === null) setAdvisorError('先在设置里配置 AI');
      } catch {
        if (disposedRef.current || gen !== genRef.current) return;
        setAdvisorError('先在设置里配置 AI');
      }
    })();
  }, [advisorOpen]);

  // 军师问答：未配置提示；请求失败把错误显示在面板里（均有 catch）
  const sendAdvice = useCallback(async (): Promise<void> => {
    if (advisorLoading) return;
    const record = useExperiments.getState().records[expId];
    if (!record) return;
    const gen = genRef.current;
    setAdvisorLoading(true);
    setAdvisorError(null);
    try {
      const cfg = await loadLlmSettings();
      if (disposedRef.current || gen !== genRef.current) return;
      if (cfg === null) {
        setAdvisorError('先在设置里配置 AI');
        return;
      }
      bumpSessionCallCount();
      const digest = buildWorldDigest(record);
      const answer = await requestAdvice(digest, advisorQuestion, cfg);
      if (disposedRef.current || gen !== genRef.current) return;
      setAdvisorAnswer(answer);
    } catch (err) {
      if (disposedRef.current || gen !== genRef.current) return;
      setAdvisorError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!disposedRef.current && gen === genRef.current) setAdvisorLoading(false);
    }
  }, [advisorLoading, advisorQuestion, expId]);

  // 世界管家面板开关（与军师面板互斥）
  const handleStewardToggle = useCallback((): void => {
    setAdvisorOpen(false);
    setStewardOpen((v) => !v);
  }, []);

  // 世界尚未开跑（欢迎页覆盖中）时不显示字幕条
  if (!running && (useExperiments.getState().records[expId]?.lastTick ?? 0) === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-14 z-10 flex flex-col items-center gap-2 px-4">
      {stewardOpen && rules !== null && (
        <StewardPanel
          expId={expId}
          current={rules}
          onApply={(patch) => onApplyRules(patch, '按 AI 建议')}
          onClose={() => setStewardOpen(false)}
        />
      )}
      {advisorOpen && (
        <div className="pointer-events-auto w-full max-w-xl rounded-xl border border-lab-border bg-[#0d121b]/95 p-3 shadow-xl backdrop-blur">
          <div className="mb-2 flex items-center">
            <span className="text-xs tracking-[0.2em] text-lab-muted">✦ 军师</span>
            <button
              onClick={() => setAdvisorOpen(false)}
              className="ml-auto rounded px-1.5 text-sm leading-none text-lab-muted transition-colors hover:text-lab-text"
              title="关闭"
            >
              ×
            </button>
          </div>
          {advisorAnswer !== null && (
            <div className="mb-2 max-h-40 overflow-y-auto whitespace-pre-line rounded-lg border border-lab-border bg-lab-bg/40 p-2 text-xs leading-5 text-lab-text">
              {advisorAnswer}
            </div>
          )}
          {advisorError !== null && (
            <div className="mb-2 text-xs leading-5 text-[#f87171]">{advisorError}</div>
          )}
          {advisorLoading && <div className="mb-2 text-xs text-lab-muted">军师推演中…</div>}
          <div className="flex gap-2">
            <input
              value={advisorQuestion}
              onChange={(e) => setAdvisorQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && !advisorLoading) {
                  void sendAdvice();
                }
              }}
              placeholder="问军师：当前局势如何？该不该分叉实验？"
              className="min-w-0 flex-1 rounded-lg border border-lab-border bg-[#0d121b] px-3 py-1.5 text-xs outline-none focus:border-lab-accent"
            />
            <button
              onClick={() => void sendAdvice()}
              disabled={advisorLoading}
              className="shrink-0 rounded-lg bg-lab-accent px-3 py-1.5 text-xs text-lab-bg transition-colors hover:bg-lab-accent-dim disabled:opacity-50"
            >
              发送
            </button>
          </div>
        </div>
      )}
      {/* 半透明胶囊字幕条：长句默认 2 行省略，点击展开全文 */}
      <div
        className={`pointer-events-auto flex max-w-full items-center gap-2 border border-lab-border bg-black/60 py-1.5 pl-4 pr-1.5 shadow-lg backdrop-blur ${
          captionExpanded ? 'rounded-2xl' : 'rounded-full'
        }`}
      >
        {caption.source === 'ai' && (
          <span className="shrink-0 rounded bg-lab-accent/15 px-1.5 py-0.5 text-[10px] leading-none text-lab-accent">
            AI
          </span>
        )}
        <p
          onClick={() => {
            captionExpandedRef.current = !captionExpanded;
            setCaptionExpanded(captionExpandedRef.current);
          }}
          className={`min-w-0 max-w-[520px] cursor-pointer text-xs leading-5 text-lab-text/90 ${
            captionExpanded ? '' : 'line-clamp-2'
          }`}
          title={captionExpanded ? '点击收起' : caption.text}
        >
          {caption.text}
        </p>
        {aiUnavailable && (
          <span
            className="shrink-0 text-[10px] leading-none text-lab-muted/70"
            title="本次会话内自动解说已退回本地模板"
          >
            AI 暂不可用
          </span>
        )}
        <button
          onClick={handleStewardToggle}
          className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] leading-4 transition-colors ${
            stewardOpen
              ? 'border-lab-accent bg-lab-accent/20 text-lab-accent'
              : 'border-lab-border bg-lab-border/40 text-lab-muted hover:border-lab-accent/60 hover:text-lab-accent'
          }`}
          title="AI 世界管家：说出想法，生成规则调整方案"
        >
          ⚙ 管家
        </button>
        <button
          onClick={handleAdvisorToggle}
          className={`shrink-0 rounded-full border border-lab-accent/40 px-2.5 py-0.5 text-[11px] leading-4 transition-colors ${
            advisorOpen ? 'bg-lab-accent/20 text-lab-accent' : 'bg-lab-accent/10 text-lab-accent hover:bg-lab-accent/20'
          }`}
          title="向 AI 军师提问（也可在设置中开启自动解说）"
        >
          ✦ 问军师
        </button>
      </div>
    </div>
  );
}
