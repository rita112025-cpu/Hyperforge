import type { Chunk } from "../pipeline/chunker";
import { SCHEMA_VERSION, type ChunkRow, type EmbedMeta, type HyperforgeDB } from "./db";
import type { Embedder } from "./embedder";
import { sha256Hex } from "./hash";
import { HNSW } from "./hnsw";

export class ModelMismatchError extends Error {
  constructor(public stored: EmbedMeta, public current: EmbedMeta) {
    super(
      `向量庫是以 ${stored.model}(dim ${stored.dim}) 建立，目前模型為 ${current.model}(dim ${current.dim})；` +
        `混用會讓搜尋結果全錯，請重新計算向量。`,
    );
    this.name = "ModelMismatchError";
  }
}

const BATCH = 16;

function isConstraintError(e: unknown): boolean {
  const err = e as { name?: string; failures?: unknown[] } | null;
  if (err?.name === "ConstraintError") return true;
  return Array.isArray(err?.failures) && err!.failures.some((f) => (f as { name?: string })?.name === "ConstraintError");
}

export type ChunkHit = ChunkRow & { text: string };

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

export interface IngestResult {
  docId: string;
  /** true = 內容已存在，未重複寫入 */
  duplicate: boolean;
}

export class VectorStore {
  private index: HNSW | null = null;

  constructor(
    readonly db: HyperforgeDB,
    readonly embedder: Embedder,
  ) {}

  isAvailable(): Promise<boolean> {
    return this.embedder.isAvailable();
  }

  get indexSize(): number {
    return this.index?.size ?? 0;
  }

  /**
   * 該內容是否「已完整寫入」：doc 存在，且（沒有任何 chunk 需要向量，或向量已存在）。
   * 只有 doc 沒有向量 = 文字先前已由 saveDocument 持久化（當時 embedder 不可用），需要補寫向量。
   */
  private async isIndexed(docId: string, chunkCount: number): Promise<boolean> {
    if (!(await this.db.docs.get(docId))) return false;
    return chunkCount === 0 || (await this.db.vectors.where("docId").equals(docId).count()) > 0;
  }

  /** 檢查 meta（model/dim 不符則拒絕），並由 vectors 表在記憶體中重建 HNSW。 */
  async init(): Promise<void> {
    const current: EmbedMeta = { model: this.embedder.id, dim: this.embedder.dim };
    const storedSchema = (await this.db.meta.get("schemaVersion"))?.value;
    if (typeof storedSchema === "number" && storedSchema > SCHEMA_VERSION) {
      throw new Error(`資料庫 schema v${storedSchema} 比程式支援的 v${SCHEMA_VERSION} 新，請更新程式。`);
    }
    const stored = (await this.db.meta.get("embed"))?.value as EmbedMeta | undefined;
    if (stored && (stored.model !== current.model || stored.dim !== current.dim)) {
      throw new ModelMismatchError(stored, current);
    }
    if (!stored) {
      await this.db.meta.bulkPut([
        { key: "embed", value: current },
        { key: "schemaVersion", value: SCHEMA_VERSION },
      ]);
    }
    const index = new HNSW({ dim: current.dim });
    const rows = await this.db.vectors.toArray();
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // 重建順序決定性
    for (const r of rows) index.add(r.id, r.vec);
    this.index = index;
  }

  /**
   * 先算完全部向量，再以單一 transaction 寫入 docs+chunks+vectors；
   * 取消或任何失敗都不會留下半個 doc。
   */
  async ingest(
    input: { name: string; rawText: string; chunks: Chunk[] },
    report: (p: number) => void,
    signal?: AbortSignal,
  ): Promise<IngestResult> {
    if (!this.index) throw new Error("VectorStore.init() 尚未呼叫");
    const docId = await sha256Hex(input.rawText);
    const existing = await this.db.docs.get(docId);
    if (await this.isIndexed(docId, input.chunks.length)) {
      report(1);
      return { docId, duplicate: true };
    }
    // existing 但沒有向量 = 文字先前已由 saveDocument 持久化（當時 embedder 不可用）；只補寫 chunks 與向量。

    const { chunks } = input;
    const vectors: Float32Array[] = [];
    for (let i = 0; i < chunks.length; i += BATCH) {
      abortIfNeeded(signal);
      const batch = chunks.slice(i, i + BATCH);
      const out = await this.embedder.embed(batch.map((c) => c.text), { signal });
      if (out.length !== batch.length) throw new Error("embedder 回傳數量與輸入不符");
      for (const v of out) {
        if (v.length !== this.embedder.dim) throw new Error(`向量維度 ${v.length} ≠ ${this.embedder.dim}`);
        vectors.push(new Float32Array(v)); // 複本：避免存到別的 buffer 的 subarray
      }
      report(vectors.length / chunks.length);
    }
    abortIfNeeded(signal);

    const ids = chunks.map((c) => `${docId}:${c.index}`);
    const chunkRows: ChunkRow[] = chunks.map((c, i) => ({
      id: ids[i],
      docId,
      index: c.index,
      start: c.start,
      end: c.end,
      tokenCount: c.tokenCount,
    }));
    const { db } = this;
    try {
      await db.transaction("rw", db.docs, db.chunks, db.vectors, async () => {
        if (!existing) {
          await db.docs.add({ id: docId, name: input.name, createdAt: Date.now(), chunkCount: chunks.length, rawText: input.rawText });
        }
        await db.chunks.bulkPut(chunkRows); // 文字先行持久化時已存在，內容相同（決定性主鍵）
        await db.vectors.bulkAdd(ids.map((id, i) => ({ id, docId, vec: vectors[i] })));
      });
    } catch (e) {
      // 並發 ingest 同一內容：另一個 job 先寫入，transaction 已回滾；視為「已存在」
      if (isConstraintError(e) && (await this.isIndexed(docId, chunks.length))) {
        report(1);
        return { docId, duplicate: true };
      }
      throw e;
    }
    // 寫入成功後才動記憶體索引，避免索引與 DB 不一致
    // HNSW.add 對重複 id 會丟錯（而此時 DB 已 commit）。補寫 / 重新建立索引時，記憶體索引可能仍保有舊的同 id 向量
    // （例如向量表曾被清除）；同一個模型下向量相同，略過即可（HNSW 沒有 replace；重新載入頁面時會由 DB 重建）。
    ids.forEach((id, i) => {
      if (!this.index!.has(id)) this.index!.add(id, vectors[i]);
    });
    report(1);
    return { docId, duplicate: false };
  }

  async search(query: string, k: number): Promise<{ chunk: ChunkHit; score: number }[]> {
    if (!this.index) throw new Error("VectorStore.init() 尚未呼叫");
    const [q] = await this.embedder.embed([query]);
    const hits = this.index.search(q, k);
    const rows = await this.db.chunks.bulkGet(hits.map((h) => h.id));
    const docIds = [...new Set(rows.flatMap((r) => (r ? [r.docId] : [])))];
    const docs = new Map((await this.db.docs.bulkGet(docIds)).flatMap((d) => (d ? [[d.id, d] as const] : [])));
    return hits.flatMap((h, i) => {
      const row = rows[i];
      const doc = row && docs.get(row.docId);
      return row && doc ? [{ chunk: { ...row, text: doc.rawText.slice(row.start, row.end) }, score: h.score }] : [];
    });
  }
}
