import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkText } from "../pipeline/chunker";
import { HyperforgeDB } from "./db";
import { FakeEmbedder } from "./fake-embedder.test-util";
import { VectorStore, ModelMismatchError } from "./index-store";

let n = 0;
const dbs: HyperforgeDB[] = [];
function fresh(name = `t${Date.now()}-${n++}`, embedder = new FakeEmbedder()) {
  const db = new HyperforgeDB(name);
  dbs.push(db);
  return { db, name, store: new VectorStore(db, embedder) };
}
afterEach(async () => {
  for (const d of dbs.splice(0)) {
    d.close();
    await d.delete();
  }
});

const text = (n: number, prefix = "w") => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
const input = (raw: string, name = "a.md") => ({ name, rawText: raw, chunks: chunkText(raw) });

describe("VectorStore", () => {
  it("ingest 寫入 docs/chunks/vectors，chunk id 為 docId:index，可搜尋", async () => {
    const { db, store } = fresh();
    await store.init();
    const raw = text(1200);
    const res = await store.ingest(input(raw), () => undefined);
    expect(res.duplicate).toBe(false);
    const chunks = await db.chunks.toArray();
    expect(chunks.length).toBe(await db.vectors.count());
    expect(chunks.map((c) => c.id).sort()).toEqual(chunks.map((c) => `${res.docId}:${c.index}`).sort());
    expect(store.indexSize).toBe(chunks.length);
    const hits = await store.search("w0 w1 w2", 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.docId).toBe(res.docId);
  });

  it("重複內容不產生重複 doc / chunk / 索引節點", async () => {
    const { db, store } = fresh();
    await store.init();
    const raw = text(600);
    await store.ingest(input(raw, "a.md"), () => undefined);
    const counts = [await db.docs.count(), await db.chunks.count(), store.indexSize];
    const again = await store.ingest(input(raw, "copy.md"), () => undefined);
    expect(again.duplicate).toBe(true);
    expect([await db.docs.count(), await db.chunks.count(), store.indexSize]).toEqual(counts);
  });

  it("Float32Array subarray 往返值相等", async () => {
    const big = new Float32Array(200).map((_, i) => i + 1);
    const sub = big.subarray(10, 74); // dim 64，buffer 位移 40 bytes
    const embedder = new FakeEmbedder(64);
    vi.spyOn(embedder, "embed").mockImplementation(async (texts) => texts.map(() => sub));
    const { db, store } = fresh(undefined, embedder);
    await store.init();
    const raw = "hello world";
    const { docId } = await store.ingest(input(raw), () => undefined);
    const row = await db.vectors.get(`${docId}:0`);
    expect(Array.from(row!.vec)).toEqual(Array.from(sub));
    expect(row!.vec.buffer.byteLength).toBe(64 * 4); // 沒有把整塊大 buffer 存進去
  });

  it("中途 abort：docs / chunks / vectors 皆為 0，索引為空", async () => {
    const { db, store } = fresh();
    await store.init();
    const ac = new AbortController();
    const raw = text(20000); // 約 45 個 chunk → 3 個 batch
    await expect(
      store.ingest(input(raw), (p) => p > 0 && p < 1 && ac.abort(), ac.signal),
    ).rejects.toThrow();
    expect([await db.docs.count(), await db.chunks.count(), await db.vectors.count(), store.indexSize]).toEqual([0, 0, 0, 0]);
  });

  it("transaction 失敗回滾：不留半個 doc，也不動索引", async () => {
    const { db, store } = fresh();
    await store.init();
    vi.spyOn(db.vectors, "bulkAdd").mockRejectedValue(new Error("boom"));
    await expect(store.ingest(input(text(800)), () => undefined)).rejects.toThrow("boom");
    expect([await db.docs.count(), await db.chunks.count(), await db.vectors.count(), store.indexSize]).toEqual([0, 0, 0, 0]);
  });

  it("embedder 回傳維度或數量錯誤 → 丟錯且不寫入", async () => {
    const embedder = new FakeEmbedder(64);
    vi.spyOn(embedder, "embed").mockResolvedValue([new Float32Array(3)]);
    const { db, store } = fresh(undefined, embedder);
    await store.init();
    await expect(store.ingest(input(text(10)), () => undefined)).rejects.toThrow();
    expect(await db.docs.count()).toBe(0);
  });

  it("meta 的 model/dim 不符 → ModelMismatchError", async () => {
    const a = fresh(undefined, new FakeEmbedder(64));
    await a.store.init();
    const b = new VectorStore(a.db, new FakeEmbedder(32));
    await expect(b.init()).rejects.toBeInstanceOf(ModelMismatchError);
  });

  it("重開後由 vectors 表重建索引，搜尋結果一致", async () => {
    const a = fresh();
    await a.store.init();
    await a.store.ingest(input(text(900)), () => undefined);
    const before = (await a.store.search("w10 w11", 3)).map((h) => h.chunk.id);
    const reopened = new VectorStore(a.db, new FakeEmbedder());
    await reopened.init();
    expect(reopened.indexSize).toBe(a.store.indexSize);
    expect((await reopened.search("w10 w11", 3)).map((h) => h.chunk.id)).toEqual(before);
  });

  it("未 init 就 ingest/search 會丟錯", async () => {
    const { store } = fresh();
    await expect(store.ingest(input("a"), () => undefined)).rejects.toThrow();
    await expect(store.search("a", 1)).rejects.toThrow();
  });

  it("並發 ingest 同內容：一個 duplicate:false、一個 true，筆數與索引不翻倍", async () => {
    const { db, store } = fresh();
    await store.init();
    const raw = text(700);
    const [a, b] = await Promise.all([
      store.ingest(input(raw, "a.md"), () => undefined),
      store.ingest(input(raw, "b.md"), () => undefined),
    ]);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(await db.docs.count()).toBe(1);
    const chunkCount = await db.chunks.count();
    expect(await db.vectors.count()).toBe(chunkCount);
    expect(store.indexSize).toBe(chunkCount);
  });

  it("search 的 chunk.text 由 rawText 依 start/end 切出", async () => {
    const { store } = fresh();
    await store.init();
    const raw = "Hello,\n你好，世界。 " + text(30);
    await store.ingest(input(raw), () => undefined);
    const [hit] = await store.search("Hello", 1);
    expect(hit.chunk.text).toBe(raw.slice(hit.chunk.start, hit.chunk.end));
  });

  it("stored schemaVersion 比程式新 → 拒絕開啟", async () => {
    const { db, store } = fresh();
    await db.meta.put({ key: "schemaVersion", value: 999 });
    await expect(store.init()).rejects.toThrow("schema");
  });
});
