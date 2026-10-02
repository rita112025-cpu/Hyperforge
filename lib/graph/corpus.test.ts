import { afterEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { chunkText } from "../pipeline/chunker";
import { runPipeline } from "../pipeline/runner";
import { HyperforgeDB } from "../vector/db";
import { FakeEmbedder } from "../vector/fake-embedder.test-util";
import { VectorStore } from "../vector/index-store";
import { createStoreGetter } from "../vector/runtime";
import { buildGraph } from "./build";
import { contentIdOf, docFromJobResult, loadCorpus, saveDocument } from "./corpus";

const TEXT_A = "電纜槽淨距不足，需要調整弱電橋架位置。弱電橋架與電纜槽之間必須保留足夠間距。";
const TEXT_B = "alpha bravo charlie. alpha bravo. charlie alpha. alpha.";
const input = (name: string, rawText: string) => ({ name, rawText, chunks: chunkText(rawText) });

const opened: HyperforgeDB[] = [];
async function freshDb(): Promise<HyperforgeDB> {
  const db = new HyperforgeDB(`corpus-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  opened.push(db);
  return db;
}
afterEach(async () => {
  for (const db of opened.splice(0)) {
    db.close();
    await db.delete();
  }
});

describe("文字持久化（與 embedding 無關）", () => {
  it("saveDocument 只寫 docs + chunks，不寫 vectors；重複呼叫為 no-op", async () => {
    const db = await freshDb();
    const first = await saveDocument(db, input("a.md", TEXT_A));
    expect(first?.created).toBe(true);
    expect([await db.docs.count(), await db.chunks.count(), await db.vectors.count()]).toEqual([1, 1, 0]);
    const second = await saveDocument(db, input("renamed.md", TEXT_A));
    expect(second).toEqual({ docId: first!.docId, created: false });
    expect(await db.docs.count()).toBe(1);
  });

  it("docId 與 VectorStore 使用的內容雜湊相同（同一份內容不會有兩個 id）", async () => {
    const db = await freshDb();
    const saved = await saveDocument(db, input("a.md", TEXT_A));
    expect(saved!.docId).toBe((await contentIdOf(TEXT_A)).id);
  });

  it("空文件（無 chunk）不寫入", async () => {
    const db = await freshDb();
    expect(await saveDocument(db, input("empty", ""))).toBeNull();
    expect(await db.docs.count()).toBe(0);
  });

  it("loadCorpus 還原文件與 chunk 位移；text = rawText.slice(start, end)", async () => {
    const db = await freshDb();
    const big = Array.from({ length: 1300 }, (_, i) => `w${i}`).join(" ");
    await saveDocument(db, input("big.txt", big));
    const [d] = await loadCorpus(db);
    expect(d.name).toBe("big.txt");
    expect(d.rawText).toBe(big);
    expect(d.chunks.map((c) => c.index)).toEqual([...d.chunks.map((c) => c.index)].sort((a, b) => a - b));
    const expected = chunkText(big);
    expect(d.chunks).toEqual(expected.map((c) => ({ index: c.index, start: c.start, end: c.end })));
  });
});

describe("reload：由 IndexedDB 重建 graph，不需要 embedder", () => {
  it("loadCorpus + buildGraph 還原多份文件（無任何 embedder 參與；runtime 層級的證明見 reload-no-embedder.test.ts）", async () => {
    const db = await freshDb();
    await saveDocument(db, input("a.md", TEXT_A));
    await saveDocument(db, input("b.txt", TEXT_B));
    const g = buildGraph(await loadCorpus(db));
    expect(g.nodes.map((n) => n.key)).toEqual(expect.arrayContaining(["電纜槽", "弱電", "橋架", "alpha", "bravo", "charlie"]));
    expect(g.stats.docCount).toBe(2);
  });

  it("模型不可用（isAvailable=false）：向量化略過、文字仍可持久化，重載後 graph 不是空的", async () => {
    const db = await freshDb();
    const store = new VectorStore(db, new FakeEmbedder(64, false));
    await store.init();
    const out = await runPipeline({ kind: "text", text: TEXT_A }, { store, onStage: () => undefined });
    expect(out.indexed).toBe(false); // 向量功能 = PARTIAL
    expect(await db.docs.count()).toBe(0); // runner 本身不寫文字；由 saveDocument 負責
    await saveDocument(db, out);
    expect([await db.docs.count(), await db.vectors.count()]).toEqual([1, 0]);

    const g = buildGraph(await loadCorpus(db));
    expect(g.nodes.length).toBeGreaterThanOrEqual(3);
  });

  it("向量庫為舊模型建立（ModelMismatchError）：getStore 回報不可用，但文字持久化與畫布重建不受影響", async () => {
    const dbName = `mismatch-${Date.now()}`;
    const db = new HyperforgeDB(dbName);
    opened.push(db);
    await db.meta.bulkPut([{ key: "embed", value: { model: "old-model", dim: 999 } }]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined); // runtime 對 ModelMismatchError 的既有 console.error
    const getStore = createStoreGetter({
      createDb: () => db,
      createEmbedder: () => new FakeEmbedder(64, true),
      isBrowser: () => true,
    });
    const { store, reason } = await getStore();
    errSpy.mockRestore();
    expect(store).toBeNull();
    expect(reason).toMatch(/舊模型/);

    await saveDocument(db, input("a.md", TEXT_A));
    const g = buildGraph(await loadCorpus(db));
    expect(g.nodes.length).toBeGreaterThanOrEqual(3);
  });

  it("job 記憶體結果直接進 builder（不讀 DB）：docFromJobResult → buildGraph", async () => {
    const out = await runPipeline({ kind: "text", text: TEXT_A }, { onStage: () => undefined });
    const { id } = await contentIdOf(out.rawText);
    const g = buildGraph([docFromJobResult(out, id)]);
    expect(g.nodes.map((n) => n.key)).toEqual(expect.arrayContaining(["電纜槽", "弱電", "橋架"]));
  });

  it("記憶體 job 與 DB 內是同一份內容：union 後只算一份（node freq 不翻倍）", async () => {
    const db = await freshDb();
    const saved = await saveDocument(db, input("a.md", TEXT_A));
    const live = docFromJobResult(input("a.md", TEXT_A), saved!.docId);
    const fromDb = await loadCorpus(db);
    const merged = buildGraph([...fromDb, live]);
    const single = buildGraph(fromDb);
    expect(merged.nodes.map((n) => [n.id, n.freq])).toEqual(single.nodes.map((n) => [n.id, n.freq]));
  });
});

describe("文字先行持久化後補寫向量（index-store.ingest）", () => {
  it("文字已存在但無向量：ingest 補寫向量（duplicate=false），docs 不重複；再次 ingest 才是 duplicate", async () => {
    const db = await freshDb();
    const i = input("a.md", TEXT_A);
    await saveDocument(db, i);
    const store = new VectorStore(db, new FakeEmbedder());
    await store.init();

    const first = await store.ingest(i, () => undefined);
    expect(first.duplicate).toBe(false);
    expect([await db.docs.count(), await db.chunks.count(), await db.vectors.count()]).toEqual([1, i.chunks.length, i.chunks.length]);
    expect(store.indexSize).toBe(i.chunks.length);

    const second = await store.ingest(i, () => undefined);
    expect(second.duplicate).toBe(true);
    expect(await db.vectors.count()).toBe(i.chunks.length);
  });

  it("ingest 先成功、saveDocument 後呼叫：no-op，不破壞向量", async () => {
    const db = await freshDb();
    const store = new VectorStore(db, new FakeEmbedder());
    await store.init();
    const i = input("a.md", TEXT_A);
    const res = await store.ingest(i, () => undefined);
    const saved = await saveDocument(db, i);
    expect(saved).toEqual({ docId: res.docId, created: false });
    expect(await db.vectors.count()).toBe(i.chunks.length);
  });
});
