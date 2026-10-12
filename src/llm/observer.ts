/**
 * 「世界之声」观察员模块。
 *
 * - buildWorldDigest：把实验记录压缩成 ~600 token 的中文世界摘要（喂给 LLM）；
 * - requestNarration / requestAdvice：纪录片解说员与演化军师两种纯文本对话；
 * - detectDisaster：从事件流判断旱灾/瘟疫是否仍在持续（摘要与本地模板兜底共用）；
 * - 观察员偏好（auto 频率，localStorage）与本会话调用计数的读写。
 *
 * 与 worldgen 的 JSON 通路不同，这里只取纯文本回复；provider 配置沿用
 * SettingsModal 的 loadLlmSettings 存取方式（由调用方加载后作为 cfg 传入）。
 * 请求 20 秒超时（AbortController），任何失败都以中文 Error 抛出，由 UI 捕获降级。
 */

import {
  DEATH_CAUSE_KEYS,
  DEATH_CAUSE_LABELS,
  emptyDeathCauses,
  type MetricSample,
  type SimEvent,
} from '../engine/types';
import type { ExperimentRecord } from '../store/types';
import type { LlmSettings } from './types';

/** 观察员 LLM 请求超时（毫秒） */
const TIMEOUT_MS = 20_000;

/** 观察员使用的 provider 配置形状（与 SettingsModal 持久化的 LlmSettings 一致） */
export type ProviderConfig = LlmSettings;

// ---------------------------------------------------------------------------
// 纯文本 chat/completions 客户端（20s 超时，非 2xx / 网络错误 / 空回复均抛中文错误）
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/** 发起一次纯文本对话并返回 trim 后的回复（未配置 / 失败 / 超时均抛中文错误） */
async function requestPlainText(
  cfg: ProviderConfig,
  system: string,
  user: string,
  temperature: number,
): Promise<string> {
  if (cfg.baseURL.trim() === '' || cfg.model.trim() === '') {
    throw new Error('AI 未配置：请先在设置中填写 API 地址与模型名。');
  }
  const url = `${cfg.baseURL.trim().replace(/\/+$/, '')}/chat/completions`;
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey.trim() !== '' ? { Authorization: `Bearer ${cfg.apiKey.trim()}` } : {}),
        },
        body: JSON.stringify({ model: cfg.model.trim(), messages, temperature }),
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(`AI 请求超时（${TIMEOUT_MS / 1000} 秒），请检查网络或 API 地址。`);
      }
      throw new Error(`AI 请求失败：${errText(err)}`);
    }

    if (!res.ok) {
      const detail = await res
        .text()
        .then((t) => t.slice(0, 300))
        .catch(() => '');
      throw new Error(
        `AI 服务返回 HTTP ${res.status}：${detail || res.statusText || '请求被拒绝'}`,
      );
    }

    let data: ChatCompletionResponse;
    try {
      data = (await res.json()) as ChatCompletionResponse;
    } catch {
      if (controller.signal.aborted) {
        throw new Error(`AI 请求超时（${TIMEOUT_MS / 1000} 秒），请检查网络或 API 地址。`);
      }
      throw new Error('AI 服务返回的响应体不是合法 JSON。');
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('AI 返回的内容为空。');
    }
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 解说员与军师
// ---------------------------------------------------------------------------

/** 构造纪录片解说员的系统提示词 */
function narrationSystemPrompt(): string {
  return [
    '你是一部人工生命演化模拟的纪录片解说员，负责为世界「Genesis Lab」配音。',
    '根据用户给出的世界摘要，用一到两句生动但克制的中文解说当前局面。',
    '必须引用摘要中出现的具体物种名。',
    '直接输出解说词本身：禁止使用 Markdown，禁止用引号包裹，禁止任何客套话或开场白。',
  ].join('\n');
}

