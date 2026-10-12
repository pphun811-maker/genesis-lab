import { AGENT_STRIDE, type FrameData } from '../client/protocol';
import type { Camera } from './camera';

const EMPTY_F32 = new Float32Array(0);

const HUE_COUNT = 360;
/** 精灵图集单格边长（圆直径 28 + 两侧各 2px 留白） */
const ATLAS_CELL = 32;
/** 精灵圆直径，边缘 2px 抗锯齿过渡 */
const ATLAS_DIAMETER = 28;
const ATLAS_INSET = (ATLAS_CELL - ATLAS_DIAMETER) / 2;
/** 低于该缩放（看全景）时改用按色相分组的批量矩形绘制 */
const BATCH_SCALE_THRESHOLD = 2;
/** 食物层增量重建的最小间隔（毫秒） */
const FOOD_REPAINT_INTERVAL = 150;
/** 热力层增量重建的最小间隔（毫秒），与食物层同款节流 */
const HEAT_REPAINT_INTERVAL = 150;
/** 种群密度封顶：密度达到该值时 alpha 恰为 0.5 */
const DENSITY_CAP = 20;
/** 密度场每轮衰减系数：旧聚集逐渐冷却，持续驻留处补 1 形成发光 */
const DENSITY_DECAY = 0.92;
/** 单帧绘制的可见个体上限：全景高密度时均匀抽样（密度观感不变，纯渲染决策）。
 * 万级种群下逐个体 fillRect/drawImage 是主线程掉帧的直接来源。 */
const MAX_DRAW_AGENTS = 8000;

/** 画布热力叠加模式：off = 关闭；population = 种群密度聚集；deaths = 死亡热点 */
export type OverlayMode = 'off' | 'population' | 'deaths';

/** hue → [0, 359] 的图集/调色板下标（截断后夹取，防越界） */
function hueIndex(hue: number): number {
  const h = hue | 0;
  return h < 0 ? 0 : h > HUE_COUNT - 1 ? HUE_COUNT - 1 : h;
}

/**
 * 世界渲染器：Canvas 2D。
 *
 * - 地形底图与食物层各渲染到一张「1 世界单位 = 1 像素」的离屏画布，
 *   每帧只需 drawImage 缩放，个体数量增长不影响地形开销。
 * - 可选热力叠加层（种群密度 / 死亡热点）同样走离屏画布 + 150ms 节流重建，
 *   off 模式下完全不维护、零开销。
 * - 个体绘制两条路径：高倍缩放用 360 色相预渲染精灵图集逐个体 drawImage；
 *   低倍缩放（全景）按色相分组批量 fillRect。两者都免去逐个体
 *   beginPath + arc + fill 的路径构建开销，种群 2000+ 时不再卡顿。
 */
