import { z } from 'zod';
import { chatJson, LlmHttpError } from './provider';
import type { LlmSettings } from './types';

/**
 * 「AI 世界管家」管线。
 *
 * 玩家用自然语言提出需求（『让世界和平一点』『把猎手削弱些』），管家读取
 * 世界摘要（observer.buildWorldDigest 产物）+ 当前规则值，返回一份**结构化
 * 的世界调整方案**：只动规则滑杆能动的量（突变率/食物再生/种群上限/繁殖
 * 方式/灾变开关与强度），每项附一句理由。不做空间级操作。
 *
 * 通路：chatJson（provider.ts，response_format + 400 降级重试）→ JSON.parse
 * → zod 结构校验 → 逐项清洗（无效 key 丢弃 / 类型转换 / clamp 到滑杆值域 /
 * 过滤无变化项 / 同 key 去重取最后）。结构或校验失败时把问题反馈给模型重试
 * 一次；HTTP 层失败不重试直接抛。所有错误均为中文 Error，由 UI 展示。
 */

// ---------------------------------------------------------------------------
// 规则键元数据（取值范围与步进和规则面板 RulesPanel 的滑杆完全一致）
// ---------------------------------------------------------------------------

/** 管家可调整的规则键 */
export type StewardKey =
  | 'mutationRate'
  | 'foodRegrow'
  | 'maxPopulation'
  | 'sexualReproduction'
  | 'disastersEnabled'
  | 'disastersSeverity';

/** 管家视角的当前规则值（结构与规则面板 RulesPatch 一致） */
export interface StewardRules {
  mutationRate: number;
  foodRegrow: number;
  maxPopulation: number;
  sexualReproduction: boolean;
  disasters: { enabled: boolean; severity: number };
}

export interface StewardKeyMeta {
  /** 中文标签（UI 与提示词共用） */
  label: string;
  kind: 'number' | 'boolean';
  /** 数值项滑杆值域与步进 */
  min?: number;
  max?: number;
  step?: number;
  /** 值的中文显示 */
  format: (v: number | boolean) => string;
  /** 提示词里对该键的一句话说明（含义与调节方向） */
  hint: string;
  read: (r: StewardRules) => number | boolean;
  write: (r: StewardRules, v: number | boolean) => void;
}

const pct = (v: number | boolean): string => `${Math.round((v as number) * 100)}%`;

export const STEWARD_KEYS: Record<StewardKey, StewardKeyMeta> = {
  mutationRate: {
    label: '突变率',
    kind: 'number',
    min: 0,
    max: 0.6,
    step: 0.01,
    format: pct,
    hint: '繁殖时基因组突变的概率，高 = 演化快但种群易崩坏',
    read: (r) => r.mutationRate,
    write: (r, v) => {
      r.mutationRate = v as number;
    },
  },
  foodRegrow: {
    label: '食物再生',
    kind: 'number',
    min: 0,
    max: 0.08,
    step: 0.001,
    format: (v) => (v as number).toFixed(3),
    hint: '每格食物的回复速度，高 = 承载力高、更少饥荒',
    read: (r) => r.foodRegrow,
    write: (r, v) => {
      r.foodRegrow = v as number;
    },
  },
  maxPopulation: {
    label: '种群上限',
    kind: 'number',
    min: 100,
    max: 20000,
    step: 100,
    format: (v) => (v as number).toLocaleString(),
    hint: '全图个体总数硬上限，压低会加剧竞争、抬高会放开扩张',
    read: (r) => r.maxPopulation,
    write: (r, v) => {
      r.maxPopulation = v as number;
    },
  },
  sexualReproduction: {
    label: '繁殖方式',
    kind: 'boolean',
    format: (v) => (v ? '有性' : '无性'),
    hint: 'true = 有性（求偶 + 基因交叉，多样性更快）；false = 无性（分裂）',
    read: (r) => r.sexualReproduction,
    write: (r, v) => {
      r.sexualReproduction = v as boolean;
    },
  },
  disastersEnabled: {
    label: '灾变开关',
    kind: 'boolean',
    format: (v) => (v ? '开启' : '关闭'),
    hint: '是否随机发生旱灾 / 瘟疫等灾变，会随机打破稳态',
    read: (r) => r.disasters.enabled,
    write: (r, v) => {
      r.disasters = { ...r.disasters, enabled: v as boolean };
    },
  },
  disastersSeverity: {
    label: '灾变强度',
    kind: 'number',
    min: 0.1,
    max: 1,
    step: 0.05,
    format: pct,
    hint: '灾变发生时的破坏烈度（仅在灾变开启时有意义）',
    read: (r) => r.disasters.severity,
    write: (r, v) => {
      r.disasters = { ...r.disasters, severity: v as number };
    },
  },
};

