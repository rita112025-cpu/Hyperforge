import type { Chunk } from "../pipeline/chunker";
import type { HyperforgeDB } from "../vector/db";
import { sha256Hex } from "../vector/hash";
import { hash53 } from "./seed";
import type { GraphDocument } from "./types";

/**
 * 圖譜資料來源層。本檔不得 import embedder / transformers / VectorStore：
 * 圖譜只依賴「文件文字 + chunk 位移」，向量化失敗或模型不存在都不能讓畫布變空。
 */

/** 內容 id：與 IndexedDB docs.id 相同（SHA-256）。非安全環境無 crypto.subtle 時退回 53-bit 雜湊（仍決定性，但不寫入 DB）。 */
export async function contentIdOf(text: string): Promise<{ id: string; persistable: boolean }> {
  try {
    return { id: await sha256Hex(text), persistable: true };
  } catch {
    return { id: `h53:${hash53(text).toString(16)}`, persistable: false };
  }
}

/** 即時來源：剛完成的 import job 的記憶體結果 → GraphDocument（不讀 DB）。 */
export function docFromJobResult(result: { name: string; rawText: string; chunks: Chunk[] }, id: string): GraphDocument {
  return {
    id,
    name: result.name,
    rawText: result.rawText,
    chunks: result.chunks.map((c) => ({ index: c.index, start: c.start, end: c.end })),
  };
}

export interface SaveResult {
  docId: string;
  /** false = 內容已存在（例如向量化已一併寫入），未重複寫入 */
  created: boolean;
}

/**
 * 只持久化文字（docs + chunks，不含向量）。與 embedding 無關：
 * 模型不存在、向量庫為舊模型建立（ModelMismatchError）時，這條路徑仍然可用。
 * 之後若向量化成功，VectorStore.ingest 會對同一 docId 補寫向量。
 */
export async function saveDocument(
  db: HyperforgeDB,
  input: { name: string; rawText: string; chunks: Chunk[] },
): Promise<SaveResult | null> {
  if (!input.chunks.length) return null;
  const { id: docId, persistable } = await contentIdOf(input.rawText);
  if (!persistable) return null;
  const rows = input.chunks.map((c) => ({
    id: `${docId}:${c.index}`,
    docId,
    index: c.index,
    start: c.start,
    end: c.end,
    tokenCount: c.tokenCount,
  }));
  let created = false;
  try {
    await db.transaction("rw", db.docs, db.chunks, async () => {
      if (await db.docs.get(docId)) return;
      await db.docs.add({ id: docId, name: input.name, createdAt: Date.now(), chunkCount: rows.length, rawText: input.rawText });
      await db.chunks.bulkAdd(rows);
      created = true;
    });
  } catch (e) {
    // 並發寫入同一內容：另一方先成功，視為已存在
    const err = e as { name?: string; failures?: Array<{ name?: string }> } | null;
    const constraint = err?.name === "ConstraintError" || (Array.isArray(err?.failures) && err!.failures.some((f) => f?.name === "ConstraintError"));
    if (!(constraint && (await db.docs.get(docId)))) throw e;
  }
  return { docId, created };
}

/**
 * reload 來源：IndexedDB 內已持久化的文件 → GraphDocument。
 * 只讀 docs 與 chunks 兩張表（不讀 vectors）。不需要 embedder，也不需要 VectorStore.init()。
 */
export async function loadCorpus(db: HyperforgeDB): Promise<GraphDocument[]> {
  const [docs, chunks] = await Promise.all([db.docs.toArray(), db.chunks.toArray()]);
  const byDoc = new Map<string, GraphDocument["chunks"]>();
  for (const c of chunks) {
    const list = byDoc.get(c.docId) ?? [];
    list.push({ index: c.index, start: c.start, end: c.end });
    byDoc.set(c.docId, list);
  }
  return docs
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .flatMap((d) => {
      const cs = byDoc.get(d.id);
      if (!cs?.length) return [];
      cs.sort((a, b) => a.index - b.index);
      return [{ id: d.id, name: d.name, rawText: d.rawText, chunks: cs } satisfies GraphDocument];
    });
}
