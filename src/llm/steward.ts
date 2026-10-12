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

/** 神迹动作：以 target 物种当前聚集地（质心）为中心的空间级干预 */
export interface StewardMiracle {
  kind: 'bloom' | 'smite' | 'bless';
  /** 目标物种名（主线程解析为该物种质心坐标） */
  target: string;
  /** 作用半径（世界格） */
  radius: number;
  /** bloom: 每格注入食物量（1~8）；smite: 圆内击杀比例（0.01~0.5）；bless: 忽略 */
  power: number;
  reason: string;
}

export interface StewardPlan {
  /** 一句话说明这组调整的整体思路 */
  summary: string;
  /** 规则滑杆调整（经清洗） */
  rules: StewardChange[];
  /** 神迹动作（经清洗，target 均为现存物种） */
  miracles: StewardMiracle[];
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

// ---------------------------------------------------------------------------
// LLM 请求与解析
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LLM 请求与解析
// ---------------------------------------------------------------------------

const planSchema = z.object({
  summary: z.string(),
  actions: z.array(
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal('rule'),
        key: z.string(),
        value: z.union([z.number(), z.boolean(), z.string()]),
        reason: z.string(),
      }),
      z.object({
        type: z.literal('miracle'),
        kind: z.enum(['bloom', 'smite', 'bless']),
        target: z.string(),
        radius: z.union([z.number(), z.string()]).optional(),
        power: z.union([z.number(), z.string()]).optional(),
        reason: z.string(),
      }),
    ]),
  ),
});

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 构造世界管家的系统提示词（调整项清单与当前值由调用方拼进 user 消息） */
function stewardSystemPrompt(): string {
  return [
    '你是 Genesis Lab（人工生命演化沙盘）的「世界管家」。',
    '用户会给出世界摘要、当前规则值与一个自然语言需求；你的任务是输出一份世界干预方案（JSON）。',
    '可用的动作分两类：',
    '1. 规则调整：{"type":"rule","key":"<规则键>","value":<目标值>,"reason":"<一句理由>"}',
    '2. 神迹（空间级干预，以某物种当前聚集地为中心）：{"type":"miracle","kind":"<bloom|smite|bless>","target":"<物种名>","radius":<半径>,"power":<强度>,"reason":"<一句理由>"}',
    '   - bloom 雨露（撒食）：power = 每格注入食物量（1~8），适合投喂弱势物种、引导迁徙；',
    '   - smite 天罚（定向击杀）：power = 击杀该物种比例（0.01~0.5），适合削弱过强物种、平衡世界；',
    '   - bless 丰饶（区域食物回满）：power 略去，适合拯救饥荒中的物种；',
    '   - target 必须使用世界摘要中出现的物种名（原文照抄）。',
    '约束：',
    '1. 只能使用上述两类动作，不做任何清单之外的操作；',
    '2. 只提出与需求真正相关的动作（0~5 项），不要为凑数而改；若现状已满足需求，actions 返回空数组并在 summary 里说明；',
    '3. 规则数值必须在每个键标注的取值范围内，且贴合当前值做适度调整；',
    '4. 需求明确指向「削弱 / 打压某物种」时优先用 smite 神迹，而不是只动全局规则；「投喂 / 帮扶某物种」优先 bloom 或 bless；',
    '5. summary 用一句中文概括整体思路；',
    '6. 只输出一个 JSON 对象：{"summary":"...","actions":[...]}，不要输出任何解释或 Markdown 围栏。',
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

/** 神迹参数值域（UI 滑杆与清洗共用） */
export const MIRACLE_LIMITS = {
  radius: { min: 5, max: 60, default: 20 },
  bloom: { min: 1, max: 8, default: 3 },
  smite: { min: 0.01, max: 0.5, default: 0.1 },
} as const;

const MIRACLE_RADIUS_DEFAULT = MIRACLE_LIMITS.radius.default;

const clampRange = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (v.trim() !== '' && Number.isFinite(n)) return n;
  }
  return null;
}