// ---------------------------------------------------------------------------
// 方案形状与清洗
// ---------------------------------------------------------------------------

export interface StewardChange {
  key: StewardKey;
  value: number | boolean;
  reason: string;
}

export interface StewardPlan {
  /** 一句话说明这组调整的整体思路 */
  summary: string;
  changes: StewardChange[];
}

/** 把数值 clamp 进 [min, max] 并按 step 取整（消除浮点尾数） */
function clampNumber(key: StewardKey, v: number): number {
  const meta = STEWARD_KEYS[key];
  const min = meta.min ?? 0;
  const max = meta.max ?? v;
  const step = meta.step ?? 1;
  const snapped = Math.round(v / step) * step;
  const clean = Number(snapped.toFixed(6));
  return Math.min(max, Math.max(min, clean));
}

/** 尽力把模型给的原始 value 转成该键需要的类型；转不动返回 null（丢弃该项） */
function coerceValue(key: StewardKey, raw: unknown): number | boolean | null {
  const meta = STEWARD_KEYS[key];
  if (meta.kind === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true' || raw === 1) return true;
    if (raw === 'false' || raw === 0) return false;
    return null;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(n)) return n;
  }
  return null;
}

/** 同 key 重复取最后一次（模型自我修正时以最新为准） */
function dedupe(changes: StewardChange[]): StewardChange[] {
  const byKey = new Map<StewardKey, StewardChange>();
  for (const c of changes) byKey.set(c.key, c);
  return [...byKey.values()];
}

/** 清洗模型输出：无效 key 丢弃 → 类型转换 → clamp → 过滤无变化项 → 去重 */
function sanitizePlan(summary: string, rawChanges: Array<{ key: string; value: unknown; reason: string }>, current: StewardRules): StewardPlan {
  const changes: StewardChange[] = [];
  for (const c of rawChanges) {
    const key = c.key as StewardKey;
    const meta = STEWARD_KEYS[key];
    if (meta === undefined) continue;
    const value = coerceValue(key, c.value);
    if (value === null) continue;
    const finalValue = meta.kind === 'number' ? clampNumber(key, value as number) : value;
    const cur = meta.read(current);
    const unchanged =
      meta.kind === 'number'
        ? Math.abs((cur as number) - (finalValue as number)) < 1e-9
        : cur === finalValue;
    if (unchanged) continue;
    changes.push({ key, value: finalValue, reason: c.reason });
  }
  return { summary: summary.trim(), changes: dedupe(changes).slice(0, 6) };
}

// ---------------------------------------------------------------------------
// LLM 请求与解析
// ---------------------------------------------------------------------------

