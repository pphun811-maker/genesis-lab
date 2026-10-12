import type {
  Agent,
  MetricSample,
  SimEvent,
  SimState,
  WorldSpec,
} from '../engine/types';

/**
 * 主线程 ↔ 模拟 Worker 的消息协议。
 *
 * frame.agents 为紧凑交错数组（stride=8）：
 * [id, x, y, hue, size, energy01, speciesIdx, sense] × N
 * speciesIdx 是 frame.species 数组的下标。
 */

export interface FrameSpecies {
  id: number;
  name: string;
  color: string;
  count: number;
  /** 特征标签（迅捷/锐目…），由引擎基因组推导 */
  tags?: string[];
  /** 一句话生态位 */
  niche?: string;
  /** 拉丁双名 */
  latin?: string;
  /** 祖先物种 id；null = 初始物种 */
  parentId?: number | null;
  /** 诞生 tick（谱系树时间轴用） */
  foundedTick?: number;
  /** 灭绝 tick；null = 存续 */
  extinctTick?: number | null;
  /** 已灭绝（不再有存活个体） */
  extinct?: boolean;
}

export interface FrameData {
  tick: number;
  pop: number;
  agents: Float32Array;
  /** 每格食物能量；按节流频率随帧发送 */
  food: Float32Array | null;
  species: FrameSpecies[];
  samples: MetricSample[];
  events: SimEvent[];
  /** 死亡热区网格（世界 W×H，与食物同频节流发送）；缺省无 */
  deathHeat?: Float32Array;
  /** 仅在 init/restore 后的第一个帧携带，供渲染器构建地形底图 */
  worldData?: {
    width: number;
    height: number;
    terrain: Uint8Array;
    fertility: Float32Array;
    foodMaxPerCell: number;
  };
}

export type ToWorker =
  | { type: 'init'; spec: WorldSpec }
  | { type: 'restore'; state: SimState }
  | { type: 'run' }
  | { type: 'pause' }
  | { type: 'setSpeed'; tps: number }
  | { type: 'step'; ticks: number }
  | {
      type: 'updateRules';
      patch: {
        mutationRate?: number;
        foodRegrow?: number;
        maxPopulation?: number;
        sexualReproduction?: boolean;
        disasters?: { enabled: boolean; severity: number };
      };
      /** 干预来源前缀（如 '按 AI 建议'），仅影响事件文案 */
      via?: string;
    }
  | { type: 'snapshot'; reqId: number }
  | { type: 'inspect'; agentId: number; reqId: number };

export type FromWorker =
  | { type: 'inited'; tick: number; paused: boolean }
  | { type: 'frame'; frame: FrameData; running: boolean }
  | { type: 'snapshot'; reqId: number; state: SimState }
  | {
      type: 'agentInfo';
      reqId: number;
      agent: Agent | null;
      speciesName?: string;
      speciesTags?: string[];
      speciesNiche?: string;
    }
  | { type: 'error'; message: string };

export const AGENT_STRIDE = 8;