/** 清洗神迹动作：物种名必须在现存列表内、半径与强度钳制、同 (kind,target) 去重取最后 */
function sanitizeMiracles(
  raw: Array<{ kind: 'bloom' | 'smite' | 'bless'; target: string; radius?: unknown; power?: unknown; reason: string }>,
  speciesNames: ReadonlySet<string>,
): StewardMiracle[] {
  const byKey = new Map<string, StewardMiracle>();
  for (const m of raw) {
    const target = m.target.trim();
    if (target === '' || !speciesNames.has(target)) continue;
    const radiusRaw = toNumber(m.radius);
    const powerRaw = toNumber(m.power);
    const radius =
      radiusRaw === null
        ? MIRACLE_RADIUS_DEFAULT
        : clampRange(radiusRaw, MIRACLE_LIMITS.radius.min, MIRACLE_LIMITS.radius.max);
    let power = 0;
    if (m.kind === 'bloom') {
      power =
        powerRaw === null
          ? MIRACLE_LIMITS.bloom.default
          : clampRange(powerRaw, MIRACLE_LIMITS.bloom.min, MIRACLE_LIMITS.bloom.max);
    } else if (m.kind === 'smite') {
      power =
        powerRaw === null
          ? MIRACLE_LIMITS.smite.default
          : clampRange(powerRaw, MIRACLE_LIMITS.smite.min, MIRACLE_LIMITS.smite.max);
    }
    byKey.set(`${m.kind}:${target}`, {
      kind: m.kind,
      target,
      radius: Number(radius.toFixed(1)),
      power,
      reason: m.reason,
    });
  }
  return [...byKey.values()].slice(0, 6);
}

/** 解析并校验模型输出的方案 JSON，清洗后返回 StewardPlan */
function parsePlan(raw: string, current: StewardRules, speciesNames: ReadonlySet<string>): StewardPlan {
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
  const rules: StewardChange[] = [];
  const miracles: Array<{ kind: 'bloom' | 'smite' | 'bless'; target: string; radius?: unknown; power?: unknown; reason: string }> = [];
  for (const action of result.data.actions) {
    if (action.type === 'rule') {
      const key = action.key as StewardKey;
      const meta = STEWARD_KEYS[key];
      if (meta === undefined) continue;
      const value = coerceValue(key, action.value);
      if (value === null) continue;
      const finalValue = meta.kind === 'number' ? clampNumber(key, value as number) : value;
      const cur = meta.read(current);
      const unchanged =
        meta.kind === 'number'
          ? Math.abs((cur as number) - (finalValue as number)) < 1e-9
          : cur === finalValue;
      if (unchanged) continue;
      rules.push({ key, value: finalValue, reason: action.reason });
    } else {
      miracles.push(action);
    }
  }
  return {
    summary: result.data.summary.trim(),
    rules: dedupe(rules).slice(0, 6),
    miracles: sanitizeMiracles(miracles, speciesNames),
  };
}

/**
 * 请求一份世界干预方案（规则调整 + 神迹动作）。
 *
 * @param digest       世界摘要（observer.buildWorldDigest 的产物）
 * @param current      当前规则值（观察舱 rules state）
 * @param request      玩家的自然语言需求
 * @param settings     语言模型连接配置
 * @param speciesNames 现存物种名集合（用于校验神迹目标；空集 = 全部神迹项被丢弃）
 */
export async function requestStewardPlan(
  digest: string,
  current: StewardRules,
  request: string,
  settings: LlmSettings,
  speciesNames: readonly string[] = [],
): Promise<StewardPlan> {
  const system = stewardSystemPrompt();
  const names = new Set(speciesNames);
  const user = [
    '【世界摘要】',
    digest,
    '',
    '【当前规则】',
    rulesForPrompt(current),
    '',
    `【玩家需求】${request.trim()}`,
    '',
    '请输出世界干预方案 JSON。只输出 JSON 本体。',
  ].join('\n');

  // 第一次尝试
  let firstPlan: StewardPlan | null = null;
  let firstProblem = '';
  try {
    firstPlan = parsePlan(await chatJson(settings, system, user), current, names);
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
    '请重新输出一份完整、合法的干预方案 JSON。仍然只输出 JSON 本体，不要解释。',
  ].join('\n');

  try {
    return parsePlan(await chatJson(settings, system, retryUser), current, names);
  } catch (err) {
    if (err instanceof LlmHttpError) {
      throw new Error(`调用语言模型失败：${errText(err)}`);
    }
    throw new Error(
      `两次尝试都未能生成合法的干预方案。首次问题：${firstProblem || '未知'}；重试问题：${errText(err)}`,
    );
  }
}
