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

const SPECIES = ['青鹿', '猎手', '尖牙狼'];
const DIGEST = '【世界】测试世界\n【Top5 物种】青鹿 500 只；猎手 80 只；尖牙狼 30 只';

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

describe('requestStewardPlan — 规则项清洗与钳制', () => {
  it('clamp 越界值、无效 key 丢弃、字符串数字转换、无变化项过滤、同 key 去重取最后', async () => {
    const raw = JSON.stringify({
      summary: '提高突变并开启灾变',
      actions: [
        { type: 'rule', key: 'mutationRate', value: 0.9, reason: '越界值应被钳到 0.6' },
        { type: 'rule', key: 'mutationRate', value: 0.45, reason: '重复 key 以最后一次为准' },
        { type: 'rule', key: 'unknownThing', value: 1, reason: '无效 key 应被丢弃' },
        { type: 'rule', key: 'foodRegrow', value: '0.03', reason: '字符串数字应被转换' },
        { type: 'rule', key: 'sexualReproduction', value: true, reason: '与当前值相同应被过滤' },
        { type: 'rule', key: 'disastersSeverity', value: 0.02, reason: '低于下限应被钳到 0.1' },
        { type: 'rule', key: 'maxPopulation', value: 4321, reason: '数值项应按步进取整' },
      ],
    });
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(raw)));

    const plan = await requestStewardPlan(DIGEST, CURRENT, '让世界热闹一点', settings, SPECIES);

    expect(plan.summary).toBe('提高突变并开启灾变');
    expect(plan.miracles).toEqual([]);
    const byKey = Object.fromEntries(plan.rules.map((c) => [c.key, c.value]));
    expect(byKey.mutationRate).toBe(0.45);
    expect(byKey.foodRegrow).toBe(0.03);
    expect(byKey.disastersSeverity).toBe(0.1);
    expect(byKey.maxPopulation).toBe(4300);
    expect(byKey.sexualReproduction).toBeUndefined();
    expect('unknownThing' in byKey).toBe(false);
    expect(plan.rules.map((c) => c.key)).toEqual([
      'mutationRate',
      'foodRegrow',
      'disastersSeverity',
      'maxPopulation',
    ]);
    const mr = plan.rules.find((c) => c.key === 'mutationRate');
    expect(mr?.reason).toBe('重复 key 以最后一次为准');
  });

  it('全部规则项都无效/无变化 → rules 与 miracles 均为空', async () => {
    const raw = JSON.stringify({
      summary: '现有规则已满足',
      actions: [
        { type: 'rule', key: 'mutationRate', value: 0.2, reason: '与当前一致' },
        { type: 'rule', key: 'nope', value: 1, reason: '无效' },
      ],
    });
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(raw)));

    const plan = await requestStewardPlan(DIGEST, CURRENT, '保持现状', settings, SPECIES);

    expect(plan.summary).toBe('现有规则已满足');
    expect(plan.rules).toEqual([]);
    expect(plan.miracles).toEqual([]);
  });
});

describe('requestStewardPlan — 神迹项清洗', () => {
  it('target 校验、radius/power 钳制、字符串数字、smite 上限 0.5、无效目标丢弃', async () => {
    const raw = JSON.stringify({
      summary: '帮青鹿、削尖牙狼',
      actions: [
        { type: 'miracle', kind: 'bloom', target: '青鹿', radius: 15, power: 5, reason: '投喂青鹿' },
        { type: 'miracle', kind: 'smite', target: '尖牙狼', radius: 999, power: 0.9, reason: '比例与半径都应被钳制' },
        { type: 'miracle', kind: 'bless', target: '灭绝种', radius: 10, reason: '不在现存列表应被丢弃' },
        { type: 'miracle', kind: 'bloom', target: '猎手', radius: '30', power: '2', reason: '字符串数字应被转换' },
        { type: 'miracle', kind: 'bloom', target: '青鹿', radius: 25, power: 4, reason: '同 kind+target 去重取最后' },
      ],
    });
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(raw)));

    const plan = await requestStewardPlan(DIGEST, CURRENT, '平衡世界', settings, SPECIES);

    expect(plan.summary).toBe('帮青鹿、削尖牙狼');
    expect(plan.rules).toEqual([]);
    // 同 (kind,target) 去重取最后
    expect(plan.miracles).toHaveLength(3);
    const bloomDeer = plan.miracles.find((m) => m.kind === 'bloom' && m.target === '青鹿');
    expect(bloomDeer?.radius).toBe(25);
    expect(bloomDeer?.power).toBe(4);
    const smite = plan.miracles.find((m) => m.kind === 'smite');
    expect(smite?.radius).toBe(60); // 钳到上限
    expect(smite?.power).toBe(0.5); // 钳到上限
    const bloomHunter = plan.miracles.find((m) => m.target === '猎手');
    expect(bloomHunter?.radius).toBe(30);
    expect(bloomHunter?.power).toBe(2);
  });

  it('bless 神迹缺省 power 不报错（power 记 0），半径缺省 20', async () => {
    const raw = JSON.stringify({
      summary: '救饥荒',
      actions: [{ type: 'miracle', kind: 'bless', target: '青鹿', reason: '丰饶拯救' }],
    });
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(raw)));

    const plan = await requestStewardPlan(DIGEST, CURRENT, '救救青鹿', settings, SPECIES);

    expect(plan.miracles).toHaveLength(1);
    expect(plan.miracles[0].kind).toBe('bless');
    expect(plan.miracles[0].power).toBe(0);
    expect(plan.miracles[0].radius).toBe(20);
  });

  it('speciesNames 为空集时神迹项全部丢弃，规则项不受影响', async () => {
    const raw = JSON.stringify({
      summary: '混合',
      actions: [
        { type: 'miracle', kind: 'bloom', target: '青鹿', radius: 10, reason: 'x' },
        { type: 'rule', key: 'mutationRate', value: 0.3, reason: 'r' },
      ],
    });
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(raw)));

    const plan = await requestStewardPlan(DIGEST, CURRENT, 'x', settings, []);

    expect(plan.miracles).toEqual([]);
    expect(plan.rules).toEqual([{ key: 'mutationRate', value: 0.3, reason: 'r' }]);
  });
});

