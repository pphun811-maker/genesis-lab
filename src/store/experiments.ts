import { create } from 'zustand';
import type { MetricSample, SimEvent, SimState, WorldSpec } from '../engine/types';
import type { FrameData } from '../client/protocol';
import { decimateMetrics, type ExperimentRecord, type SpeciesMeta } from './types';
interface ExperimentsState {
  records: Record<string, ExperimentRecord>;
  create: (spec: WorldSpec, opts?: { parentId?: string; forkedAtTick?: number; name?: string }) => string;
  fork: (id: string, snapshot: SimState, name?: string) => string;
  importRecord: (rec: ExperimentRecord) => string;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
  /**
   * 应用一个刷新窗口：frame 取窗口内最新一帧（状态/物种名单），
   * samples/events 为窗口内全部帧的累积——高速档下事件不丢。
   */
  applyFrame: (
    id: string,
    frame: FrameData,
    samples: MetricSample[],
    events: SimEvent[],
  ) => void;
  setRunning: (id: string, running: boolean) => void;
  setSnapshot: (id: string, state: SimState) => void;
}

export const useExperiments = create<ExperimentsState>((set, get) => ({
  records: {},

  create: (spec, opts) => {
    const id = crypto.randomUUID();
    const record: ExperimentRecord = {
      id,
      name: opts?.name ?? spec.name,
      spec,
      parentId: opts?.parentId,
      forkedAtTick: opts?.forkedAtTick,
      createdAt: Date.now(),
      lastTick: 0,
      lastPop: 0,
      running: false,
      snapshot: null,
      metrics: [],
      events: [],
      species: Object.fromEntries(
        spec.species.map((s, i) => [
          i + 1,
          { name: s.name, color: s.color, foundedTick: 0, extinctTick: null },
        ]),
      ) as Record<number, SpeciesMeta>,
    };
    set((st) => ({ records: { ...st.records, [id]: record } }));
    return id;
  },

  fork: (id, snapshot, name) => {
    const parent = get().records[id];
    if (!parent) throw new Error(`实验不存在: ${id}`);
    const childId = crypto.randomUUID();
    const record: ExperimentRecord = {
      id: childId,
      name: name ?? `${parent.name} ↳分支`,
      spec: snapshot.spec,
      parentId: id,
      forkedAtTick: snapshot.tick,
      createdAt: Date.now(),
      lastTick: snapshot.tick,
      lastPop: snapshot.agents.length,
      running: false,
      snapshot,
      metrics: parent.metrics.filter((m) => m.t <= snapshot.tick),
      events: [
        ...parent.events,
        {
          t: snapshot.tick,
          kind: 'system' as const,
          msg: `实验从「${parent.name}」第 ${snapshot.tick} tick 分叉而来`,
        },
      ],
      species: { ...parent.species },
    };
    set((st) => ({ records: { ...st.records, [childId]: record } }));
    return childId;
  },

  /** 导入外部实验文件：id 冲突时换新 id */
  importRecord: (rec) => {
    const id = get().records[rec.id] ? crypto.randomUUID() : rec.id;
    const record: ExperimentRecord = { ...rec, id, running: false };
    set((st) => ({ records: { ...st.records, [id]: record } }));
    return id;
  },

  remove: (id) => {
    set((st) => {
      const next = { ...st.records };
      delete next[id];
      return { records: next };
    });
  },

  rename: (id, name) => {
    set((st) => {
      const r = st.records[id];
      if (!r) return st;
      return { records: { ...st.records, [id]: { ...r, name } } };
    });
  },

  applyFrame: (id, frame, samples, events) => {
    set((st) => {
      const r = st.records[id];
      if (!r) return st;
      const species = { ...r.species };
      for (const s of frame.species) {
        species[s.id] = {
          name: s.name,
          color: s.color,
          tags: s.tags,
          niche: s.niche,
          latin: s.latin,
          parentId: s.parentId,
          foundedTick: s.foundedTick,
          extinctTick: s.extinctTick,
          extinct: s.extinct,
        };
      }
      const nextMetrics =
        samples.length > 0 ? [...r.metrics, ...samples] : r.metrics;
      if (samples.length > 0) decimateMetrics(nextMetrics);
      const nextEvents =
        events.length > 0 ? [...r.events, ...events].slice(-500) : r.events;
      return {
        records: {
          ...st.records,
          [id]: {
            ...r,
            lastTick: frame.tick,
            lastPop: frame.pop,
            species,
            metrics: nextMetrics,
            events: nextEvents,
          },
        },
      };
    });
    void get;
  },

  setRunning: (id, running) => {
    set((st) => {
      const r = st.records[id];
      if (!r) return st;
      return { records: { ...st.records, [id]: { ...r, running } } };
    });
  },

  setSnapshot: (id, state) => {
    set((st) => {
      const r = st.records[id];
      if (!r) return st;
      return { records: { ...st.records, [id]: { ...r, snapshot: state } } };
    });
  },
}));
