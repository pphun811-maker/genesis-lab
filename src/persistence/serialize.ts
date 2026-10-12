import type { ExperimentRecord } from '../store/types';

/**
 * 实验的 JSON 序列化：SimState 中的 Float32Array/Uint8Array
 * 转成带标记的普通数组，导入时复原。
 */

type Tagged = { __ta: 'f32' | 'u8'; data: number[] };

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Float32Array) {
    return { __ta: 'f32', data: Array.from(value) } satisfies Tagged;
  }
  if (value instanceof Uint8Array) {
    return { __ta: 'u8', data: Array.from(value) } satisfies Tagged;
  }
  return value;
}

function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj.__ta === 'f32' && Array.isArray(obj.data)) return new Float32Array(obj.data as number[]);
    if (obj.__ta === 'u8' && Array.isArray(obj.data)) return new Uint8Array(obj.data as number[]);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = revive(v);
    return out;
  }
  return value;
}

export function serializeExperiment(rec: ExperimentRecord): string {
  return JSON.stringify({ __genesis: 1, ...rec }, replacer);
}

export function deserializeExperiment(json: string): ExperimentRecord {
  const revived = revive(JSON.parse(json)) as ExperimentRecord;
  if (!revived || typeof revived !== 'object' || !revived.spec || !Array.isArray(revived.spec.species)) {
    throw new Error('不是有效的 Genesis Lab 实验文件');
  }
  return {
    ...revived,
    running: false,
    metrics: revived.metrics ?? [],
    events: revived.events ?? [],
    species: revived.species ?? {},
    snapshot: revived.snapshot ?? null,
  };
}