/** 构造演化军师的系统提示词 */
function adviceSystemPrompt(): string {
  return [
    '你是演化沙盘「Genesis Lab」的军师，熟悉人工生命模拟中的觅食、捕食、演化与灾变机制。',
    '根据用户给出的世界摘要与问题，给出 2-3 条简短、可执行的建议。',
    '每条建议单独占一行，必须引用摘要中的具体数字与物种名。',
    '直接输出建议本身：禁止使用 Markdown，禁止客套话。',
  ].join('\n');
}

/**
 * 请求一条纪录片式解说（一到两句中文）。
 * 未配置 / 网络失败 / 超时 / 空回复均抛出中文错误，由 UI 捕获并降级到本地模板。
 */
export async function requestNarration(digest: string, cfg: ProviderConfig): Promise<string> {
  return requestPlainText(
    cfg,
    narrationSystemPrompt(),
    `世界摘要：\n${digest}\n\n请用一到两句中文解说当前局面。`,
    0.9,
  );
}

/**
 * 请求军师建议（2-3 条，每条一行）。
 * question 为空时使用默认问题。失败时抛出中文错误，由 UI 展示。
 */
export async function requestAdvice(
  digest: string,
  question: string,
  cfg: ProviderConfig,
): Promise<string> {
  const q = question.trim().length > 0 ? question.trim() : '当前世界最值得注意的风险与机会是什么';
  return requestPlainText(cfg, adviceSystemPrompt(), `世界摘要：\n${digest}\n\n用户问题：${q}`, 0.6);
}

// ---------------------------------------------------------------------------
// 灾变状态判定（事件流驱动，供摘要与本地模板共用）
// ---------------------------------------------------------------------------

export interface DisasterStatus {
  drought: boolean;
  plague: boolean;
}

const DROUGHT_START_RE = /^旱灾来袭/;
const DROUGHT_END_RE = /^旱灾结束/;
const PLAGUE_START_RE = /^瘟疫爆发/;
const PLAGUE_END_RE = /^瘟疫平息/;

/** 旱灾最长 3000 tick（1500 + rng(1500)）；消息解析失败时用此上限 */
const DROUGHT_MAX_TICKS = 3500;
/** 瘟疫至多跨越一次 300-tick 灾变检查周期（平息播报必达，此为事件被裁剪时的兜底） */
const PLAGUE_MAX_TICKS = 300;

/** 从「旱灾来袭」消息中解析预计持续 tick 数；解析失败返回 null */
function droughtDurationOf(msg: string): number | null {
  const m = msg.match(/预计持续\s*([\d,]+)\s*tick/);
  if (m === null) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 从最近事件判断旱灾/瘟疫是否仍在持续（事件被裁剪时用 tick 上限兜底） */
export function detectDisaster(record: ExperimentRecord): DisasterStatus {
  let droughtEv: SimEvent | null = null;
  let plagueEv: SimEvent | null = null;
  const events = record.events;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (droughtEv === null && (DROUGHT_START_RE.test(e.msg) || DROUGHT_END_RE.test(e.msg))) {
      droughtEv = e;
    }
    if (plagueEv === null && (PLAGUE_START_RE.test(e.msg) || PLAGUE_END_RE.test(e.msg))) {
      plagueEv = e;
    }
    if (droughtEv !== null && plagueEv !== null) break;
  }

  let drought = false;
  if (droughtEv !== null && DROUGHT_START_RE.test(droughtEv.msg)) {
    const dur = droughtDurationOf(droughtEv.msg) ?? DROUGHT_MAX_TICKS;
    drought = record.lastTick - droughtEv.t < dur;
  }
  let plague = false;
  if (plagueEv !== null && PLAGUE_START_RE.test(plagueEv.msg)) {
    plague = record.lastTick - plagueEv.t < PLAGUE_MAX_TICKS;
  }
  return { drought, plague };
}

// ---------------------------------------------------------------------------
// 世界摘要
// ---------------------------------------------------------------------------

