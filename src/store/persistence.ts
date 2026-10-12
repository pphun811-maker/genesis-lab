import {
  deleteExperiment,
  listExperiments,
  saveExperiment,
} from '../persistence/db';
import { useExperiments } from './experiments';

/**
 * 持久化编排：
 * - 启动时从 IndexedDB 恢复实验记录（内存中已存在的不覆盖）。
 * - store 变更 → 收集脏 id → 800ms 防抖批量落盘。
 * - 快照由 simManager 按节奏（每 1000 tick / 暂停时）写入记录后随批量落盘。
 */

const dirty = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  flushTimer = null;
  const store = useExperiments.getState();
  const ids = Array.from(dirty);
  dirty.clear();
  for (const id of ids) {
    const rec = store.records[id];
    if (!rec) continue;
    saveExperiment(rec).catch((err) => console.error('[persistence]', err));
  }
}

function markDirty(id: string): void {
  dirty.add(id);
  if (flushTimer === null) flushTimer = setTimeout(flush, 800);
}

/** 启动恢复：在首次渲染前调用 */
export async function hydrateExperiments(): Promise<void> {
  try {
    const saved = await listExperiments();
    const state = useExperiments.getState();
    for (const rec of saved) {
      if (!state.records[rec.id]) {
        // 恢复的实验一律视为暂停，等待用户手动继续
        useExperiments.setState((st) => ({
          records: { ...st.records, [rec.id]: { ...rec, running: false } },
        }));
      }
    }
  } catch (err) {
    console.error('[persistence] 恢复实验失败', err);
  }
  // 之后的所有变更走脏标记
  useExperiments.subscribe((state, prev) => {
    for (const id of Object.keys(state.records)) {
      if (state.records[id] !== prev.records[id]) markDirty(id);
    }
    for (const id of Object.keys(prev.records)) {
      if (!state.records[id]) {
        deleteExperiment(id).catch((err) => console.error('[persistence]', err));
        dirty.delete(id);
      }
    }
  });
}
