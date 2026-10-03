import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkText } from "../pipeline/chunker";
import { HyperforgeDB } from "./db";
import { FakeEmbedder } from "./fake-embedder.test-util";
import { HNSW } from "./hnsw";
import { clearIndex, loadIndex } from "./hnsw-persist";
import { VectorStore } from "./index-store";

let n = 0;
const dbs: HyperforgeDB[] = [];
function open(name: string) {
  const db = new HyperforgeDB(name);
  dbs.push(db);
  return db;
}
afterEach(async () => {
  for (const d of dbs.splice(0)) {
    d.close();
    await d.delete();
  }
});

const text = (k: number) => Array.from({ length: k }, (_, i) => `w${i}`).join(" ");
const input = (raw: string) => ({ name: "a.md", rawText: raw, chunks: chunkText(raw) });

describe("HNSW 持久化", () => {
  it("重新開啟時直接載入序列化索引，不再由 vectors 表逐筆 add，且搜尋結果相同", async () => {
    const name = `p${Date.now()}-${n++}`;
    const e = new FakeEmbedder();
    const s1 = new VectorStore(open(name), e);
    await s1.init();
    await s1.ingest(input(text(1200)), () => undefined);
    const before = await s1.search("w0 w1 w2", 3);

    const addSpy = vi.spyOn(HNSW.prototype, "add");
    const s2 = new VectorStore(open(name), e);
    await s2.init();
    expect(addSpy).not.toHaveBeenCalled();
    addSpy.mockRestore();
    expect(s2.indexSize).toBe(s1.indexSize);
    expect(await s2.search("w0 w1 w2", 3)).toEqual(before);
  });

  it("索引與 vectors 表不一致時丟棄並重建", async () => {
    const name = `p${Date.now()}-${n++}`;
    const e = new FakeEmbedder();
    const db = open(name);
    const s1 = new VectorStore(db, e);
    await s1.init();
    await s1.ingest(input(text(1200)), () => undefined);
    const first = (await db.vectors.toCollection().primaryKeys())[0];
    await db.vectors.delete(first);
    expect(await loadIndex(db, { model: e.id, dim: e.dim })).toBeNull();
    const s2 = new VectorStore(open(name), e);
    await s2.init();
    expect(s2.indexSize).toBe(await db.vectors.count());
  });

  it("model / dim 不符時不載入；clearIndex 後為 null", async () => {
    const db = open(`p${Date.now()}-${n++}`);
    const e = new FakeEmbedder();
    const s = new VectorStore(db, e);
    await s.init();
    await s.ingest(input(text(300)), () => undefined);
    expect(await loadIndex(db, { model: e.id, dim: e.dim })).not.toBeNull();
    expect(await loadIndex(db, { model: "other", dim: e.dim })).toBeNull();
    await clearIndex(db);
    expect(await loadIndex(db, { model: e.id, dim: e.dim })).toBeNull();
  });
});