describe('requestStewardPlan — 请求形状与重试', () => {
  it('请求打到 chat/completions，system 说明两类动作，user 含摘要/规则/需求', async () => {
    const raw = JSON.stringify({ summary: 'ok', actions: [] });
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => okResponse(raw));
    vi.stubGlobal('fetch', fetchMock);

    await requestStewardPlan(DIGEST, CURRENT, '把猎手削弱些', settings, SPECIES);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://fake.example/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('test-model');
    expect(body.messages[0].content).toContain('世界管家');
    expect(body.messages[0].content).toContain('smite');
    const userMsg: string = body.messages[1].content;
    expect(userMsg).toContain('【世界摘要】');
    expect(userMsg).toContain(DIGEST);
    expect(userMsg).toContain('【当前规则】');
    expect(userMsg).toContain('【玩家需求】把猎手削弱些');
  });

  it('首次输出非法 JSON → 反馈问题重试一次后成功', async () => {
    const raw = JSON.stringify({
      summary: 'ok',
      actions: [
        { type: 'miracle', kind: 'smite', target: '尖牙狼', radius: 20, power: 0.2, reason: 'r' },
      ],
    });
    const fetchMock = vi
      .fn(async (_url: string | URL, _init?: RequestInit) => okResponse(raw))
      .mockResolvedValueOnce(okResponse('这是方案：{"summary": 缺引号}'));
    vi.stubGlobal('fetch', fetchMock);

    const plan = await requestStewardPlan(DIGEST, CURRENT, 'x', settings, SPECIES);

    expect(plan.miracles).toHaveLength(1);
    expect(plan.miracles[0].target).toBe('尖牙狼');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body2 = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    const userMsg: string = body2.messages[1].content;
    expect(userMsg).toContain('问题');
    expect(userMsg).toContain('不是合法 JSON');
  });

  it('结构校验失败（actions 不是数组）→ 重试一次', async () => {
    const raw = JSON.stringify({ summary: 'ok', actions: [] });
    const fetchMock = vi
      .fn(async (_url: string | URL, _init?: RequestInit) => okResponse(raw))
      .mockResolvedValueOnce(okResponse(JSON.stringify({ summary: 'ok', actions: '不是数组' })));
    vi.stubGlobal('fetch', fetchMock);

    const plan = await requestStewardPlan(DIGEST, CURRENT, 'x', settings, SPECIES);

    expect(plan.summary).toBe('ok');
    expect(plan.rules).toEqual([]);
    expect(plan.miracles).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('HTTP 500 → 抛出带状态码的中文错误，不做无意义重试', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errResponse(500)));

    await expect(requestStewardPlan(DIGEST, CURRENT, 'x', settings, SPECIES)).rejects.toThrow('HTTP 500');
  });

  it('两次都失败 → 抛出含两次原因的中文错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse('完全没有 JSON 的回答')),
    );

    await expect(requestStewardPlan(DIGEST, CURRENT, 'x', settings, SPECIES)).rejects.toThrow(
      /两次尝试都未能生成合法的干预方案/,
    );
  });
});