/** 速率统计窗口（tick） */
const RATE_WINDOW_TICKS = 2000;
/** 死因聚合的采样窗口数上限 */
const CAUSE_SAMPLE_WINDOW = 30;
/** 摘要收录的事件条数 */
const DIGEST_EVENT_COUNT = 10;
/** 摘要收录的物种种数 */
const DIGEST_TOP_SPECIES = 5;
/** 摘要收录的食物网条数 */
const DIGEST_TOP_KILLS = 3;

/** 找到 t <= tick 的最近一个采样（从尾部向前找） */
function sampleAtOrBefore(metrics: MetricSample[], tick: number): MetricSample | null {
  for (let i = metrics.length - 1; i >= 0; i--) {
    if (metrics[i].t <= tick) return metrics[i];
  }
  return null;
}

/**
 * 把实验记录压缩成 ~600 token 的中文世界摘要。
 * 旧记录缺少 foodCap / deathsByCause / killTop 等可选字段时逐项容错跳过。
 */
export function buildWorldDigest(record: ExperimentRecord): string {
  const metrics = record.metrics;
  const latest = metrics.length > 0 ? metrics[metrics.length - 1] : null;
  const nameOf = (id: number): string => record.species[id]?.name ?? `物种#${id}`;

  const lines: string[] = [];
  lines.push(`【世界】${record.name}`);
  lines.push(`【当前】第 ${record.lastTick.toLocaleString()} tick，种群 ${record.lastPop.toLocaleString()}`);

  if (latest !== null) {
    const alive = latest.speciesCounts.filter((c) => c.count > 0);
    lines.push(`存续物种 ${alive.length.toLocaleString()} 支`);

    if (typeof latest.foodCap === 'number' && latest.foodCap > 0) {
      const pct = Math.round((latest.food / latest.foodCap) * 100);
      lines.push(`食物储备 ${latest.food.toLocaleString()}，占容量 ${pct}%`);
    } else {
      lines.push(`食物存量 ${latest.food.toLocaleString()}（容量未知）`);
    }

    // 近 RATE_WINDOW_TICKS tick 的出生/死亡/捕杀速率（每千 tick），从尾部累计避免全表扫描
    const base = sampleAtOrBefore(metrics, latest.t - RATE_WINDOW_TICKS) ?? metrics[0];
    const span = latest.t - base.t;
    if (span > 0) {
      let births = 0;
      let deaths = 0;
      let kills = 0;
      for (let i = metrics.length - 1; i >= 0; i--) {
        const m = metrics[i];
        if (m.t <= base.t) break;
        births += m.births;
        deaths += m.deaths;
        kills += m.kills;
      }
      const per1k = (v: number): string =>
        ((v / span) * 1000).toLocaleString(undefined, { maximumFractionDigits: 1 });
      lines.push(
        `近 ${span.toLocaleString()} tick 速率（每千 tick）：出生 ${per1k(births)}，死亡 ${per1k(deaths)}，捕杀 ${per1k(kills)}`,
      );
    }

    // 死因构成：聚合最近 CAUSE_SAMPLE_WINDOW 个采样窗口（旧记录无 deathsByCause 时跳过）
    const causeSums = emptyDeathCauses();
    let causeWindows = 0;
    for (let i = Math.max(0, metrics.length - CAUSE_SAMPLE_WINDOW); i < metrics.length; i++) {
      const d = metrics[i].deathsByCause;
      if (!d) continue;
      causeWindows++;
      for (const k of DEATH_CAUSE_KEYS) causeSums[k] += d[k];
    }
    const causeTotal = DEATH_CAUSE_KEYS.reduce((s, k) => s + causeSums[k], 0);
    if (causeWindows > 0 && causeTotal > 0) {
      const parts = DEATH_CAUSE_KEYS.map((k) => ({ label: DEATH_CAUSE_LABELS[k], n: causeSums[k] }))
        .filter((p) => p.n > 0)
        .sort((a, b) => b.n - a.n)
        .map((p) => `${p.label} ${Math.round((p.n / causeTotal) * 100)}%`);
      if (parts.length > 0) {
        lines.push(
          `近期死因构成（${causeWindows.toLocaleString()} 个采样窗口，共 ${causeTotal.toLocaleString()} 例）：${parts.join('、')}`,
        );
      }
    }

    // Top5 物种（名 / 数量 / 占比 / 特征标签）
    const ranked = alive.slice().sort((a, b) => b.count - a.count);
    const shareTotal = ranked.reduce((s, c) => s + c.count, 0) || 1;
    const topSpecies = ranked.slice(0, DIGEST_TOP_SPECIES).map((c) => {
      const meta = record.species[c.id];
      const tags = meta?.tags !== undefined && meta.tags.length > 0 ? `（${meta.tags.join('/')}）` : '';
      const pct = Math.round((c.count / shareTotal) * 100);
      return `${nameOf(c.id)}${tags} ${c.count.toLocaleString()} 只，占 ${pct}%`;
    });
    if (topSpecies.length > 0) lines.push(`【Top5 物种】${topSpecies.join('；')}`);

    // 食物网 Top3（累计捕杀对）
    if (latest.killTop !== undefined && latest.killTop.length > 0) {
      const topKills = latest.killTop
        .slice(0, DIGEST_TOP_KILLS)
        .map((k) => `${nameOf(k.killer)} 捕食 ${nameOf(k.victim)}（${k.count.toLocaleString()} 次）`);
      lines.push(`【食物网 Top3】${topKills.join('；')}`);
    }
  }

  // 最近事件原文
  if (record.events.length > 0) {
    lines.push('【最近事件】');
    for (const e of record.events.slice(-DIGEST_EVENT_COUNT)) {
      lines.push(`· 第 ${e.t.toLocaleString()} tick：${e.msg}`);
    }
  }

  // 灾变状态
  const disaster = detectDisaster(record);
  const ongoing: string[] = [];
  if (disaster.drought) ongoing.push('旱灾进行中');
  if (disaster.plague) ongoing.push('瘟疫进行中');
  lines.push(`【灾变】${ongoing.length > 0 ? ongoing.join('；') : '当前无进行中的灾变'}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 观察员偏好（auto 频率）与本会话调用计数
// ---------------------------------------------------------------------------

export const OBSERVER_PREFS_KEY = 'gl-ai-observer-v1';
const OBSERVER_COUNT_KEY = 'gl-ai-observer-count-v1';

export type ObserverAutoMode = 'off' | '30' | '60';

export interface ObserverPrefs {
  /** AI 自动解说频率：off = 仅手动 */
  auto: ObserverAutoMode;
}

/** 读取观察员偏好（默认 { auto: 'off' }；数据损坏或 localStorage 不可用时同样回退默认） */
export function loadObserverPrefs(): ObserverPrefs {
  try {
    const raw = localStorage.getItem(OBSERVER_PREFS_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const auto = (parsed as { auto?: unknown }).auto;
        if (auto === 'off' || auto === '30' || auto === '60') return { auto };
      }
    }
  } catch {
    // 数据损坏 / 隐私模式：回退默认
  }
  return { auto: 'off' };
}

/** 保存观察员偏好（写入失败时静默，仅影响持久化） */
export function saveObserverPrefs(prefs: ObserverPrefs): void {
  try {
    localStorage.setItem(OBSERVER_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 写入失败（隐私模式等）只影响下次的记忆
  }
}

let sessionCallCount = 0;

/** 本会话已发起的观察员 AI 调用次数（内存计数，刷新页面归零） */
export function getSessionCallCount(): number {
  return sessionCallCount;
}

/** 计一次 AI 调用，并尽力镜像到 localStorage（可选持久化，失败无碍） */
export function bumpSessionCallCount(): void {
  sessionCallCount += 1;
  try {
    localStorage.setItem(OBSERVER_COUNT_KEY, String(sessionCallCount));
  } catch {
    // 镜像失败不影响主功能
  }
}
