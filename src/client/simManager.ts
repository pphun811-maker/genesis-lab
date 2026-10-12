import type { MetricSample, SimEvent, SimState, WorldSpec } from '../engine/types';
import type { FrameData } from '../client/protocol';
import { useExperiments } from '../store/experiments';
import { SimClient } from './simClient';

/**
 * SimManager：跨页面持活的模拟客户端池。
 * 每个实验一个 Worker；离开观察舱后实验继续在后台运行（这正是
 * 「并行实验」的基础——M5 会在此加入并发上限与排队）。
 *
 * 帧数据（个体位置等）不进 React——渲染器直接读 client.latestFrame；
 * 只有节流后的指标/事件/状态以 250ms 频率写入 store，避免高频重渲染。
 */

/** 250ms 刷新窗口内的累积缓冲：事件与指标必须全量保留，帧状态只留最新 */
interface PendingBuffer {
  frame: FrameData;
  samples: MetricSample[];
  events: SimEvent[];
}

class SimManager {
  private clients = new Map<string, SimClient>();
  private pending = new Map<string, PendingBuffer>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private lastSnapAt = new Map<string, number>();
  private wasRunning = new Map<string, boolean>();

  private ensureFlushLoop(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setInterval(() => this.flushAll(), 250);
  }

  private flushAll(): void {
    const store = useExperiments.getState();
    for (const [id, buf] of this.pending) {
      this.pending.delete(id);
      if (!store.records[id]) continue;
      store.applyFrame(id, buf.frame, buf.samples, buf.events);
      const running = this.clients.get(id)?.running ?? false;
      if (store.records[id]?.running !== running) store.setRunning(id, running);
    }
    // 快照节奏：运行中每 5 秒（按真实时间，高速档也不会频繁落盘）；
    // 暂停瞬间立即存一次
    const now = Date.now();
    for (const [id, client] of this.clients) {
      if (!store.records[id] || !client.latestFrame) continue;
      const running = client.running;
      const wasRunning = this.wasRunning.get(id) ?? false;
      this.wasRunning.set(id, running);
      const last = this.lastSnapAt.get(id) ?? -Infinity;
      const pausedJustNow = !running && wasRunning;
      if (pausedJustNow || (running && now - last >= 5000)) {
        this.takeSnapshot(id, client);
      }
    }
  }

  private takeSnapshot(id: string, client: SimClient): void {
    this.lastSnapAt.set(id, Date.now());
    client.snapshot().then((state) => {
      const store = useExperiments.getState();
      // 快照返回时实验可能已被删除
      if (store.records[id]) store.setSnapshot(id, state);
    }).catch((err) => console.error('[simManager] 快照失败', err));
  }

  get(id: string): SimClient | undefined {
    return this.clients.get(id);
  }

  isRunning(id: string): boolean {
    return this.clients.get(id)?.running ?? false;
  }

  /** 并行运行上限：CPU 核数 - 2，至少 2 */
  readonly maxRunning = Math.max(2, (navigator.hardwareConcurrency || 4) - 2);

  runningIds(): string[] {
    return Array.from(this.clients.values())
      .filter((c) => c.running)
      .map((c) => c.expId);
  }

  /**
   * 播放指定实验。若并行数已达上限，自动暂停最早开始运行的实验
   * （先到先得的长实验让位语义更符合直觉——后来者抢占最老的运行时）。
   */
  run(id: string): void {
    const client = this.clients.get(id);
    if (!client) return;
    if (client.running) return;
    const running = this.runningIds();
    if (!running.includes(id) && running.length >= this.maxRunning) {
      const oldest = running
        .map((rid) => ({ rid, t: this.startedAt.get(rid) ?? 0 }))
        .sort((a, b) => a.t - b.t)[0];
      if (oldest) {
        this.clients.get(oldest.rid)?.pause();
        useExperiments.getState().setRunning(oldest.rid, false);
      }
    }
    this.startedAt.set(id, Date.now());
    client.run();
  }

  private startedAt = new Map<string, number>();

  /**
   * 取得（或创建）实验的客户端。初次创建时用 spec 初始化，
   * 若记录带有快照则从快照恢复。
   */
  ensure(id: string, source: { spec: WorldSpec; snapshot?: SimState | null }): SimClient {
    const existing = this.clients.get(id);
    if (existing) return existing;

    const client = new SimClient(id);
    this.clients.set(id, client);

    client.setHandlers({
      onFrame: (frame) => {
        // 累积缓冲：高速档下一个刷新窗口内会有十几帧，帧状态只需最新一份，
        // 但每帧携带的指标采样与事件（分化/灭绝/里程碑）绝不能被覆盖丢弃
        const buf = this.pending.get(id);
        if (buf) {
          if (frame.samples.length > 0) buf.samples.push(...frame.samples);
          if (frame.events.length > 0) buf.events.push(...frame.events);
          buf.frame = frame;
        } else {
          this.pending.set(id, {
            frame,
            samples: [...frame.samples],
            events: [...frame.events],
          });
        }
      },
      onError: (message) => {
        console.error(`[sim ${id}] ${message}`);
      },
    });
    this.ensureFlushLoop();

    if (source.snapshot) client.restore(source.snapshot);
    else client.init(source.spec);
    return client;
  }

  /** 从内存池移除并终止 Worker */
  dispose(id: string): void {
    this.clients.get(id)?.dispose();
    this.clients.delete(id);
    this.pending.delete(id);
    this.lastSnapAt.delete(id);
    this.wasRunning.delete(id);
  }
}

export const simManager = new SimManager();
