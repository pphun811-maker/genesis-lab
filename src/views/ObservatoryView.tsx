import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { simManager } from '../client/simManager';
import type { FrameData } from '../client/protocol';
import type { Agent } from '../engine/types';
import { serializeExperiment } from '../persistence/serialize';
import { Camera } from '../render/camera';
import { WorldRenderer, type OverlayMode } from '../render/renderer';
import { useExperiments } from '../store/experiments';
import { MetricCharts } from '../components/MetricCharts';
import { PhyloTree } from '../components/PhyloTree';
import { PlaybackBar } from '../components/PlaybackBar';
import { GuideOverlay, dismissGuide, shouldShowGuide } from '../components/GuideOverlay';
import { WorldPulse } from '../components/WorldPulse';
import { NarratorBar } from '../components/NarratorBar';
import { MiraclesPanel } from '../components/MiraclesPanel';
import { AgentInspector, EventFeed, RulesPanel, SpeciesPanel, type RulesPatch } from '../components/panels';

type Tab = 'metrics' | 'species' | 'phylo' | 'agent' | 'events' | 'rules';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'metrics', label: '指标' },
  { id: 'species', label: '物种' },
  { id: 'phylo', label: '谱系' },
  { id: 'agent', label: '个体' },
  { id: 'events', label: '事件' },
  { id: 'rules', label: '规则' },
];

interface Stats {
  tick: number;
  pop: number;
  species: number;
  running: boolean;
}

/** 画布悬停提示信息（屏幕坐标 + 命中个体摘要） */
interface HoverInfo {
  sx: number;
  sy: number;
  id: number;
  speciesName: string;
  color: string;
  energy01: number;
  size: number;
  speciesId: number;
}

/** 地形图例（与 renderer 底图用色一致） */
const TERRAIN_LEGEND: Array<{ color: string; label: string }> = [
  { color: '#4ade80', label: '食物' },
  { color: '#363c48', label: '障碍' },
  { color: '#762a28', label: '危险区' },
  { color: '#1c6e62', label: '淡水（青绿）' },
  { color: '#0d2b46', label: '海洋（藏蓝）' },
  { color: '#2f5b7c', label: '浅滩/湖岸' },
];

/** 热力叠加切换项（对应渲染器 OverlayMode） */
const OVERLAY_MODES: Array<{ id: OverlayMode; label: string }> = [
  { id: 'off', label: '关' },
  { id: 'population', label: '密度' },
  { id: 'deaths', label: '死亡' },
];

/** 侧边栏宽度（可拖拽调宽，持久化到 localStorage） */
const SIDEBAR_WIDTH_KEY = 'gl-sidebar-width-v1';
const SIDEBAR_WIDTH_DEFAULT = 420;
const SIDEBAR_WIDTH_MIN = 300;
const SIDEBAR_WIDTH_MAX = 720;

function clampSidebarWidth(v: number): number {
  if (!Number.isFinite(v)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(v)));
}

function loadSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw === null || raw.trim() === '') return SIDEBAR_WIDTH_DEFAULT;
    return clampSidebarWidth(Number(raw));
  } catch {
    // localStorage 不可用（隐私模式等）时回退默认宽度
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

export function ObservatoryView() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const record = useExperiments((s) => s.records[id]);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camRef = useRef(new Camera());
  const rendererRef = useRef<WorldRenderer | null>(null);
  const worldDataDone = useRef(false);
  const selectedRef = useRef<number | null>(null);

  const [tab, setTab] = useState<Tab>('metrics');
  const [stats, setStats] = useState<Stats>({ tick: 0, pop: 0, species: 0, running: false });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [agentSpecies, setAgentSpecies] = useState<string | undefined>();
  const [agentSpeciesTags, setAgentSpeciesTags] = useState<string[] | undefined>();
  const [agentSpeciesNiche, setAgentSpeciesNiche] = useState<string | undefined>();
  const [follow, setFollow] = useState(false);
  const [rules, setRules] = useState<RulesPatch | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [showMiracles, setShowMiracles] = useState(false);
  const [highlightSpeciesId, setHighlightSpeciesId] = useState<number | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  // 侧边栏宽度：初始值从 localStorage 读取（懒初始化，只读一次）
  const [sidebarWidth, setSidebarWidth] = useState<number>(loadSidebarWidth);
  const sidebarWidthRef = useRef(sidebarWidth);

  // 悬停拾取：指针位置 / 拖拽状态放在 ref，渲染循环每帧读取，不触发重渲
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const draggingRef = useRef(false);
  const lastHoverRef = useRef<HoverInfo | null>(null);
  // 渲染循环闭包随 [id] 装配，高亮 id 经 ref 同步进 loop，避免读到过期 state
  const highlightSpeciesIdRef = useRef<number | null>(null);

  // 热力叠加模式：经 ref 同步进渲染循环闭包，切换不触发重渲
  const [overlay, setOverlay] = useState<OverlayMode>('off');
  const overlayRef = useRef<OverlayMode>('off');

  useEffect(() => {
    highlightSpeciesIdRef.current = highlightSpeciesId;
  }, [highlightSpeciesId]);

  useEffect(() => {
    overlayRef.current = overlay;
  }, [overlay]);

  // 首次进入观察舱时展示指南（每台设备一次）
  useEffect(() => {
    if (shouldShowGuide()) setShowGuide(true);
  }, []);

  const closeGuide = (): void => {
    dismissGuide();
    setShowGuide(false);
  };

  // 每次进入视图：确保 Worker 存在
  useEffect(() => {
    if (!record) return;
    simManager.ensure(id, { spec: record.spec, snapshot: record.snapshot });
    setRules({
      mutationRate: record.spec.rules.mutationRate,
      foodRegrow: record.spec.food.regrow,
      maxPopulation: record.spec.rules.maxPopulation,
      sexualReproduction: record.spec.rules.sexualReproduction ?? false,
      disasters: record.spec.rules.disasters ?? { enabled: false, severity: 0.5 },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // 渲染循环 + 画布尺寸
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    // record 缺失时组件直接重定向，画布不存在，跳过装配
    if (!canvas || !container) return;
    const renderer = new WorldRenderer(canvas);
    rendererRef.current = renderer;
    worldDataDone.current = false;

    // dev 调试句柄
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__genesis = {
        cam: camRef.current,
        renderer,
        getClient: () => simManager.get(id),
      };
    }

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = (): void => {
      canvas.width = Math.round(container.clientWidth * dpr);
      canvas.height = Math.round(container.clientHeight * dpr);
      canvas.style.width = `${container.clientWidth}px`;
      canvas.style.height = `${container.clientHeight}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    const loop = (): void => {
      const client = simManager.get(id);
      const frame = client?.latestFrame;
      if (!frame) return;

      if (client.worldData && !worldDataDone.current) {
        const wd = client.worldData;
        renderer.setWorldData(wd.width, wd.height, wd.terrain, wd.fertility, wd.foodMaxPerCell);
        camRef.current.fit(container.clientWidth, container.clientHeight, wd.width, wd.height);
        worldDataDone.current = true;
      }
      if (frame.food) renderer.updateFood(frame.food);
      // 热力叠加：同步模式 + 喂入死亡热区（renderer 内部按 150ms 节流重建）
      renderer.setOverlay(overlayRef.current);
      if (frame.deathHeat) renderer.updateDeathHeat(frame.deathHeat);

      const cam = camRef.current;
      if (cam.followId !== null) {
        const sel = renderer.findById(frame, cam.followId);
        if (sel) cam.centerOn(sel[1], sel[2]);
      }
      renderer.render(frame, cam, container.clientWidth, container.clientHeight, dpr, selectedRef.current, highlightSpeciesIdRef.current);

      // 悬停拾取（每帧一次，代价低）：拖拽中不显示 tooltip
      const ptr = pointerRef.current;
      let nextHover: HoverInfo | null = null;
      if (ptr && !draggingRef.current) {
        const hit = renderer.pick(frame, cam, ptr.x, ptr.y, container.clientWidth, container.clientHeight, 10);
        if (hit !== null) {
          const a = renderer.findById(frame, hit);
          const sp = a ? frame.species[a[6] | 0] : undefined;
          if (a && sp) {
            nextHover = {
              sx: ptr.x,
              sy: ptr.y,
              id: hit,
              speciesName: sp.name,
              color: sp.color,
              energy01: a[5],
              size: a[4],
              speciesId: sp.id,
            };
          }
        }
      }
      // 仅在 (id, sx, sy) 变化时提交 state（坐标取整到 2px，减少重渲）
      const last = lastHoverRef.current;
      if (nextHover) {
        const q = { ...nextHover, sx: Math.round(nextHover.sx / 2) * 2, sy: Math.round(nextHover.sy / 2) * 2 };
        if (!last || last.id !== q.id || last.sx !== q.sx || last.sy !== q.sy) {
          lastHoverRef.current = q;
          setHover(q);
        }
      } else if (last) {
        lastHoverRef.current = null;
        setHover(null);
      }
    };

    let raf = 0;
    const rafLoop = (): void => {
      raf = requestAnimationFrame(rafLoop);
      loop();
    };
    raf = requestAnimationFrame(rafLoop);
    // 标签页被遮挡时 Chromium 会暂停 rAF；用低频定时器兜底，保证
    // 世界初始化与画面不因后台而冻结
    const keeper = setInterval(loop, 200);

    // 状态数字 4Hz 刷新
    const statsTimer = setInterval(() => {
      const client2 = simManager.get(id);
      const frame = client2?.latestFrame;
      setStats({
        tick: frame?.tick ?? 0,
        pop: frame?.pop ?? 0,
        species: frame ? frame.species.filter((s) => !s.extinct).length : 0,
        running: client2?.running ?? false,
      });
    }, 250);

    // 选中个体存活期间定期刷新检查器
    const inspectTimer = setInterval(async () => {
      const sid = selectedRef.current;
      if (sid === null) return;
      const client2 = simManager.get(id);
      if (!client2) return;
      const res = await client2.inspect(sid);
      if (res.agent) {
        setAgent(res.agent);
        setAgentSpecies(res.speciesName);
        setAgentSpeciesTags(res.speciesTags);
        setAgentSpeciesNiche(res.speciesNiche);
      }
      // 已死亡则只在暂停时清除（运行中下一帧自然找不到）
    }, 800);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(keeper);
      ro.disconnect();
      clearInterval(statsTimer);
      clearInterval(inspectTimer);
    };
  }, [id]);

  useEffect(() => {
    selectedRef.current = selectedId;
    if (selectedId === null) {
      camRef.current.followId = null;
      setFollow(false);
      setAgent(null);
      setAgentSpecies(undefined);
      setAgentSpeciesTags(undefined);
      setAgentSpeciesNiche(undefined);
    } else {
      const client = simManager.get(id);
      client?.inspect(selectedId).then((res) => {
        setAgent(res.agent);
        setAgentSpecies(res.speciesName);
        setAgentSpeciesTags(res.speciesTags);
        setAgentSpeciesNiche(res.speciesNiche);
      });
    }
  }, [selectedId, id]);

  const handlePlayPause = useCallback(() => {
    const client = simManager.get(id);
    if (!client) return;
    if (client.running) client.pause();
    else simManager.run(id);
  }, [id]);

  const handleFork = useCallback(async () => {
    const client = simManager.get(id);
    if (!client) return;
    const state = await client.snapshot();
    const forkId = useExperiments.getState().fork(id, state);
    simManager.ensure(forkId, { spec: state.spec, snapshot: state });
    navigate(`/exp/${forkId}`);
  }, [id, navigate]);

  const handleSpeed = useCallback(
    (multiplier: number) => {
      simManager.get(id)?.setTps(Math.round(multiplier * 60));
    },
    [id],
  );

  const handleStep = useCallback(
    (ticks: number) => {
      simManager.get(id)?.step(ticks);
    },
    [id],
  );

  const handleApplyRules = useCallback(
    (patch: RulesPatch, via?: string) => {
      // via 为干预来源前缀（如 '按 AI 建议'），仅影响事件流文案
      simManager.get(id)?.updateRules(patch, via);
      setRules(patch);
      setTab('events');
    },
    [id],
  );

  /** 侧栏拖拽把手：按住左右拖动调整宽度，拖拽中禁用文本选择，松开时持久化 */
  const handleSidebarResizeStart = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.clientX;
    const startWidth = sidebarWidthRef.current;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // 个别环境不支持指针捕获时退化为普通元素监听
    }
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: PointerEvent): void => {
      // 把手是右侧栏的左边缘：鼠标右移 = 把手右移 = 侧栏变窄。
      // 方向必须与鼠标一致（把手跟随鼠标），否则把手会朝反方向弹走。
      const width = clampSidebarWidth(startWidth - (ev.clientX - startX));
      sidebarWidthRef.current = width;
      setSidebarWidth(width);
    };
    const finish = (): void => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', finish);
      el.removeEventListener('pointercancel', finish);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidthRef.current));
      } catch {
        // 写入失败（隐私模式等）只影响下次的记忆宽度
      }
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
  };

  if (!record) return <Navigate to="/" replace />;

  // tooltip 越界翻转（估算尺寸：宽 ~160px、高 ~54px）
  const cw = containerRef.current?.clientWidth ?? 0;
  const chh = containerRef.current?.clientHeight ?? 0;
  const flipX = hover !== null && hover.sx + 174 > cw;
  const flipY = hover !== null && hover.sy + 68 > chh;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-3 border-b border-lab-border bg-lab-panel/85 px-4 py-2 backdrop-blur">
        <Link to="/" className="text-lab-muted transition-colors hover:text-lab-text" title="返回实验室">
          ←
        </Link>
        <span className="text-sm font-medium tracking-wide">{record.name}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            stats.running ? 'bg-lab-accent/15 text-lab-accent' : 'bg-lab-border text-lab-muted'
          }`}
        >
          {stats.running ? '运行中' : '已暂停'}
        </span>
        <button
          onClick={() => setShowGuide(true)}
          className="ml-auto rounded-full border border-lab-border px-2.5 py-0.5 text-xs text-lab-muted transition-colors hover:border-lab-accent hover:text-lab-accent"
          title="观察舱指南"
        >
          ？
        </button>
        <button
          onClick={() => void handleFork()}
          className="ml-2 rounded border border-lab-accent/40 bg-lab-accent/10 px-3 py-1 text-xs text-lab-accent transition-colors hover:bg-lab-accent/20"
          title={`从当前第 ${stats.tick} tick 复制出一个平行实验`}
        >
          ⑂ 分叉实验
        </button>
        <button
          onClick={() => setShowMiracles((v) => !v)}
          className={`ml-2 rounded border px-3 py-1 text-xs transition-colors ${
            showMiracles
              ? 'border-[#e879f9]/60 bg-[#e879f9]/15 text-[#e879f9]'
              : 'border-[#e879f9]/40 bg-[#e879f9]/10 text-[#e879f9] hover:bg-[#e879f9]/20'
          }`}
          title="降下神迹：雨露（撒食）/ 天罚（击杀）/ 丰饶（食物回满），以选中个体为中心"
        >
          ✦ 神迹
        </button>
        <button
          onClick={() => {
            const record = useExperiments.getState().records[id];
            if (!record) return;
            const blob = new Blob([serializeExperiment(record)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${record.name.replace(/[\\/:*?"<>|]/g, '_')}-t${record.lastTick}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
          className="rounded border border-lab-border px-3 py-1 text-xs text-lab-muted hover:text-lab-text"
          title="导出实验为 JSON 文件（含当前快照）"
        >
          ⤓ 导出
        </button>
        <button
          onClick={() => {
            const canvas = canvasRef.current!;
            camRef.current.fit(
              canvas.clientWidth,
              canvas.clientHeight,
              rendererRef.current?.worldW ?? camRef.current.worldW,
              rendererRef.current?.worldH ?? camRef.current.worldH,
            );
          }}
          className="rounded border border-lab-border px-3 py-1 text-xs text-lab-muted hover:text-lab-text"
        >
          适应世界
        </button>
      </div>

      {/* 主区：画布 + 侧栏 */}
      <div className="flex min-h-0 flex-1">
        <div ref={containerRef} className="relative min-w-0 flex-1 cursor-crosshair bg-black">
          <canvas
            ref={canvasRef}
            className="absolute inset-0"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              let lastX = e.clientX;
              let lastY = e.clientY;
              let moved = 0;
              const onMove = (ev: PointerEvent): void => {
                // 逐事件增量平移（按住 1:1 跟手）
                const dx = ev.clientX - lastX;
                const dy = ev.clientY - lastY;
                lastX = ev.clientX;
                lastY = ev.clientY;
                if (dx === 0 && dy === 0) return;
                moved += Math.abs(dx) + Math.abs(dy);
                if (moved >= 6 && !draggingRef.current) {
                  // 进入拖拽：隐藏悬停提示
                  draggingRef.current = true;
                  lastHoverRef.current = null;
                  setHover(null);
                }
                camRef.current.panBy(dx, dy);
              };
              const onUp = (ev: PointerEvent): void => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                draggingRef.current = false;
                if (moved < 6) {
                  const rect = canvasRef.current!.getBoundingClientRect();
                  const frame: FrameData | null = simManager.get(id)?.latestFrame ?? null;
                  if (!frame) return;
                  const hit = rendererRef.current?.pick(
                    frame,
                    camRef.current,
                    ev.clientX - rect.left,
                    ev.clientY - rect.top,
                    rect.width,
                    rect.height,
                    12,
                  );
                  setSelectedId(hit ?? null);
                  setTab(hit !== null ? 'agent' : tab);
                }
              };
              window.addEventListener('pointermove', onMove);
              window.addEventListener('pointerup', onUp);
            }}
            onPointerMove={(e) => {
              // 只写 ref，交给渲染循环每帧做拾取，不在这里 setState
              const rect = e.currentTarget.getBoundingClientRect();
              pointerRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            }}
            onPointerLeave={() => {
              pointerRef.current = null;
              lastHoverRef.current = null;
              setHover(null);
            }}
            onWheel={(e) => {
              e.preventDefault();
              const rect = canvasRef.current!.getBoundingClientRect();
              camRef.current.zoomAt(
                e.clientX - rect.left,
                e.clientY - rect.top,
                e.deltaY < 0 ? 1.15 : 1 / 1.15,
                rect.width,
                rect.height,
              );
            }}
          />
          {/* 悬停提示：跟随光标，越界时翻转 */}
          {hover && (
            <div
              className="pointer-events-none absolute z-20 rounded-md border border-lab-border bg-[#0d121b]/95 px-2.5 py-1.5 shadow-lg"
              style={{
                left: hover.sx + (flipX ? -14 : 14),
                top: hover.sy + (flipY ? -14 : 14),
                transform:
                  flipX && flipY
                    ? 'translate(-100%, -100%)'
                    : flipX
                      ? 'translateX(-100%)'
                      : flipY
                        ? 'translateY(-100%)'
                        : undefined,
              }}
            >
              <div className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: hover.color }} />
                <span className="text-xs font-medium text-lab-text">{hover.speciesName}</span>
                <span className="font-mono text-xs text-lab-muted">#{hover.id}</span>
              </div>
              <div className="mt-0.5 whitespace-nowrap font-mono text-xs text-lab-muted">
                能量 {Math.round(hover.energy01 * 100)}% · 体型 {hover.size.toFixed(1)}
              </div>
            </div>
          )}
          {/* 地形图例（与 renderer 底图用色一致） */}
          <div className="pointer-events-none absolute bottom-7 left-3 flex flex-col items-start gap-1">
            {TERRAIN_LEGEND.map((item) => (
              <span
                key={item.label}
                className="flex items-center gap-1.5 rounded bg-black/45 px-1.5 py-0.5 text-[10px] leading-none text-lab-muted"
              >
                <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: item.color }} />
                {item.label}
              </span>
            ))}
          </div>
          <div className="pointer-events-none absolute bottom-2 left-3 text-xs text-lab-muted/70">
            拖拽平移 · 滚轮缩放 · 点击个体查看 · 悬停查看物种
          </div>
          {/* 世界之声：画布底部解说字幕条（位于图例与提示之上） */}
          <NarratorBar expId={id} rules={rules} onApplyRules={handleApplyRules} />
          {/* 神迹面板：以选中个体为落点的三类空间级干预 */}
          {showMiracles && (
            <MiraclesPanel
              expId={id}
              currentTick={stats.tick}
              center={agent !== null ? { x: agent.x, y: agent.y } : null}
              onClose={() => setShowMiracles(false)}
            />
          )}
          {/* 热力叠加切换：看哪里扎堆（密度）/ 哪里在死人（死亡） */}
          <div className="pointer-events-auto absolute bottom-3 right-3 z-10 flex gap-1 rounded-full bg-black/50 p-0.5">
            {OVERLAY_MODES.map((m) => (
              <button
                key={m.id}
                onClick={() => setOverlay(m.id)}
                className={`rounded-full px-2 py-0.5 text-[10px] leading-none transition-colors ${
                  overlay === m.id ? 'bg-lab-accent/20 text-lab-accent' : 'text-lab-muted hover:text-lab-text'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* 侧栏拖拽把手：按住左右拖动调整宽度 */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          title="拖拽调整侧栏宽度"
          className="w-1.5 shrink-0 cursor-col-resize touch-none transition-colors hover:bg-lab-accent/30"
          onPointerDown={handleSidebarResizeStart}
        />

        <aside
          className="flex shrink-0 flex-col border-l border-lab-border bg-lab-panel"
          style={{ width: sidebarWidth }}
        >
          <div className="flex border-b border-lab-border">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex-1 py-2 text-xs transition-colors ${
                  tab === t.id
                    ? 'border-b-2 border-lab-accent text-lab-text'
                    : 'text-lab-muted hover:text-lab-text'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'metrics' && (
              <>
                <WorldPulse expId={id} />
                <MetricCharts expId={id} />
              </>
            )}
            {tab === 'species' && (
              <SpeciesPanel expId={id} highlightId={highlightSpeciesId} onHighlight={setHighlightSpeciesId} />
            )}
            {tab === 'phylo' && (
              <PhyloTree expId={id} highlightId={highlightSpeciesId} onHighlight={setHighlightSpeciesId} />
            )}
            {tab === 'agent' && (
              <AgentInspector
                agent={agent}
                speciesName={agentSpecies}
                speciesTags={agentSpeciesTags}
                speciesNiche={agentSpeciesNiche}
                intent={agent?.intent}
                follow={follow}
                onToggleFollow={() => {
                  const next = !follow;
                  setFollow(next);
                  camRef.current.followId = next ? selectedId : null;
                }}
              />
            )}
            {tab === 'events' && <EventFeed expId={id} />}
            {tab === 'rules' && rules && <RulesPanel current={rules} onApply={handleApplyRules} />}
          </div>
        </aside>
      </div>

      <PlaybackBar
        running={stats.running}
        tps={simManager.get(id)?.tps ?? 60}
        tick={stats.tick}
        pop={stats.pop}
        speciesCount={stats.species}
        onPlayPause={handlePlayPause}
        onSpeed={handleSpeed}
        onStep={handleStep}
      />
      {showGuide && <GuideOverlay onClose={closeGuide} />}
      {stats.running === false && stats.tick === 0 && !showGuide && (
        <WelcomeOverlay onStart={handlePlayPause} onExit={() => navigate('/')} name={record.name} />
      )}
    </div>
  );
}

function WelcomeOverlay({ onStart, onExit, name }: { onStart: () => void; onExit: () => void; name: string }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-lab-bg/80 backdrop-blur-sm">
      <div className="w-[420px] rounded-2xl border border-lab-border bg-lab-panel p-8 text-center shadow-2xl">
        <div className="mb-2 text-3xl">🧬</div>
        <h2 className="mb-1 text-lg">{name}</h2>
        <p className="mb-6 text-sm text-lab-muted">
          世界已经就绪。按下运行，生命将开始觅食、繁殖、竞争与演化。
        </p>
        <div className="flex justify-center gap-3">
          <button
            onClick={onStart}
            className="rounded-lg bg-lab-accent px-6 py-2 text-sm text-lab-bg hover:bg-lab-accent-dim"
          >
            ▶ 创世启动
          </button>
          <button
            onClick={onExit}
            className="rounded-lg border border-lab-border px-6 py-2 text-sm text-lab-muted hover:text-lab-text"
          >
            返回
          </button>
        </div>
      </div>
    </div>
  );
}
