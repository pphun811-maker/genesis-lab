import { normalizeSpec } from '../engine/presets';
import { describeSpecForPrompt, worldSpecSchema } from '../engine/specSchema';
import type { WorldSpec } from '../engine/types';
import { chatJson, LlmHttpError } from './provider';
import type { LlmSettings } from './types';

/**
 * 自然语言 → WorldSpec 的 LLM 通路。
 *
 * 流程：系统提示（创世设计师 + describeSpecForPrompt 的格式说明）→ chatJson
 * → JSON.parse → worldSpecSchema.safeParse → normalizeSpec 补全钳制。
 * 解析或校验失败时，把问题摘要附加到第二次 user 消息里重试一次；
 * 仍失败则抛出含原因的中文错误。HTTP 层失败（鉴权、限流、宕机）不重试，直接抛出。
 */

/** 构造「创世设计师」系统提示词 */
function buildSystemPrompt(): string {
  return [
    '你是 Genesis Lab（人工生命模拟器）的「创世设计师」。',
    '用户会用一句自然语言描述想要的世界，你的任务是把这段描述转换成一份 WorldSpec 世界定义 JSON。',
    '',
    describeSpecForPrompt(),
    '',
    '设计要求：',
    '1. 数值要贴合用户描述的主题（例如：沙漠→食物贫瘠且危险；海洋→食物丰富；捕食者→同时安排猎手与猎物，猎手数量约为猎物的 1/8；高突变→mutationRate 调高；和平→全员攻击性为 0 且无危险区）；',
    '2. 通常安排 1~4 支物种，用不同的基因组合体现生态位（猎物：低攻击、高群聚、高警惕；猎手：高攻击、高速度、大体型）；',
    '3. 物种名使用不超过 12 个字的中文短名；',
    '4. 只输出一个 JSON 对象，不要输出任何解释、注释或 Markdown 代码围栏。',
  ].join('\n');
}

/** 解析并校验模型输出的 JSON，通过后用 normalizeSpec 补全为完整 WorldSpec */
function parseSpec(raw: string, seed: number): WorldSpec {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('输出不是合法 JSON（可能缺少引号、逗号，或大括号不配对）');
  }
  const result = worldSpecSchema.safeParse(data);
  if (!result.success) {
    const summary = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(根字段)'}：${issue.message}`)
      .join('；');
    throw new Error(`JSON 字段校验未通过：${summary}`);
  }
  // schema 有意比 WorldSpec 宽松（所有字段可选，交由 normalizeSpec 补全钳制），
  // 因此这里做一次受控的类型断言。
  return normalizeSpec(result.data as unknown as Partial<WorldSpec>, seed);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 把一句自然语言描述转成完整 WorldSpec。
 *
 * @param nl       用户的自然语言描述
 * @param settings 语言模型连接配置
 * @param seed     世界随机种子（normalizeSpec 会用它覆盖输出中的 seed）
 */
export async function generateWorldSpec(
  nl: string,
  settings: LlmSettings,
  seed: number,
): Promise<{ spec: WorldSpec; source: 'llm' }> {
  const system = buildSystemPrompt();
  const user = `用户描述：「${nl}」\n\n请把它转换成世界定义 JSON（seed 由系统指定，无需输出）。只输出 JSON。`;

  // 第一次尝试
  let firstSpec: WorldSpec | null = null;
  let firstProblem = '';
  try {
    firstSpec = parseSpec(await chatJson(settings, system, user), seed);
  } catch (err) {
    if (err instanceof LlmHttpError) {
      // 服务端层面的失败（鉴权失败、限流、宕机等），重试没有意义，直接抛出
      throw new Error(`调用语言模型失败：${errText(err)}`);
    }
    firstProblem = errText(err);
  }

  if (firstSpec !== null) {
    return { spec: firstSpec, source: 'llm' };
  }

  // 第二次尝试：把上次输出的问题反馈给模型，要求修正
  const retryUser = [
    user,
    '',
    '【你上一次输出的 JSON 存在以下问题，必须修正】',
    firstProblem,
    '请重新输出一份完整、合法的世界定义 JSON。仍然只输出 JSON 本体，不要解释。',
  ].join('\n');

  try {
    const spec = parseSpec(await chatJson(settings, system, retryUser), seed);
    return { spec, source: 'llm' };
  } catch (err) {
    if (err instanceof LlmHttpError) {
      throw new Error(`调用语言模型失败：${errText(err)}`);
    }
    throw new Error(
      `两次尝试都未能生成合法的世界定义。首次问题：${firstProblem || '未知'}；重试问题：${errText(err)}`,
    );
  }
}