const planSchema = z.object({
  summary: z.string(),
  changes: z.array(
    z.object({
      key: z.string(),
      value: z.union([z.number(), z.boolean(), z.string()]),
      reason: z.string(),
    }),
  ),
});

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 构造世界管家的系统提示词（调整项清单与当前值由调用方拼进 user 消息） */
function stewardSystemPrompt(): string {
  return [
    '你是 Genesis Lab（人工生命演化沙盘）的「世界管家」。',
    '用户会给出世界摘要、当前规则值与一个自然语言需求；你的任务是输出一份规则调整方案（JSON）。',
    '约束：',
    '1. 只能调整清单里列出的规则键，不做任何清单之外的操作；',
    '2. 只提出与需求真正相关的调整（0~4 项），不要为凑数而改；若现有规则已满足需求，changes 返回空数组并在 summary 里说明；',
    '3. 数值必须在每个键标注的取值范围内，且贴合当前值做适度调整（一次调整通常不超过当前值的数倍）；',
    '4. 每项调整给一句中文理由，说明它如何服务于需求；',
    '5. summary 用一句中文概括整体思路；',
    '6. 只输出一个 JSON 对象：{"summary":"...","changes":[{"key":"...","value":...,"reason":"..."}]}，不要输出任何解释或 Markdown 围栏。',
  ].join('\n');
}

/** 当前规则 → 提示词里的清单文本 */
function rulesForPrompt(current: StewardRules): string {
  return (Object.keys(STEWARD_KEYS) as StewardKey[])
    .map((k) => {
      const meta = STEWARD_KEYS[k];
      const range =
        meta.kind === 'number' ? `（${meta.min}~${meta.max}，当前 ${meta.format(meta.read(current))}）` : `（当前 ${meta.format(meta.read(current))}）`;
      return `- ${k} ${meta.label}${range}：${meta.hint}`;
    })
    .join('\n');
}

/** 解析并校验模型输出的方案 JSON，清洗后返回 StewardPlan */
function parsePlan(raw: string, current: StewardRules): StewardPlan {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('输出不是合法 JSON（可能缺少引号、逗号，或大括号不配对）');
  }
  const result = planSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue.path.length > 0 ? issue.path.join('.') : '(根字段)';
    throw new Error(`JSON 字段校验未通过：${where}：${issue.message}`);
  }
  return sanitizePlan(result.data.summary, result.data.changes, current);
}

/**
 * 请求一份世界调整方案。
 *
 * @param digest   世界摘要（observer.buildWorldDigest 的产物）
 * @param current  当前规则值（观察舱 rules state）
 * @param request  玩家的自然语言需求
 * @param settings 语言模型连接配置
 */
export async function requestStewardPlan(
  digest: string,
  current: StewardRules,
  request: string,
  settings: LlmSettings,
): Promise<StewardPlan> {
  const system = stewardSystemPrompt();
  const user = [
    '【世界摘要】',
    digest,
    '',
    '【当前规则】',
    rulesForPrompt(current),
    '',
    `【玩家需求】${request.trim()}`,
    '',
    '请输出规则调整方案 JSON。只输出 JSON 本体。',
  ].join('\n');

  // 第一次尝试
  let firstPlan: StewardPlan | null = null;
  let firstProblem = '';
  try {
    firstPlan = parsePlan(await chatJson(settings, system, user), current);
  } catch (err) {
    if (err instanceof LlmHttpError) {
      // 服务端层面的失败（鉴权、限流、宕机等），重试没有意义，直接抛出
      throw new Error(`调用语言模型失败：${errText(err)}`);
    }
    firstProblem = errText(err);
  }

  if (firstPlan !== null) return firstPlan;

  // 第二次尝试：把上次输出的问题反馈给模型，要求修正
  const retryUser = [
    user,
    '',
    '【你上一次输出的方案存在以下问题，必须修正】',
    firstProblem,
    '请重新输出一份完整、合法的调整方案 JSON。仍然只输出 JSON 本体，不要解释。',
  ].join('\n');

  try {
    return parsePlan(await chatJson(settings, system, retryUser), current);
  } catch (err) {
    if (err instanceof LlmHttpError) {
      throw new Error(`调用语言模型失败：${errText(err)}`);
    }
    throw new Error(
      `两次尝试都未能生成合法的调整方案。首次问题：${firstProblem || '未知'}；重试问题：${errText(err)}`,
    );
  }
}
