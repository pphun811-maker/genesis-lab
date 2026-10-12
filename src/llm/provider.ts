import type { LlmSettings } from './types';

/**
 * OpenAI 兼容 chat/completions 客户端（最朴素的一层封装）：
 * - 15 秒超时（AbortController）；
 * - 非 2xx 抛出带状态码的中文错误（LlmHttpError）；
 * - 优先携带 response_format: { type: 'json_object' }，若服务端以 400 拒绝则去掉该字段重试一次；
 * - 从返回文本中提取 JSON 字符串（剥掉 ```json 围栏，取第一个 { 到最后一个 }）。
 */

/** 请求超时（毫秒） */
const TIMEOUT_MS = 15_000;

/** 携带 HTTP 状态码的错误，便于上层区分「服务端拒绝」与「模型输出不合法」 */
export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LlmHttpError';
  }
}

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

/**
 * 从模型返回文本中提取第一段 JSON：
 * 先剥掉可能的 ```json 围栏标记，再取第一个 { 到最后一个 } 之间的内容。
 * 找不到时返回 null。
 */
export function extractFirstJson(text: string): string | null {
  const cleaned = text.replace(/```[a-zA-Z0-9_-]*/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return cleaned.slice(start, end + 1);
}

/** 发起一次 chat/completions 请求并返回解析后的响应体（超时 / 网络 / 非 2xx 均抛中文错误） */
async function requestChatCompletion(
  settings: LlmSettings,
  body: Record<string, unknown>,
): Promise<ChatCompletionResponse> {
  const url = `${settings.baseURL.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(`请求语言模型超时（${TIMEOUT_MS / 1000} 秒），请检查网络或 baseURL。`);
      }
      throw new Error(`网络请求失败：${errText(err)}`);
    }

    if (!res.ok) {
      const detail = await res
        .text()
        .then((t) => t.slice(0, 300))
        .catch(() => '');
      throw new LlmHttpError(
        res.status,
        `语言模型服务返回 HTTP ${res.status}：${detail || res.statusText || '请求被拒绝'}`,
      );
    }

    try {
      return (await res.json()) as ChatCompletionResponse;
    } catch {
      throw new Error('语言模型服务的响应体不是合法 JSON。');
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 发起一次要求 JSON 输出的对话，返回提取出的 JSON 字符串。
 *
 * 请求体固定包含 model / messages（system + user）/ temperature: 0.8，
 * 并优先附加 response_format: { type: 'json_object' }；若服务端返回 400
 * （通常是不支持该字段），去掉它重试一次。
 *
 * 找不到 JSON、内容为空或请求失败时抛出中文错误（LlmHttpError 表示 HTTP 层失败）。
 */
export async function chatJson(settings: LlmSettings, system: string, user: string): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const baseBody: Record<string, unknown> = { model: settings.model, messages, temperature: 0.8 };

  let data: ChatCompletionResponse;
  try {
    data = await requestChatCompletion(settings, { ...baseBody, response_format: { type: 'json_object' } });
  } catch (err) {
    if (!(err instanceof LlmHttpError) || err.status !== 400) throw err;
    // 部分兼容服务不支持 response_format，去掉该字段重试一次
    data = await requestChatCompletion(settings, baseBody);
  }

  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('语言模型返回的内容为空。');
  }
  const json = extractFirstJson(content);
  if (json === null) {
    throw new Error('语言模型返回的内容中未找到 JSON。');
  }
  return json;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** 请求耗时（毫秒，含失败请求） */
  latencyMs: number;
  model?: string;
  error?: string;
}

/**
 * 测试连接：发送一次 max_tokens=1 的最小补全请求（成本约 1 个 token）。
 * 不抛错——结果以 { ok, error } 表达；部分服务拒绝 max_tokens 时（400）去掉重试一次。
 */
export async function testConnection(settings: LlmSettings): Promise<ConnectionTestResult> {
  const start = performance.now();
  const finish = (r: Omit<ConnectionTestResult, 'latencyMs'>): ConnectionTestResult => ({
    ...r,
    latencyMs: Math.round(performance.now() - start),
  });
  try {
    if (!settings.baseURL.trim()) return finish({ ok: false, error: '未填写 API 地址（baseURL）' });
    if (!settings.model.trim()) return finish({ ok: false, error: '未填写模型名称' });
    if (!settings.apiKey.trim()) return finish({ ok: false, error: '未填写 API Key' });
    const body: Record<string, unknown> = {
      model: settings.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    };
    try {
      await requestChatCompletion(settings, body);
    } catch (err) {
      if (!(err instanceof LlmHttpError) || err.status !== 400) throw err;
      // 个别服务不认 max_tokens：去掉该字段重试一次
      await requestChatCompletion(settings, { model: settings.model, messages: body.messages });
    }
    return finish({ ok: true, model: settings.model });
  } catch (err) {
    return finish({ ok: false, error: errText(err) });
  }
}
