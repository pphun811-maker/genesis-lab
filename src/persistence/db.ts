/**
 * IndexedDB 持久层（基于 idb）。
 *
 * - `experiments`：实验记录（含快照，typed array 可结构化克隆）
 * - `settings`：应用级键值配置
 *
 * 连接采用惰性单例：首次读写时打开，之后复用同一连接；
 * closeDb() 供测试或页面卸载时关闭并重置单例。
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ExperimentRecord } from '../store/types';

/**
 * settings store 的磁盘行格式：keyPath='key'，因此任意值需包一层 { key, value }。
 */
interface SettingRow {
  key: string;
  value: unknown;
}

/** 数据库结构定义：为各 object store 提供键与值的类型推导 */
interface GenesisDb extends DBSchema {
  experiments: {
    key: string;
    value: ExperimentRecord;
  };
  settings: {
    key: string;
    value: SettingRow;
  };
}

const DB_NAME = 'genesis-lab';
const DB_VERSION = 1;

/** 模块级单例连接 promise，避免重复 openDB */
let dbPromise: Promise<IDBPDatabase<GenesisDb>> | null = null;

/** 惰性获取（并缓存）数据库连接 */
function getDb(): Promise<IDBPDatabase<GenesisDb>> {
  if (!dbPromise) {
    dbPromise = openDB<GenesisDb>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('experiments')) {
          db.createObjectStore('experiments', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      },
    });
    // 打开失败时清除单例，允许下一次调用重试
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

/** 统一错误包装：给底层 IndexedDB 错误补充中文上下文 */
function rethrow(context: string, err: unknown): never {
  const detail = err instanceof Error ? err.message : String(err);
  throw new Error(`${context}: ${detail}`);
}

/** 保存（新增或覆盖）一条实验记录 */
export async function saveExperiment(rec: ExperimentRecord): Promise<void> {
  try {
    const db = await getDb();
    await db.put('experiments', rec);
  } catch (err) {
    rethrow(`保存实验失败（id=${rec.id}）`, err);
  }
}

/** 按 id 读取实验记录；不存在时返回 undefined */
export async function getExperiment(id: string): Promise<ExperimentRecord | undefined> {
  try {
    const db = await getDb();
    return await db.get('experiments', id);
  } catch (err) {
    rethrow(`读取实验失败（id=${id}）`, err);
  }
}

/** 列出全部实验记录，按 createdAt 降序（最新在前） */
export async function listExperiments(): Promise<ExperimentRecord[]> {
  try {
    const db = await getDb();
    const all = await db.getAll('experiments');
    all.sort((a, b) => b.createdAt - a.createdAt);
    return all;
  } catch (err) {
    rethrow('列出实验失败', err);
  }
}

/** 按 id 删除实验记录 */
export async function deleteExperiment(id: string): Promise<void> {
  try {
    const db = await getDb();
    await db.delete('experiments', id);
  } catch (err) {
    rethrow(`删除实验失败（id=${id}）`, err);
  }
}

/** 读取设置项；不存在时返回 undefined */
export async function getSetting<T = unknown>(key: string): Promise<T | undefined> {
  try {
    const db = await getDb();
    const row = await db.get('settings', key);
    return row?.value as T | undefined;
  } catch (err) {
    rethrow(`读取设置失败（key=${key}）`, err);
  }
}

/** 写入（新增或覆盖）设置项 */
export async function setSetting<T = unknown>(key: string, value: T): Promise<void> {
  try {
    const db = await getDb();
    // keyPath='key'：任意值包一层写入，避免限制 value 的形状
    await db.put('settings', { key, value });
  } catch (err) {
    rethrow(`写入设置失败（key=${key}）`, err);
  }
}

/** 关闭当前连接并重置单例（测试用） */
export async function closeDb(): Promise<void> {
  const pending = dbPromise;
  dbPromise = null;
  if (!pending) return;
  try {
    const db = await pending;
    db.close();
  } catch {
    // 打开本就失败，无需关闭，保持静默
  }
}
