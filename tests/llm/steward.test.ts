import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestStewardPlan, type StewardRules } from '../../src/llm/steward';
import type { LlmSettings } from '../../src/llm/types';

const settings: LlmSettings = {
  baseURL: 'https://fake.example/v1/',
  apiKey: 'test-key',
  model: 'test-model',
};

/** 当前规则 fixture（与规则面板默认量级一致） */
const CURRENT: StewardRules = {
  mutationRate: 0.2,
  foodRegrow: 0.006,
  maxPopulation: 3000,
  sexualReproduction: true,
  disasters: { enabled: false, severity: 0.5 },
};

const DIGEST = '【世界】测试世界\n【当前】第 1,000 tick，种群 800';

function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

function errResponse(status: number) {
  return {
    ok: false,
    status,
    statusText: 'Error',
    text: async () => `server error ${status}`,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestStewardPlan — 清洗与钳制', () => {
  it('合法方案：clamp 越界值、无效 key 丢弃、字符串数字转换、无变化项过滤、同 key 去重取最后', async () => {
    const raw = JSON.stringify({
      summary: '提高突变并开启灾变',
      changes: [
        { key: 'mutationRate', value: 0.9, reason: '越界值应被钳到 0.6' },
        { key: 'mutationRate', value: 0.45, reason: '重复 key 以最后一次为准' },
        { key: 'unknownThing', value: 1, reason: '无效 key 应被丢弃' },
        { key: 'foodRegrow', value: '0.03', reason: '字符串数字应被转换' },
        { key: 'sexualReproduction', value: true, reason: '与当前值相同应被过滤' },
        { key: 'disastersEnabled', value: true, reason: '开启灾变' },
        { key: 'disastersSeverity', value: 0.02, reason: '低于下限应被钳到 0.1' },
        { key: 'maxPopulation', value: 4321, reason: '数值项应按步进取整' },
      ],
    });
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(raw)));

    const plan = await requestStewardPlan(DIGEST, CURRENT, '让世界热闹一点', settings);

    expect(plan.summary).toBe('提高突变并开启灾变');
    const byKey = Object.fromEntries(plan.changes.map((c) => [c.key, c.value]));
    expect(byKey.mutationRate).toBe(0.45); // 去重取最后
    expect(byKey.foodRegrow).toBe(0.03); // 字符串转换
    expect(byKey.disastersEnabled).toBe(true);
    expect(byKey.disastersSeverity).toBe(0.1); // clamp 下限
    expect(byKey.maxPopulation).toBe(4300); // 按 step=100 取整
    expect(byKey.sexualReproduction).toBeUndefined(); // 与当前相同 → 过滤
    expect('unknownThing' in byKey).toBe(false);
    // 顺序 = 首次出现序
    expect(plan.changes.map((c) => c.key)).toEqual([
      'mutationRate',
      'foodRegrow',
      'disastersEnabled',
      'disastersSeverity',
      'maxPopulation',
    ]);
    // 理由跟随去重后的最后一条
    const mr = plan.changes.find((c) => c.key === 'mutationRate');
    expect(mr?.reason).toBe('重复 key 以最后一次为准');
  });

  it('全部项都无效/无变化 → changes 为空数组（UI 显示「暂不建议调整」）', async () => {
    const raw = JSON.stringify({
      summary: '现有规则已满足',
      changes: [
        { key: 'mutationRate', value: 0.2, reason: '与当前一致' },
        { key: 'nope', value: 1, reason: '无效' },
      ],
    });
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(raw)));

    const plan = await requestStewardPlan(DIGEST, CURRENT, '保持现状', settings);

    expect(plan.summary).toBe('现有规则已满足');
    expect(plan.changes).toEqual([]);
  });
});

describe('requestStewardPlan — 请求形状与重试', () => {
  it('请求打到 chat/completions，user 消息包含摘要/当前规则/需求', async () => {
    const raw = JSON.stringify({ summary: 'ok', changes: [] });
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => okResponse(raw));
    vi.stubGlobal('fetch', fetchMock);

    await requestStewardPlan(DIGEST, CURRENT, '把猎手削弱些', settings);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://fake.example/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('test-model');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('世界管家');
    const userMsg: string = body.messages[1].content;
    expect(userMsg).toContain('【世界摘要】');
    expect(userMsg).toContain(DIGEST);
    expect(userMsg).toContain('【当前规则】');
    expect(userMsg).toContain('mutationRate');
    expect(userMsg).toContain('20%'); // 当前值
    expect(userMsg).toContain('【玩家需求】把猎手削弱些');
  });

  it('首次输出非法 JSON → 反馈问题重试一次后成功', async () => {
    const raw = JSON.stringify({ summary: 'ok', changes: [{ key: 'mutationRate', value: 0.5, reason: 'r' }] });
    const fetchMock = vi
      .fn(async (_url: string | URL, _init?: RequestInit) => okResponse(raw))
      .mockResolvedValueOnce(okResponse('这是方案：{"summary": 缺引号}'));
    vi.stubGlobal('fetch', fetchMock);

    const plan = await requestStewardPlan(DIGEST, CURRENT, 'x', settings);

    expect(plan.changes).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body2 = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    const userMsg: string = body2.messages[1].content;
    expect(userMsg).toContain('问题');
    expect(userMsg).toContain('不是合法 JSON');
  });

  it('结构校验失败（changes 不是数组）→ 重试一次', async () => {
    const raw = JSON.stringify({ summary: 'ok', changes: [] });
    const fetchMock = vi
      .fn(async (_url: string | URL, _init?: RequestInit) => okResponse(raw))
      .mockResolvedValueOnce(okResponse(JSON.stringify({ summary: 'ok', changes: '不是数组' })));
    vi.stubGlobal('fetch', fetchMock);

    const plan = await requestStewardPlan(DIGEST, CURRENT, 'x', settings);

    expect(plan.changes).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('HTTP 500 → 抛出带状态码的中文错误，不做无意义重试', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errResponse(500)));

    await expect(requestStewardPlan(DIGEST, CURRENT, 'x', settings)).rejects.toThrow('HTTP 500');
  });

  it('两次都失败 → 抛出含两次原因的中文错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse('完全没有 JSON 的回答')),
    );

    await expect(requestStewardPlan(DIGEST, CURRENT, 'x', settings)).rejects.toThrow(
      /两次尝试都未能生成合法的调整方案/,
    );
  });
});
