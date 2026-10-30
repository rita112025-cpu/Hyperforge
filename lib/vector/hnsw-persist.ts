import type { EmbedMeta, HyperforgeDB } from "./db";
import { HNSW, type HNSWSnapshot } from "./hnsw";

const META_KEY = "hnswIndex";

interface PersistedIndex {
  model: string;
  dim: number;
  snapshot: HNSWSnapshot;
  savedAt: number;
}

/** 持久化索引的摘要（不反序列化圖結構），供 forge-lab 檢視。 */
export interface HNSWIndexInfo {
  model: string;
  dim: number;
  size: number;
  savedAt: number;
}

function isPersistedIndex(v: unknown): v is PersistedIndex {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.model === "string" && typeof r.dim === "number" && typeof r.savedAt === "number" && typeof r.snapshot === "object" && r.snapshot !== null;
}

async function readPersisted(db: HyperforgeDB): Promise<PersistedIndex | null> {
  const value = (await db.meta.get(META_KEY))?.value;
  return isPersistedIndex(value) ? value : null;
}

/**
 * 將 HNSW 序列化到 meta 表（單一 put，原子寫入）。盡力而為：失敗不影響 ingest（下次啟動會由 vectors 表重建）。
 * 回傳寫入時間；失敗回傳 null。
 */
export async function saveHNSWIndex(db: HyperforgeDB, index: HNSW, embed: EmbedMeta): Promise<number | null> {
  try {
    const value: PersistedIndex = { model: embed.model, dim: embed.dim, snapshot: index.toJSON(), savedAt: Date.now() };
    await db.meta.put({ key: META_KEY, value });
    return value.savedAt;
  } catch {
    return null;
  }
}

/**
 * 載入已持久化的索引。只有在 model/dim 相符，且索引內的 id 集合與 vectors 表完全一致時才回傳；
 * 否則回傳 null（呼叫端由 vectors 表重建）。model/dim 與 meta.embed 不符屬 ModelMismatchError，由 VectorStore.init 先擋下。
 */
export async function loadHNSWIndex(db: HyperforgeDB, embed: EmbedMeta): Promise<HNSW | null> {
  try {
    const rec = await readPersisted(db);
    if (!rec || rec.model !== embed.model || rec.dim !== embed.dim) return null;
    const index = HNSW.fromJSON(rec.snapshot);
    const keys = (await db.vectors.toCollection().primaryKeys()) as string[];
    if (keys.length !== index.size || !keys.every((k) => index.has(k))) return null;
    return index;
  } catch {
    return null;
  }
}

/** 由 vectors 表重建索引（依 id 排序，結果決定性）。 */
export async function rebuildHNSWIndex(db: HyperforgeDB, dim: number): Promise<HNSW> {
  const index = new HNSW({ dim });
  const rows = await db.vectors.toArray();
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of rows) index.add(r.id, r.vec);
  return index;
}

export async function readHNSWIndexInfo(db: HyperforgeDB): Promise<HNSWIndexInfo | null> {
  try {
    const rec = await readPersisted(db);
    return rec ? { model: rec.model, dim: rec.dim, size: rec.snapshot.nodes.length, savedAt: rec.savedAt } : null;
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
