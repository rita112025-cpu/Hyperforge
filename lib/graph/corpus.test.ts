import { afterEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { chunkText } from "../pipeline/chunker";
import { runPipeline } from "../pipeline/runner";
import { HyperforgeDB } from "../vector/db";
import { FakeEmbedder } from "../vector/fake-embedder.test-util";
import { VectorStore } from "../vector/index-store";
import { createStoreGetter } from "../vector/runtime";
import { buildGraph } from "./build";
import { contentIdOf, docFromJobResult, docInfoFromDb, loadCorpus, loadStoredDocument, loadVectorPresence, saveDocument } from "./corpus";

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
    expect(out.vectorStatus).toBe("unavailable"); // 向量功能 = PARTIAL
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

describe("文字 commit 的原子性與冪等（docs + chunks 同一個 transaction）", () => {
  it("chunks 寫入失敗 → 整個 transaction rollback：docs 也不存在（不會出現「doc 已存在但 chunks 缺」）；之後重試可正常寫入", async () => {
    const db = await freshDb();
    const i = input("big.txt", Array.from({ length: 1300 }, (_, k) => `w${k}`).join(" "));
    const spy = vi.spyOn(db.chunks, "bulkAdd").mockRejectedValueOnce(new Error("disk full"));
    await expect(saveDocument(db, i)).rejects.toThrow("disk full");
    expect([await db.docs.count(), await db.chunks.count()]).toEqual([0, 0]); // 沒有半份文件
    spy.mockRestore();
    const ok = await saveDocument(db, i);
    expect(ok?.created).toBe(true);
    expect([await db.docs.count(), await db.chunks.count()]).toEqual([1, i.chunks.length]);
  });

  it("冪等：同一份內容重複 commit，document 與 chunk 數量都不增加", async () => {
    const db = await freshDb();
    const i = input("big.txt", Array.from({ length: 1300 }, (_, k) => `w${k}`).join(" "));
    for (let k = 0; k < 3; k++) await saveDocument(db, i);
    expect([await db.docs.count(), await db.chunks.count()]).toEqual([1, i.chunks.length]);
  });

  it("並發 commit 同一份內容：只有一份 document、chunks 不重複", async () => {
    const db = await freshDb();
    const i = input("big.txt", Array.from({ length: 1300 }, (_, k) => `w${k}`).join(" "));
    const results = await Promise.all([saveDocument(db, i), saveDocument(db, i), saveDocument(db, i)]);
    expect(results.filter((r) => r?.created).length).toBe(1);
    expect([await db.docs.count(), await db.chunks.count()]).toEqual([1, i.chunks.length]);
  });
});

describe("loadStoredDocument / loadVectorPresence / docInfoFromDb（重新整理與 retry 用；都不需要 embedder）", () => {
  const BIG = Array.from({ length: 1300 }, (_, k) => `w${k}`).join(" ");

  it("loadStoredDocument：取回的 name / rawText / chunks 與當初 commit 的逐筆相同（retry 不需要重新 PARSE / DECONSTRUCT）", async () => {
    const db = await freshDb();
    const i = input("big.txt", BIG);
    const saved = await saveDocument(db, i);
    const back = await loadStoredDocument(db, saved!.docId);
    expect(back).toEqual({ name: "big.txt", rawText: BIG, chunks: i.chunks });
  });

  it("loadStoredDocument：不存在的 doc 回傳 null", async () => {
    const db = await freshDb();
    expect(await loadStoredDocument(db, "nope")).toBeNull();
  });

  it("loadVectorPresence 只讀向量表的主鍵，不載入向量值；以 docId 彙總筆數", async () => {
    const db = await freshDb();
    const store = new VectorStore(db, new FakeEmbedder());
    await store.init();
    const a = input("a.txt", BIG);
    const b = input("b.txt", TEXT_A);
    await saveDocument(db, a);
    await saveDocument(db, b); // b 只有文字
    const resA = await store.ingest(a, () => undefined);
    const valuesSpy = vi.spyOn(db.vectors, "toArray");
    const presence = await loadVectorPresence(db);
    expect(valuesSpy).not.toHaveBeenCalled(); // 沒有載入 Float32Array
    expect(presence.get(resA.docId)).toBe(a.chunks.length);
    expect(presence.size).toBe(1);
    valuesSpy.mockRestore();
  });

  it("docInfoFromDb：向量筆數 ≥ chunk 數 → indexed；否則 pending（尚未建立）；文字一律 ready", async () => {
    const db = await freshDb();
    const store = new VectorStore(db, new FakeEmbedder());
    await store.init();
    const a = input("a.txt", BIG);
    const b = input("b.txt", TEXT_A);
    await saveDocument(db, a);
    await saveDocument(db, b);
    await store.ingest(a, () => undefined);
    const docs = await loadCorpus(db);
    const info = docInfoFromDb(docs, await loadVectorPresence(db));
    const byName = Object.fromEntries(docs.map((d) => [d.name, info[d.id]]));
    expect(byName["a.txt"]).toEqual({ text: "ready", vector: "indexed" });
    expect(byName["b.txt"]).toMatchObject({ text: "ready", vector: "pending" });
  });
});
