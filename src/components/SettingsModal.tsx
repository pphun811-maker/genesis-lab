import { useEffect, useRef, useState } from 'react';
import { getSetting, setSetting } from '../persistence/db';
import type { LlmSettings } from '../llm/types';
import { testConnection, type ConnectionTestResult } from '../llm/provider';
import {
  getSessionCallCount,
  loadObserverPrefs,
  saveObserverPrefs,
  type ObserverAutoMode,
} from '../llm/observer';

const DEFAULTS: LlmSettings = {
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: '',
  model: 'GLM-4-Flash-250414',
};

/** 厂商预设：一键填充 baseURL + 模型（Key 保留不动） */
const PROVIDER_PRESETS: Array<{ label: string; baseURL: string; model: string }> = [
  {
    label: 'GLM-4-Flash-250414（免费）',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'GLM-4-Flash-250414',
  },
  {
    label: 'GLM-5.6-Flash',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'GLM-5.6-Flash',
  },
  {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-flash',
  },
];

/** AI 说书人自动解说频率（与 NarratorBar 的 localStorage 偏好一致） */
const AUTO_OPTIONS: Array<{ value: ObserverAutoMode; label: string }> = [
  { value: 'off', label: '仅手动' },
  { value: '30', label: '每 30 秒' },
  { value: '60', label: '每 60 秒' },
];

export const LLM_SETTING_KEY = 'llm';

export async function loadLlmSettings(): Promise<LlmSettings | null> {
  try {
    const saved = await getSetting<LlmSettings>(LLM_SETTING_KEY);
    if (saved && saved.apiKey && saved.baseURL && saved.model) return saved;
    return null;
  } catch {
    return null;
  }
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [draft, setDraft] = useState<LlmSettings>(DEFAULTS);
  // AI 观察员：auto 频率点击即写入 localStorage 立即生效；调用计数低频刷新展示
  const [autoMode, setAutoMode] = useState<ObserverAutoMode>('off');
  const [callCount, setCallCount] = useState(0);
  // 测试连接：用当前草稿（含未保存的修改）发一次 max_tokens=1 的最小请求
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  // 蒙层关闭守卫：只有「按下与松开都在蒙层上」才关闭——否则面板内拖动全选文本、
  // 松手落在蒙层时会误触发 click 关掉整个弹窗
  const backdropPressed = useRef(false);

  useEffect(() => {
    loadLlmSettings().then((s) => s && setDraft(s));
    setAutoMode(loadObserverPrefs().auto);
    setCallCount(getSessionCallCount());
    const t = setInterval(() => setCallCount(getSessionCallCount()), 1000);
    return () => clearInterval(t);
  }, []);

  const applyAutoMode = (mode: ObserverAutoMode): void => {
    setAutoMode(mode);
    saveObserverPrefs({ auto: mode });
  };

  const runTest = (): void => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    void testConnection(draft).then((r) => {
      setTestResult(r);
      setTesting(false);
    });
  };

  const save = (): void => {
    setSetting(LLM_SETTING_KEY, draft)
      .then(onClose)
      .catch((err) => alert('保存设置失败: ' + err));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        backdropPressed.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (backdropPressed.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-[440px] rounded-2xl border border-lab-border bg-lab-panel p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-base font-medium">AI 创世设置</h2>
        <p className="mb-4 text-xs leading-5 text-lab-muted">
          配置任意 OpenAI 兼容接口（GLM / DeepSeek / OpenAI 等）。密钥仅保存在你的浏览器本地。
          不配置也能用——自然语言创建会退回到内置规则解析。还没有 Key？
          <a
            href="https://open.bigmodel.cn/"
            target="_blank"
            rel="noreferrer"
            className="text-lab-accent underline decoration-dotted hover:opacity-80"
          >
            免费注册智谱开放平台 ↗
          </a>
          （GLM-4-Flash-250414 免费）。
        </p>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {PROVIDER_PRESETS.map((p) => (
            <button
              key={p.model}
              onClick={() => setDraft((d) => ({ ...d, baseURL: p.baseURL, model: p.model }))}
              title={`${p.baseURL} · ${p.model}`}
              className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                draft.baseURL === p.baseURL && draft.model === p.model
                  ? 'border-lab-accent bg-lab-accent/15 text-lab-accent'
                  : 'border-lab-border text-lab-muted hover:border-lab-accent/50 hover:text-lab-text'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-lab-muted">API 地址（baseURL）</span>
            <input
              value={draft.baseURL}
              onChange={(e) => setDraft((d) => ({ ...d, baseURL: e.target.value }))}
              className="w-full rounded-lg border border-lab-border bg-[#0d121b] px-3 py-2 font-mono text-xs outline-none focus:border-lab-accent"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-lab-muted">API Key</span>
            <input
              type="password"
              value={draft.apiKey}
              onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
              placeholder="sk-..."
              className="w-full rounded-lg border border-lab-border bg-[#0d121b] px-3 py-2 font-mono text-xs outline-none focus:border-lab-accent"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-lab-muted">模型</span>
            <input
              value={draft.model}
              onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
              className="w-full rounded-lg border border-lab-border bg-[#0d121b] px-3 py-2 font-mono text-xs outline-none focus:border-lab-accent"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={runTest}
              disabled={testing}
              className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                testing
                  ? 'cursor-wait border-lab-border text-lab-muted'
                  : 'border-lab-border text-lab-muted hover:border-lab-accent hover:text-lab-text'
              }`}
            >
              {testing ? '测试中…' : '⚡ 测试连接'}
            </button>
            {testResult && (
              <span
                className={`min-w-0 flex-1 text-xs leading-4 ${
                  testResult.ok ? 'text-[#34d399]' : 'text-[#f87171]'
                }`}
              >
                {testResult.ok
                  ? `连接成功 · ${testResult.latencyMs}ms · ${testResult.model}`
                  : `连接失败（${testResult.latencyMs}ms）：${testResult.error}`}
              </span>
            )}
          </div>
        </div>
        {/* AI 观察员（世界之声） */}
        <div className="mt-5 border-t border-lab-border pt-4">
          <h3 className="mb-1 text-sm font-medium">AI 观察员</h3>
          <p className="mb-3 text-xs leading-5 text-lab-muted">
            「世界之声」会在观察舱画布底部持续解说世界。每次调用约 1k
            token，建议使用免费或廉价模型（如 glm-4-flash）。数据为世界摘要，不含任何个人数据。
          </p>
          <span className="mb-1 block text-xs text-lab-muted">AI 说书人（实验性）</span>
          <div className="flex gap-1">
            {AUTO_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => applyAutoMode(opt.value)}
                className={`flex-1 rounded-lg border px-2 py-1.5 text-xs transition-colors ${
                  autoMode === opt.value
                    ? 'border-lab-accent bg-lab-accent/15 text-lab-accent'
                    : 'border-lab-border text-lab-muted hover:text-lab-text'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-lab-muted">
            本会话已调用 AI <span className="font-mono text-lab-text">{callCount.toLocaleString()}</span> 次。
          </p>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-lab-border px-4 py-2 text-sm text-lab-muted hover:text-lab-text"
          >
            取消
          </button>
          <button
            onClick={save}
            className="rounded-lg bg-lab-accent px-4 py-2 text-sm text-lab-bg hover:bg-lab-accent-dim"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
