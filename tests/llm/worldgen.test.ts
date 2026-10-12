import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractFirstJson } from '../../src/llm/provider';
import { generateWorldSpec } from '../../src/llm/worldgen';
import type { LlmSettings } from '../../src/llm/types';
import { worldSpecSchema } from '../../src/engine/specSchema';

const settings: LlmSettings = {
  baseURL: 'https://fake.example/v1/',
  apiKey: 'test-key',
  model: 'test-model',
};

/** 构造一个 OpenAI 兼容的成功响应 */
function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

/** 构造一个非 2xx 响应 */
function errResponse(status: number) {
  return {
    ok: false,
    status,
    statusText: 'Error',
    text: async () => `server error ${status}`,
  };
}

/** 一份能通过 worldSpecSchema 的完整世界定义 */
const VALID_SPEC_JSON = JSON.stringify({
  name: '熔岩荒野',
  width: 200,
  height: 200,
  food: { maxPerCell: 8, regrow: 0.006 },
  terrain: { obstacleRatio: 0.05, hazardRatio: 0.12 },
  species: [
    { name: '耐熔者', color: '#f59e0b', count: 120, genome: { speed: 0.5, aggression: 0.1, sociability: 0.5 } },
    { name: '熔岩猎手', color: '#dc2626', count: 15, genome: { speed: 1.2, size: 1.6, aggression: 0.95, fear: 0 } },
  ],
  rules: { mutationRate: 0.25, maxPopulation: 1500 },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractFirstJson', () => {
  it('提取裸 JSON、剥离 ```json 围栏、找不到时返回 null', () => {
    expect(extractFirstJson('前缀 {"a":1} 后缀')).toBe('{"a":1}');
    expect(extractFirstJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractFirstJson('没有任何大括号的文本')).toBeNull();
  });
});

describe('worldSpecSchema', () => {
  it('接受全可选的最小输出，拒绝越界数值、非法颜色与超量物种', () => {
    expect(worldSpecSchema.safeParse({}).success).toBe(true);
    expect(worldSpecSchema.safeParse({ width: 999 }).success).toBe(false);
    expect(worldSpecSchema.safeParse({ food: { maxPerCell: 100 } }).success).toBe(false);
    expect(worldSpecSchema.safeParse({ rules: { mutationRate: 0.9 } }).success).toBe(false);
    expect(worldSpecSchema.safeParse({ species: [{ color: 'red' }] }).success).toBe(false);
    expect(worldSpecSchema.safeParse({ species: Array.from({ length: 7 }, () => ({})) }).success).toBe(false);
  });
});

describe('generateWorldSpec', () => {
  it('LLM 返回合法 JSON → 生成完整 spec（source=llm），请求打到 chat/completions', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => okResponse(VALID_SPEC_JSON));
    vi.stubGlobal('fetch', fetchMock);

    const { spec, source } = await generateWorldSpec('炎热的世界，有猎手', settings, 42);

    expect(source).toBe('llm');
    expect(spec.name).toBe('熔岩荒野');
    expect(spec.seed).toBe(42); // normalizeSpec 用传入 seed 覆盖
    expect(spec.width).toBe(200);
    expect(spec.food.maxPerCell).toBe(8);
    expect(spec.terrain.hazardRatio).toBe(0.12);
    expect(spec.rules.maxPopulation).toBe(1500);
    expect(spec.species.map((s) => s.name)).toEqual(['耐熔者', '熔岩猎手']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://fake.example/v1/chat/completions'); // 末尾斜杠被去掉
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('test-model');
    expect(body.temperature).toBe(0.8);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].content).toContain('炎热的世界，有猎手');
  });

  it('首次输出非法 JSON → 把问题反馈给模型重试一次后成功', async () => {
    const fetchMock = vi
      .fn(async (_url: string | URL, _init?: RequestInit) => okResponse(VALID_SPEC_JSON))
      .mockResolvedValueOnce(okResponse('好的，这是定义：{"name": "残缺世界", "width": NaN}'));
    vi.stubGlobal('fetch', fetchMock);

    const { spec, source } = await generateWorldSpec('随便生成一个世界', settings, 7);

    expect(source).toBe('llm');
    expect(spec.name).toBe('熔岩荒野');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const body2 = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    const userMsg: string = body2.messages[1].content;
    expect(userMsg).toContain('问题'); // 第二次 user 消息说明上次输出的问题
    expect(userMsg).toContain('不是合法 JSON'); // 并包含具体原因
  });

  it('持续失败（HTTP 500）→ 抛出带状态码的中文错误，且不做无意义重试', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => errResponse(500));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateWorldSpec('任何描述', settings, 1)).rejects.toThrow('HTTP 500');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('响应带 ```json 围栏 → 能正常解析', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, _init?: RequestInit) => okResponse('```json\n' + VALID_SPEC_JSON + '\n```')),
    );

    const { spec, source } = await generateWorldSpec('围栏测试', settings, 9);

    expect(source).toBe('llm');
    expect(spec.name).toBe('熔岩荒野');
  });

  it('服务端拒绝 response_format（400）→ 去掉该字段重试一次', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { response_format?: unknown };
      if (body.response_format !== undefined) return errResponse(400);
      return okResponse(VALID_SPEC_JSON);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { source } = await generateWorldSpec('测试', settings, 5);

    expect(source).toBe('llm');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
