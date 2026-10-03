import type { EmbedMeta, HyperforgeDB } from "./db";
import { HNSW, type HNSWSnapshot } from "./hnsw";

const META_KEY = "hnswIndex";

interface PersistedIndex {
  model: string;
  dim: number;
  snapshot: HNSWSnapshot;
  savedAt: number;
}

/** 將 HNSW 序列化到 meta 表。盡力而為：失敗不影響 ingest（下次啟動會由 vectors 表重建）。 */
export async function saveIndex(db: HyperforgeDB, index: HNSW, embed: EmbedMeta): Promise<boolean> {
  try {
    const value: PersistedIndex = { model: embed.model, dim: embed.dim, snapshot: index.toJSON(), savedAt: Date.now() };
    await db.meta.put({ key: META_KEY, value });
    return true;
  } catch {
    return false;
  }
}

/**
 * 載入已持久化的索引。只有在 model/dim 相符，且索引內的 id 集合與 vectors 表完全一致時才回傳；
 * 否則回傳 null（呼叫端由 vectors 表重建）。
 */
export async function loadIndex(db: HyperforgeDB, embed: EmbedMeta): Promise<HNSW | null> {
  try {
    const rec = (await db.meta.get(META_KEY))?.value as PersistedIndex | undefined;
    if (!rec || rec.model !== embed.model || rec.dim !== embed.dim) return null;
    const index = HNSW.fromJSON(rec.snapshot);
    const keys = (await db.vectors.toCollection().primaryKeys()) as string[];
    if (keys.length !== index.size || !keys.every((k) => index.has(k))) return null;
    return index;
  } catch {
    return null;
  }
}

export async function clearIndex(db: HyperforgeDB): Promise<void> {
  try {
    await db.meta.delete(META_KEY);
  } catch {
    /* ignore */
  }
}