export class WorldRenderer {
  private ctx: CanvasRenderingContext2D;
  private terrainCanvas: HTMLCanvasElement | null = null;
  private foodCanvas: HTMLCanvasElement | null = null;
  private foodImage: ImageData | null = null;
  private hueColors: string[] = [];
  /** 惰性构建的 360 色相精灵图集（360×32 长条 canvas） */
  private spriteAtlas: HTMLCanvasElement | null = null;
  /** 批量矩形模式的可复用分组缓冲：下标 = hue，元素 = 个体下标（每帧清空复用） */
  private hueBuckets: number[][] | null = null;
  /** 上次食物层实际重建的时间戳；-1 = 尚未重建过（下次调用必执行） */
  private lastFoodPaintAt = -1;
  /** 当前热力叠加模式（默认关闭，关闭时零渲染开销） */
  private overlayMode: OverlayMode = 'off';
  /** 热力层离屏画布（1 世界单位 = 1 像素，与地形/食物层同模式） */
  private heatCanvas: HTMLCanvasElement | null = null;
  private heatImage: ImageData | null = null;
  /** 种群密度场（W×H）；只有 population 模式维护，off 时释放 */
  private densityField: Float32Array | null = null;
  /** engine 死亡热区网格（W×H，engine 侧已衰减封顶）；updateDeathHeat 直接替换引用 */
  private deathHeat: Float32Array | null = null;
  /** 上次热力层实际重建的时间戳；-1 = 尚未重建过（下次调用必执行） */
  private lastHeatPaintAt = -1;
  private fertility: Float32Array = new Float32Array(0);
  /** 地形值（0 普通 1 障碍 2 危险 3 淡水 4 海洋），食物层按水陆分色用 */
  private terrainArr: Uint8Array = new Uint8Array(0);
  private maxPerCell = 1;
  private vignette: { gradient: CanvasGradient; w: number; h: number } | null = null;
  /** 可见个体下标的复用缓冲（每帧重建内容，容量保持水位） */
  private visibleBuf: number[] = [];
  worldW = 0;
  worldH = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 Canvas 2D 上下文');
    this.ctx = ctx;
    for (let h = 0; h < 360; h++) {
      this.hueColors.push(`hsl(${h}, 72%, 62%)`);
    }
  }

  /** 首帧地形数据 → 构建底图 */
  setWorldData(
    width: number,
    height: number,
    terrain: Uint8Array,
    fertility: Float32Array,
    foodMaxPerCell: number,
  ): void {
    this.worldW = width;
    this.worldH = height;
    this.fertility = fertility;
    this.terrainArr = terrain;
    this.maxPerCell = foodMaxPerCell;
    // 新世界：食物层节流计时归零，保证设置后的第一次 updateFood 必定执行
    this.lastFoodPaintAt = -1;
    this.foodImage = null;
    // 新世界：热力层全部失效——密度场/旧热区释放、离屏画布作废、节流计时归零
    this.densityField = null;
    this.deathHeat = null;
    this.heatCanvas = null;
    this.heatImage = null;
    this.lastHeatPaintAt = -1;

    const tc = document.createElement('canvas');
    tc.width = width;
    tc.height = height;
    const tctx = tc.getContext('2d')!;
    const img = tctx.createImageData(width, height);
    const d = img.data;
    // 第一遍：按地形值铺底色
    for (let i = 0; i < width * height; i++) {
      const t = terrain[i];
      const o = i * 4;
      if (t === 1) {
        // 障碍
        d[o] = 54;
        d[o + 1] = 60;
        d[o + 2] = 72;
      } else if (t === 2) {
        // 危险区
        d[o] = 118;
        d[o + 1] = 42;
        d[o + 2] = 40;
      } else if (t === 3) {
        // 淡水：青绿色（与海洋的藏蓝拉开色相），随肥沃度微亮（营养陷阱）
        const f = fertility[i];
        d[o] = 15 + 11 * f;
        d[o + 1] = 86 + 38 * f;
        d[o + 2] = 82 + 32 * f;
      } else if (t === 4) {
        // 海洋：深邃藏蓝（蓝分量明显高于绿分量），随浮游生物微亮
        const f = fertility[i];
        d[o] = 8 + 8 * f;
        d[o + 1] = 24 + 16 * f;
        d[o + 2] = 52 + 26 * f;
      } else {
        // 肥沃度 → 暗绿渐变
        const f = fertility[i];
        d[o] = 18 + 14 * f;
        d[o + 1] = 24 + 44 * f;
        d[o + 2] = 30 + 20 * f;
      }
      d[o + 3] = 255;
    }
    // 第二遍：水陆交界描边——水面格若与陆地相邻则提亮为「浅滩/湖岸」，
    // 让海岸线与湖岸线一眼可读（一次性 O(n) 邻接扫描）
    for (let i = 0; i < width * height; i++) {
      const t = terrain[i];
      if (t !== 3 && t !== 4) continue;
      const x = i % width;
      const y = (i / width) | 0;
      let shore = false;
      if (x > 0 && terrain[i - 1] < 3) shore = true;
      else if (x < width - 1 && terrain[i + 1] < 3) shore = true;
      else if (y > 0 && terrain[i - width] < 3) shore = true;
      else if (y < height - 1 && terrain[i + width] < 3) shore = true;
      if (!shore) continue;
      const o = i * 4;
      if (t === 3) {
        // 湖岸：青绿提亮
        d[o] = Math.min(255, d[o] + 22);
        d[o + 1] = Math.min(255, d[o + 1] + 34);
        d[o + 2] = Math.min(255, d[o + 2] + 28);
      } else {
        // 浅滩：藏蓝提亮成灰蓝
        d[o] = Math.min(255, d[o] + 30);
        d[o + 1] = Math.min(255, d[o + 1] + 42);
        d[o + 2] = Math.min(255, d[o + 2] + 46);
      }
    }
    tctx.putImageData(img, 0, 0);
    this.terrainCanvas = tc;
  }

  /** 食物层重建（节流调用）；不传 food 时按当前 fertility 清空重绘 */
  updateFood(food?: Float32Array): void {
    if (!this.terrainCanvas) return;
    const width = this.worldW;
    const height = this.worldH;
    // 实时节流：距上次实际重建 <150ms 的增量重建直接跳过；
    // 「清空重绘」调用（不传 food）保持旧的立即执行逻辑
    const now = performance.now();
    if (
      food !== undefined &&
      this.lastFoodPaintAt >= 0 &&
      now - this.lastFoodPaintAt < FOOD_REPAINT_INTERVAL
    ) {
      return;
    }
    this.lastFoodPaintAt = now;
    if (!this.foodCanvas) {
      this.foodCanvas = document.createElement('canvas');
      this.foodCanvas.width = width;
      this.foodCanvas.height = height;
      this.foodImage = null;
    }
    const fctx = this.foodCanvas.getContext('2d')!;
    // 复用 ImageData 缓冲，避免每次重建分配 100KB+ 的像素数组
    let img = this.foodImage;
    if (!img || img.width !== width || img.height !== height) {
      img = fctx.createImageData(width, height);
      this.foodImage = img;
    } else {
      img.data.fill(0);
    }
    const d = img.data;
    const src = food ?? EMPTY_F32;
    for (let i = 0; i < width * height; i++) {
      const cap = this.fertility[i] * this.maxPerCell;
      const f = src.length > i ? src[i] : 0;
      if (cap <= 0 || f <= 0.05) continue;
      const o = i * 4;
      const t = this.terrainArr.length > i ? this.terrainArr[i] : 0;
      if (t === 3) {
        // 淡水浮游生物：黄绿（与湖底青绿同族但更亮）
        d[o] = 132;
        d[o + 1] = 234;
        d[o + 2] = 158;
      } else if (t === 4) {
        // 海洋浮游生物：天蓝（与海底藏蓝同族但更亮）
        d[o] = 96;
        d[o + 1] = 178;
        d[o + 2] = 246;
      } else {
        // 陆地植被：绿
        d[o] = 74;
        d[o + 1] = 222;
        d[o + 2] = 128;
      }
      d[o + 3] = Math.min(200, (f / cap) * 190);
    }
    fctx.putImageData(img, 0, 0);
  }

  /** 切换热力叠加模式；off 期间不绘制也不维护热力数据，切回时强制重建一次 */
  setOverlay(mode: OverlayMode): void {
    if (mode === this.overlayMode) return;
    this.overlayMode = mode;
    if (mode === 'off') {
      // off：释放密度场（off 时不维护），画面不再叠加热力层
      this.densityField = null;
      return;
    }
    // 切回叠加模式：节流时间戳归零，下一次 render 立即重建一次
    this.lastHeatPaintAt = -1;
  }

  /** 接收 engine 死亡热区网格（Float32Array 已归本线程所有）；下一轮节流重建生效 */
  updateDeathHeat(data: Float32Array): void {
    this.deathHeat = data;
  }

  /** 密度场衰减 + 当前帧个体按坐标落格（节流 150ms 一轮；封顶产生聚集发光） */
  private accumulateDensity(frame: FrameData): void {
    const width = this.worldW;
    const height = this.worldH;
    const n = width * height;
    let field = this.densityField;
    if (!field || field.length !== n) {
      field = new Float32Array(n);
      this.densityField = field;
    }
    for (let i = 0; i < n; i++) field[i] *= DENSITY_DECAY;
    const agents = frame.agents;
    const count = agents.length / AGENT_STRIDE;
    for (let i = 0; i < count; i++) {
      const o = i * AGENT_STRIDE;
      const gx = agents[o + 1] | 0;
      const gy = agents[o + 2] | 0;
      if (gx < 0 || gx >= width || gy < 0 || gy >= height) continue;
      const idx = gy * width + gx;
      const v = field[idx] + 1;
      field[idx] = v > DENSITY_CAP ? DENSITY_CAP : v;
    }
  }

  /** 按当前叠加模式重建热力离屏画布；复用 ImageData 缓冲，热路径零分配 */
  private rebuildHeatCanvas(): void {
    const width = this.worldW;
    const height = this.worldH;
    if (width <= 0 || height <= 0) return;
    if (!this.heatCanvas) {
      this.heatCanvas = document.createElement('canvas');
      this.heatCanvas.width = width;
      this.heatCanvas.height = height;
      this.heatImage = null;
    }
    const hctx = this.heatCanvas.getContext('2d')!;
    let img = this.heatImage;
    if (!img || img.width !== width || img.height !== height) {
      img = hctx.createImageData(width, height);
      this.heatImage = img;
    } else {
      img.data.fill(0);
    }
    const d = img.data;
    const n = width * height;
    if (this.overlayMode === 'population') {
      // 种群密度：青→蓝 rgba(56,189,248,a)，a = 密度/20×0.5
      const field = this.densityField;
      if (field !== null) {
        for (let i = 0; i < n; i++) {
          const v = field[i];
          if (v < 0.05) continue;
          const o = i * 4;
          d[o] = 56;
          d[o + 1] = 189;
          d[o + 2] = 248;
          d[o + 3] = ((v / DENSITY_CAP) * 0.5 * 255 + 0.5) | 0;
        }
      }
    } else {
      // 死亡热点：红 rgba(248,113,113,a)，a = min(1, heat/12)×0.55
      const heat = this.deathHeat;
      if (heat !== null) {
        for (let i = 0; i < n; i++) {
          const v = heat.length > i ? heat[i] : 0;
          if (v < 0.05) continue;
          const o = i * 4;
          d[o] = 248;
          d[o + 1] = 113;
          d[o + 2] = 113;
          d[o + 3] = (Math.min(1, v / 12) * 0.55 * 255 + 0.5) | 0;
        }
      }
    }
    hctx.putImageData(img, 0, 0);
  }

  render(
    frame: FrameData,
    cam: Camera,
    viewW: number,
    viewH: number,
    dpr: number,
    selectedId: number | null,
    highlightSpeciesId: number | null = null,
  ): void {
    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0a0e14';
    ctx.fillRect(0, 0, cw, ch);
    if (!this.terrainCanvas) return;

    // 统一变换到世界坐标
    const s = cam.scale * dpr;
    ctx.setTransform(s, 0, 0, s, dpr * (viewW / 2 - cam.x * cam.scale), dpr * (viewH / 2 - cam.y * cam.scale));
    ctx.imageSmoothingEnabled = true;

    ctx.drawImage(this.terrainCanvas, 0, 0, this.worldW, this.worldH);
    if (this.foodCanvas) {
      ctx.globalAlpha = 0.85;
      ctx.drawImage(this.foodCanvas, 0, 0, this.worldW, this.worldH);
      ctx.globalAlpha = 1;
    }

    // 热力叠加（食物层之后、个体之前）：节流重建离屏画布；off 模式直接跳过，零开销
    if (this.overlayMode !== 'off') {
      const now = performance.now();
      if (this.lastHeatPaintAt < 0 || now - this.lastHeatPaintAt >= HEAT_REPAINT_INTERVAL) {
        this.lastHeatPaintAt = now;
        if (this.overlayMode === 'population') this.accumulateDensity(frame);
        this.rebuildHeatCanvas();
      }
      if (this.heatCanvas) {
        ctx.drawImage(this.heatCanvas, 0, 0, this.worldW, this.worldH);
      }
    }

    // 世界边界
    ctx.strokeStyle = 'rgba(125, 136, 153, 0.35)';
    ctx.lineWidth = 1 / cam.scale;
    ctx.strokeRect(0, 0, this.worldW, this.worldH);

    // 高倍缩放时显示 10 格坐标网格，帮助定位
    if (cam.scale > 8) {
      ctx.strokeStyle = 'rgba(125, 136, 153, 0.10)';
      ctx.lineWidth = 1 / cam.scale;
      ctx.beginPath();
      for (let gx = 0; gx <= this.worldW; gx += 10) {
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, this.worldH);
      }
      for (let gy = 0; gy <= this.worldH; gy += 10) {
        ctx.moveTo(0, gy);
        ctx.lineTo(this.worldW, gy);
      }
      ctx.stroke();
    }

    // 视口裁剪（世界坐标）
    const halfW = viewW / 2 / cam.scale + 2;
    const halfH = viewH / 2 / cam.scale + 2;
    const vx0 = cam.x - halfW;
    const vx1 = cam.x + halfW;
    const vy0 = cam.y - halfH;
    const vy1 = cam.y + halfH;

    // 物种高亮：收集目标物种的全部 speciesIdx（species ≤ 64，每帧重建开销可忽略）。
    // 目标物种 id 不在名单中时不压暗任何个体，避免过期高亮把整屏涂黑。
    let highlightIdx: Set<number> | null = null;
    if (highlightSpeciesId !== null) {
      const set = new Set<number>();
      const species = frame.species;
      for (let i = 0; i < species.length; i++) {
        if (species[i].id === highlightSpeciesId) set.add(i);
      }
      if (set.size > 0) highlightIdx = set;
    }

    // 个体绘制：低倍全景（个体只有 1~2 像素）用按色相分组的批量矩形，
    // 高倍用精灵图集；切换阈值处两者视觉尺寸几乎一致
    if (cam.scale < BATCH_SCALE_THRESHOLD) {
      this.drawAgentsBatched(ctx, frame, vx0, vx1, vy0, vy1, highlightIdx);
    } else {
      this.drawAgentsBySprite(ctx, frame, vx0, vx1, vy0, vy1, highlightIdx);
    }
    ctx.globalAlpha = 1;

    // 选中个体：白色圈 + 感知范围
    if (selectedId !== null) {
      const sel = this.findById(frame, selectedId);
      if (sel) {
        const [x, y, sense] = [sel[1], sel[2], sel[7]];
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5 / cam.scale;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.32, sel[4] * 0.42) + 0.5, 0, 6.2832);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.setLineDash([0.8, 0.8]);
        ctx.beginPath();
        ctx.arc(x, y, sense, 0, 6.2832);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // 晕影：四角压暗，视线聚焦画面中心
    if (!this.vignette || this.vignette.w !== cw || this.vignette.h !== ch) {
      const g = ctx.createRadialGradient(
        cw / 2,
        ch / 2,
        Math.min(cw, ch) * 0.35,
        cw / 2,
        ch / 2,
        Math.max(cw, ch) * 0.72,
      );
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.30)');
      this.vignette = { gradient: g, w: cw, h: ch };
    }
    ctx.fillStyle = this.vignette.gradient;
    ctx.fillRect(0, 0, cw, ch);
  }

  /** 惰性构建精灵图集：每个色相预渲染一个 28px 圆（实心核 + 2px 渐隐抗锯齿边） */
  private ensureAtlas(): HTMLCanvasElement {
    let atlas = this.spriteAtlas;
    if (atlas) return atlas;
    atlas = document.createElement('canvas');
    atlas.width = ATLAS_CELL * HUE_COUNT;
    atlas.height = ATLAS_CELL;
    const g = atlas.getContext('2d');
    if (!g) throw new Error('无法创建精灵图集上下文');
    const r = ATLAS_DIAMETER / 2;
    for (let h = 0; h < HUE_COUNT; h++) {
      const cx = h * ATLAS_CELL + ATLAS_CELL / 2;
      const cy = ATLAS_CELL / 2;
      const grad = g.createRadialGradient(cx, cy, r - 2, cx, cy, r);
      grad.addColorStop(0, this.hueColors[h]);
      grad.addColorStop(1, `hsla(${h}, 72%, 62%, 0)`);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(cx, cy, r, 0, 6.2832);
      g.fill();
    }
    this.spriteAtlas = atlas;
    return atlas;
  }

  /** 批量矩形模式的分组缓冲（360 个数组，只分配一次，每帧清空复用） */
  private ensureBuckets(): number[][] {
    let buckets = this.hueBuckets;
    if (!buckets) {
      buckets = [];
      for (let h = 0; h < HUE_COUNT; h++) buckets.push([]);
      this.hueBuckets = buckets;
    }
    return buckets;
  }

  /**
   * 收集视口内可见个体的下标到复用缓冲，并给出抽样步长：
   * 可见数超过 MAX_DRAW_AGENTS 时均匀抽样（全景密度观感不变），
   * 高倍缩放下可见数少则 stride=1 全画。
   */
  private collectVisible(
    frame: FrameData,
    vx0: number,
    vx1: number,
    vy0: number,
    vy1: number,
  ): { visible: number[]; stride: number } {
    const vis = this.visibleBuf;
    vis.length = 0;
    const agents = frame.agents;
    const n = agents.length / AGENT_STRIDE;
    for (let i = 0; i < n; i++) {
      const o = i * AGENT_STRIDE;
      const x = agents[o + 1];
      const y = agents[o + 2];
      if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
      vis.push(i);
    }
    const stride = vis.length > MAX_DRAW_AGENTS ? Math.ceil(vis.length / MAX_DRAW_AGENTS) : 1;
    return { visible: vis, stride };
  }

  /**
   * 高倍缩放：逐个体 drawImage 精灵。
   * sprite 圆心对准个体坐标、直径 = 2r（r = max(0.32, size*0.42)），视觉大小与
   * 旧的 arc + fill 完全一致；能量透明度 / 高亮压暗逻辑不变。
   */
  private drawAgentsBySprite(
    ctx: CanvasRenderingContext2D,
    frame: FrameData,
    vx0: number,
    vx1: number,
    vy0: number,
    vy1: number,
    highlightIdx: Set<number> | null,
  ): void {
    const atlas = this.ensureAtlas();
    const { visible, stride } = this.collectVisible(frame, vx0, vx1, vy0, vy1);
    const agents = frame.agents;
    for (let k = 0; k < visible.length; k += stride) {
      const o = visible[k] * AGENT_STRIDE;
      const x = agents[o + 1];
      const y = agents[o + 2];
      const size = agents[o + 4];
      const r = Math.max(0.32, size * 0.42);
      // 能量低个体逐渐隐入背景：饥荒一望便知
      let alpha = 0.4 + 0.6 * agents[o + 5];
      // 高亮物种以外的个体大幅压暗
      if (highlightIdx !== null && !highlightIdx.has(agents[o + 6] | 0)) alpha *= 0.12;
      ctx.globalAlpha = alpha;
      ctx.drawImage(
        atlas,
        hueIndex(agents[o + 3]) * ATLAS_CELL + ATLAS_INSET,
        ATLAS_INSET,
        ATLAS_DIAMETER,
        ATLAS_DIAMETER,
        x - r,
        y - r,
        r * 2,
        r * 2,
      );
    }
  }

  /**
   * 低倍缩放：可见个体按 hue|0 分组，同色连续 fillRect 不切换 fillStyle，
   * 省掉 2000+ 次 beginPath/arc/fill。方块边长 ≈ 现在圆的直径
   * （size=1 → 0.84 格，下限 0.8 格），大体型按比例放大。
   * 可见数超上限时按 stride 均匀抽样。
   */
  private drawAgentsBatched(
    ctx: CanvasRenderingContext2D,
    frame: FrameData,
    vx0: number,
    vx1: number,
    vy0: number,
    vy1: number,
    highlightIdx: Set<number> | null,
  ): void {
    const buckets = this.ensureBuckets();
    for (let h = 0; h < HUE_COUNT; h++) buckets[h].length = 0;
    const { visible, stride } = this.collectVisible(frame, vx0, vx1, vy0, vy1);
    const agents = frame.agents;
    for (let k = 0; k < visible.length; k += stride) {
      const i = visible[k];
      buckets[hueIndex(agents[i * AGENT_STRIDE + 3])].push(i);
    }
    for (let h = 0; h < HUE_COUNT; h++) {
      const bucket = buckets[h];
      if (bucket.length === 0) continue;
      ctx.fillStyle = this.hueColors[h];
      for (let k = 0; k < bucket.length; k++) {
        const o = bucket[k] * AGENT_STRIDE;
        let alpha = 0.4 + 0.6 * agents[o + 5];
        if (highlightIdx !== null && !highlightIdx.has(agents[o + 6] | 0)) alpha *= 0.12;
        ctx.globalAlpha = alpha;
        const side = Math.max(0.8, agents[o + 4] * 0.84);
        ctx.fillRect(agents[o + 1] - side / 2, agents[o + 2] - side / 2, side, side);
      }
    }
  }

  /** 在帧数据中找个体：返回其 8 元组，找不到返回 null */
  findById(frame: FrameData, agentId: number): Float32Array | null {
    const agents = frame.agents;
    for (let o = 0; o < agents.length; o += AGENT_STRIDE) {
      if (agents[o] === agentId) return agents.subarray(o, o + AGENT_STRIDE);
    }
    return null;
  }

  /** 屏幕坐标附近的最近个体 id（点击拾取） */
  pick(frame: FrameData, cam: Camera, sx: number, sy: number, viewW: number, viewH: number, maxDistPx: number): number | null {
    const [wx, wy] = cam.screenToWorld(sx, sy, viewW, viewH);
    const maxD = maxDistPx / cam.scale;
    const agents = frame.agents;
    let best: number | null = null;
    let bestD2 = maxD * maxD;
    for (let o = 0; o < agents.length; o += AGENT_STRIDE) {
      const dx = agents[o + 1] - wx;
      const dy = agents[o + 2] - wy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = agents[o];
      }
    }
    return best;
  }
}
