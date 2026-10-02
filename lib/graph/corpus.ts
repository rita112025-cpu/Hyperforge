import type { Chunk } from "../pipeline/chunker";
import { embedLimitNote, exceedsEmbedLimit } from "../pipeline/limits";
import type { DocInfo } from "../pipeline/types";
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

/**
 * 每份文件目前已有幾筆向量（docId → 筆數）。只讀向量表的「主鍵」（`docId:index`），不載入向量本身，
 * 不需要 embedder，也不需要 VectorStore.init()；重新整理後用它判斷「語意索引是否已完成」。
 */
export async function loadVectorPresence(db: HyperforgeDB): Promise<Map<string, number>> {
  const keys = (await db.vectors.toCollection().primaryKeys()) as string[];
  const counts = new Map<string, number>();
  for (const k of keys) {
    const docId = k.slice(0, k.lastIndexOf(":"));
    counts.set(docId, (counts.get(docId) ?? 0) + 1);
  }
  return counts;
}

/**
 * 重新整理後，由 IndexedDB 推得每份文件的狀態：文字一定是 ready（能讀到就代表已 commit）；
 * 向量筆數 ≥ chunk 數 → indexed，否則 pending（「尚未建立」；先前是失敗 / 取消 / 不可用，重新整理後無從得知，也不需要區分）。
 */
export function docInfoFromDb(docs: GraphDocument[], presence: ReadonlyMap<string, number>): Record<string, DocInfo> {
  const out: Record<string, DocInfo> = {};
  for (const d of docs) {
    const indexed = d.chunks.length > 0 && (presence.get(d.id) ?? 0) >= d.chunks.length;
    if (!indexed && exceedsEmbedLimit(d.chunks.length)) {
      out[d.id] = { text: "ready", vector: "unavailable", vectorNote: embedLimitNote(d.chunks.length), tooLarge: true };
      continue;
    }
    out[d.id] = { text: "ready", vector: indexed ? "indexed" : "pending", ...(indexed ? {} : { vectorNote: "尚未建立語意索引" }) };
  }
  return out;
}

/**
 * 由 IndexedDB 重新取回已 commit 的文字（name / rawText / chunks），供「重新建立索引」使用：
 * 不重新 PARSE 原始檔、不重新 DECONSTRUCT，chunk 邊界與原本完全相同（因此 chunk id 不變、不會產生重複）。
 */
export async function loadStoredDocument(db: HyperforgeDB, docId: string): Promise<{ name: string; rawText: string; chunks: Chunk[] } | null> {
  const doc = await db.docs.get(docId);
  if (!doc) return null;
  const rows = await db.chunks.where("docId").equals(docId).toArray();
  if (!rows.length) return null;
  rows.sort((a, b) => a.index - b.index);
  return {
    name: doc.name,
    rawText: doc.rawText,
    chunks: rows.map((r) => ({ index: r.index, text: doc.rawText.slice(r.start, r.end), start: r.start, end: r.end, tokenCount: r.tokenCount })),
  };
}
