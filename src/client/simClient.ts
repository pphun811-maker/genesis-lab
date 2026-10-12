import type { Agent, SimState, WorldSpec } from '../engine/types';
import type { FrameData, FromWorker, ToWorker } from './protocol';

/**
 * SimClient：主线程侧单个实验的模拟控制 API。
 * Worker 持有模拟状态；主线程只保存最新一帧用于渲染，
 * 并把指标/事件转交给订阅者（store 负责累积）。
 */

export interface SimClientHandlers {
  onFrame?: (frame: FrameData, running: boolean) => void;
  onError?: (message: string) => void;
}

export interface InspectInfo {
  speciesName?: string;
  speciesTags?: string[];
  speciesNiche?: string;
}

let reqSeq = 1;

export class SimClient {
  readonly expId: string;
  private worker: Worker;
  private handlers: SimClientHandlers = {};
  private snapshotResolvers = new Map<number, (s: SimState) => void>();
  private inspectResolvers = new Map<number, (a: Agent | null, info: InspectInfo) => void>();
  private disposed = false;

  /** 最新一帧（渲染循环直接读取） */
  latestFrame: FrameData | null = null;
  /** 世界静态数据（首帧携带，持久保存供重挂载的渲染器取用） */
  worldData: FrameData['worldData'] | null = null;
  running = false;
  tps = 60;

  constructor(expId: string) {
    this.expId = expId;
    this.worker = new Worker(new URL('../workers/sim.worker.ts', import.meta.url), {
      type: 'module',
      name: `sim-${expId.slice(0, 8)}`,
    });
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.handle(ev.data);
    this.worker.onerror = (ev) => {
      this.handlers.onError?.(ev.message || '模拟 Worker 发生错误');
    };
  }

  setHandlers(h: SimClientHandlers): void {
    this.handlers = h;
  }

  private handle(msg: FromWorker): void {
    switch (msg.type) {
      case 'frame': {
        this.latestFrame = msg.frame;
        if (msg.frame.worldData) this.worldData = msg.frame.worldData;
        this.running = msg.running;
        this.handlers.onFrame?.(msg.frame, msg.running);
        break;
      }
      case 'snapshot': {
        this.snapshotResolvers.get(msg.reqId)?.(msg.state);
        this.snapshotResolvers.delete(msg.reqId);
        break;
      }
      case 'agentInfo': {
        this.inspectResolvers.get(msg.reqId)?.(msg.agent, {
          speciesName: msg.speciesName,
          speciesTags: msg.speciesTags,
          speciesNiche: msg.speciesNiche,
        });
        this.inspectResolvers.delete(msg.reqId);
        break;
      }
      case 'error': {
        this.handlers.onError?.(msg.message);
        break;
      }
      case 'inited':
        break;
    }
  }

  private send(msg: ToWorker): void {
    if (this.disposed) return;
    this.worker.postMessage(msg);
  }

  init(spec: WorldSpec): void {
    this.send({ type: 'init', spec });
  }

  restore(state: SimState): void {
    this.send({ type: 'restore', state });
  }

  run(): void {
    this.send({ type: 'setSpeed', tps: this.tps });
    this.send({ type: 'run' });
  }

  pause(): void {
    this.send({ type: 'pause' });
  }

  setTps(tps: number): void {
    this.tps = tps;
    this.send({ type: 'setSpeed', tps });
  }

  step(ticks: number): void {
    this.send({ type: 'step', ticks });
  }

  updateRules(
    patch: {
      mutationRate?: number;
      foodRegrow?: number;
      maxPopulation?: number;
      sexualReproduction?: boolean;
      disasters?: { enabled: boolean; severity: number };
    },
    via?: string,
  ): void {
    this.send({ type: 'updateRules', patch, via });
  }

  snapshot(): Promise<SimState> {
    return new Promise((resolve) => {
      const reqId = reqSeq++;
      this.snapshotResolvers.set(reqId, resolve);
      this.send({ type: 'snapshot', reqId });
    });
  }

  inspect(agentId: number): Promise<{ agent: Agent | null } & InspectInfo> {
    return new Promise((resolve) => {
      const reqId = reqSeq++;
      this.inspectResolvers.set(reqId, (agent, info) => resolve({ agent, ...info }));
      this.send({ type: 'inspect', agentId, reqId });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
  }
}
