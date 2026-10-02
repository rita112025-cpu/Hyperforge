import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { buildGraph } from "./graph/build";
import { docInfoFromDb, loadCorpus, loadVectorPresence } from "./graph/corpus";
import { canRetryIndexing } from "./pipeline/doc-state";
import { chunkText } from "./pipeline/chunker";
import type { IngestJob } from "./pipeline/types";
import { HyperforgeDB } from "./vector/db";
import { FakeEmbedder } from "./vector/fake-embedder.test-util";

// 整合點測試：useForge 的 text-first 生命週期（text commit point / 取消語意 / 重載 / retry）。
// runtime（會碰真 embedder）與 shared-db 以測試替身取代；VectorStore 與 IndexedDB（fake-indexeddb）是真的。
let testDb: HyperforgeDB;
let dbShouldThrow = false;
/** none = 模型不可用；ok = 向量化成功；throw = 模型檔存在但推論丟錯 */
let mode: "none" | "ok" | "throw" = "none";
/** 非 null 時，embedding 會卡住直到 release()（模擬模型下載停滯 / 推論很慢） */
let gate: { promise: Promise<void>; release: () => void } | null = null;
let embedCalls = 0;
let getStoreCalls = 0;
const base = new FakeEmbedder(8);

vi.mock("./vector/runtime", () => ({
  getVectorStore: async () => {
    getStoreCalls++;
    if (mode === "none") return { store: null, reason: "模型未安裝（測試）" };
    const { VectorStore } = await import("./vector/index-store");
    const store = new VectorStore(testDb, {
      id: base.id,
      dim: base.dim,
      isAvailable: async () => true,
      embed: async (texts: string[]) => {
        embedCalls++;
        if (gate) await gate.promise;
        if (mode === "throw") throw new Error("embed failed mid-way");
        return base.embed(texts);
      },
    });
    await store.init();
    return { store };
  },
}));
vi.mock("./vector/shared-db", () => ({
  getSharedDb: () => {
    if (dbShouldThrow) throw new Error("IndexedDB 被封鎖（測試）");
    return testDb;
  },
}));

const TEXT = "電纜槽淨距不足，需要調整弱電橋架位置。弱電橋架與電纜槽之間必須保留足夠間距。";
/** 多 chunk 的文件（chunk 完整性） */
const LONG = Array.from({ length: 1300 }, (_, i) => `w${i}`).join(" ");
const textSource = (text: string) => ({ kind: "text" as const, text });

async function freshStore() {
  vi.resetModules();
  const { useForge } = await import("./store");
  return useForge;
}
type Store = Awaited<ReturnType<typeof freshStore>>;

const counts = async () => ({ docs: await testDb.docs.count(), chunks: await testDb.chunks.count(), vectors: await testDb.vectors.count() });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 當 predicate 第一次成立時（在 store 更新的當下、同步地）取消這個 job。 */
function cancelWhen(useForge: Store, predicate: (job: IngestJob) => boolean) {
  const unsub = useForge.subscribe((s) => {
    const j = s.jobs[0];
    if (j && predicate(j)) {
      unsub();
      useForge.getState().cancel(j.id);
    }
  });
}
const stage = (j: IngestJob, id: string) => j.stages.find((s) => s.id === id)?.status;

beforeEach(() => {
  testDb = new HyperforgeDB(`store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dbShouldThrow = false;
  mode = "none";
  gate = null;
  embedCalls = 0;
  getStoreCalls = 0;
});
afterEach(async () => {
  gate?.release();
  testDb.close();
  await testDb.delete();
});

function makeGate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  gate = { promise, release };
  return gate;
}

describe("useForge.ingest：即時來源與文字持久化（與向量化無關）", () => {
  it("模型不可用：job 為 PARTIAL，但 docs 已有該文件、IndexedDB 已有文字（沒有向量）", async () => {
    const useForge = await freshStore();
    await useForge.getState().ingest(textSource(TEXT));
    const s = useForge.getState();
    expect(s.jobs[0].status).toBe("partial");
    expect(s.jobs[0].textStatus).toBe("ready");
    expect(s.jobs[0].vectorStatus).toBe("unavailable");
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].rawText).toBe(TEXT);
    expect(s.docs[0].id).toMatch(/^[0-9a-f]{64}$/); // 與 IndexedDB docs.id 相同的 SHA-256
    expect(await counts()).toEqual({ docs: 1, chunks: s.docs[0].chunks.length, vectors: 0 });
    expect((await testDb.docs.get(s.docs[0].id))?.rawText).toBe(TEXT);
  });

  it("向量化中途失敗（模型檔存在但推論丟錯）→ job=partial、vectorStatus=failed、文字保留、畫布不空", async () => {
    mode = "throw";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const useForge = await freshStore();
    await useForge.getState().ingest(textSource(TEXT));
    errSpy.mockRestore();
    const s = useForge.getState();
    expect(s.jobs[0].status).toBe("partial");
    expect(s.jobs[0].error).toBeUndefined();
    expect([s.jobs[0].textStatus, s.jobs[0].vectorStatus]).toEqual(["ready", "failed"]);
    expect(s.jobs[0].stages.find((x) => x.id === "LINK")?.note).toMatch(/向量化失敗：embed failed mid-way/);
    expect(s.docs).toHaveLength(1);
    expect(s.docInfo[s.docs[0].id]).toMatchObject({ text: "ready", vector: "failed" });
    expect(await counts()).toMatchObject({ docs: 1, vectors: 0 });
  });

  it("全部成功 → job=done（completed）、textStatus=ready、vectorStatus=indexed、向量數 = chunk 數", async () => {
    mode = "ok";
    const useForge = await freshStore();
    await useForge.getState().ingest(textSource(LONG));
    const s = useForge.getState();
    expect(s.jobs[0].status).toBe("done");
    expect([s.jobs[0].textStatus, s.jobs[0].vectorStatus]).toEqual(["ready", "indexed"]);
    const n = chunkText(LONG).length;
    expect(n).toBeGreaterThan(1);
    expect(await counts()).toEqual({ docs: 1, chunks: n, vectors: n });
    expect(s.docInfo[s.docs[0].id]).toMatchObject({ text: "ready", vector: "indexed" });
  });

  it("文字持久化失敗 → job=partial、textStatus=persist_failed、不做 embedding（連向量庫都不取得）；畫布仍暫時顯示並標示未儲存", async () => {
    mode = "ok";
    dbShouldThrow = true;
    const useForge = await freshStore();
    await useForge.getState().ingest(textSource(TEXT));
    const s = useForge.getState();
    expect(s.jobs[0].status).toBe("partial");
    expect(s.jobs[0].textStatus).toBe("persist_failed");
    expect(s.jobs[0].textNote).toMatch(/未能存入 IndexedDB/);
    expect(s.jobs[0].vectorStatus).toBe("unavailable");
    expect(embedCalls).toBe(0);
    expect(getStoreCalls).toBe(0); // 沒有 primary data 就不建立 derived data
    expect(s.docs).toHaveLength(1); // session 內畫布仍可顯示
    expect(s.docInfo[s.docs[0].id]).toMatchObject({ text: "persist_failed", vector: "unavailable" });
    expect(canRetryIndexing(s.docInfo[s.docs[0].id])).toBe(false); // 文字沒保存，不開放 retry
    dbShouldThrow = false;
    expect(await counts()).toEqual({ docs: 0, chunks: 0, vectors: 0 });
  });

  it("空輸入 / 失敗的 job 不會產生 doc；doc 只在 text commit 時追加一次（不是每個 progress 事件）", async () => {
    const useForge = await freshStore();
    const seen: number[] = [];
    const unsub = useForge.subscribe((st) => seen.push(st.docs.length));
    await useForge.getState().ingest(textSource(""));
    await useForge.getState().ingest({ kind: "url", url: "https://example.com", subtype: "web" }); // 本輪不支援 → error
    expect(useForge.getState().docs).toHaveLength(0);
    expect(useForge.getState().jobs.map((j) => [j.status, j.textStatus]).sort()).toEqual([["error", "pending"], ["partial", "pending"]]);
    await useForge.getState().ingest(textSource(TEXT));
    unsub();
    const changes = seen.filter((n, i) => i === 0 || n !== seen[i - 1]);
    expect(changes.filter((n) => n === 1)).toHaveLength(1);
  });
});

describe("Canvas timing：DECONSTRUCT 完成 → text commit → Canvas 立即出現；embedding 繼續跑", () => {
  it("embedding 卡住時，文件已在 Canvas 與 IndexedDB；job 仍是 running；放行後才變 done", async () => {
    mode = "ok";
    const g = makeGate();
    const useForge = await freshStore();
    const p = useForge.getState().ingest(textSource(LONG));
    await vi.waitFor(() => expect(embedCalls).toBe(1)); // embedding 已開始並卡住
    const s = useForge.getState();
    expect(s.jobs[0].status).toBe("running"); // 向量化還沒結束……
    expect(s.docs).toHaveLength(1); // ……但文件已在 Canvas
    expect(s.jobs[0].textStatus).toBe("ready");
    expect(s.docInfo[s.docs[0].id]).toMatchObject({ text: "ready", vector: "building" });
    expect(await counts()).toEqual({ docs: 1, chunks: chunkText(LONG).length, vectors: 0 }); // 文字已持久化、向量還沒有
    g.release();
    await p;
    expect(useForge.getState().jobs[0].status).toBe("done");
    expect((await counts()).vectors).toBe(chunkText(LONG).length);
  });

  it("向量庫（getVectorStore）在 text commit 之後才被取得；commit 之前取消則完全不會取得", async () => {
    mode = "ok";
    const useForge = await freshStore();
    cancelWhen(useForge, (j) => stage(j, "DECONSTRUCT") === "running");
    await useForge.getState().ingest(textSource(TEXT));
    expect(getStoreCalls).toBe(0);
  });
});

describe("取消競態（Cancellation race）：commit 之前取消不留資料；commit 之後取消保留文字", () => {
  const expectNothingKept = async (useForge: Store) => {
    const s = useForge.getState();
    expect(s.jobs[0].status).toBe("cancelled");
    expect(s.jobs[0].status).not.toBe("partial"); // CANCELLED ≠ PARTIAL
    expect([s.jobs[0].textStatus, s.jobs[0].vectorStatus]).toEqual(["pending", "cancelled"]);
    expect(s.docs).toHaveLength(0); // Canvas docs = 0
    expect(s.docInfo).toEqual({}); // 沒有 temporary document
    expect(await counts()).toEqual({ docs: 0, chunks: 0, vectors: 0 }); // DB docs = 0
    expect(getStoreCalls).toBe(0);
  };

  it("Case A：PARSE 進行中取消（檔案 stream 讀取中）→ cancelled、DB 0、Canvas 0", async () => {
    mode = "ok";
    const useForge = await freshStore();
    const p = useForge.getState().ingest({ kind: "file", file: new File([LONG], "a.txt", { type: "text/plain" }) });
    useForge.getState().cancel(useForge.getState().jobs[0].id);
    await p;
    await expectNothingKept(useForge);
  });

  it("Case A'：job 一建立就取消（PARSE 尚未完成）→ 同樣不留任何資料", async () => {
    mode = "ok";
    const useForge = await freshStore();
    const p = useForge.getState().ingest(textSource(LONG));
    useForge.getState().cancel(useForge.getState().jobs[0].id);
    await p;
    await expectNothingKept(useForge);
  });

  it("Case B：DECONSTRUCT 進行中取消 → cancelled、DB 0、Canvas 0（不留半完成 chunks）", async () => {
    mode = "ok";
    const useForge = await freshStore();
    cancelWhen(useForge, (j) => stage(j, "DECONSTRUCT") === "running");
    await useForge.getState().ingest(textSource(LONG));
    await expectNothingKept(useForge);
  });

  it("commit 之前的最後一刻取消（DECONSTRUCT 剛完成）→ DB 0、Canvas 0", async () => {
    mode = "ok";
    const useForge = await freshStore();
    cancelWhen(useForge, (j) => stage(j, "DECONSTRUCT") === "done");
    await useForge.getState().ingest(textSource(LONG));
    await expectNothingKept(useForge);
  });

  it("Case C：commit 剛完成就取消 → cancelled，DB docs=1、chunks 完整、Canvas docs=1、vectors=0；向量化從未開始", async () => {
    mode = "ok";
    const useForge = await freshStore();
    cancelWhen(useForge, (j) => j.textStatus === "ready");
    await useForge.getState().ingest(textSource(LONG));
    const s = useForge.getState();
    expect(s.jobs[0].status).toBe("cancelled");
    expect(s.jobs[0].status).not.toBe("partial");
    expect([s.jobs[0].textStatus, s.jobs[0].vectorStatus]).toEqual(["ready", "cancelled"]);
    expect(s.docs).toHaveLength(1);
    expect(await counts()).toEqual({ docs: 1, chunks: chunkText(LONG).length, vectors: 0 }); // 文字不 rollback
    expect(embedCalls).toBe(0);
    expect(getStoreCalls).toBe(0);
    expect(s.docInfo[s.docs[0].id]).toMatchObject({ text: "ready", vector: "cancelled" });
    expect(canRetryIndexing(s.docInfo[s.docs[0].id])).toBe(true); // 可「重新建立索引」
  });

  it("Case C'：embedding 進行中取消 → job 立即 cancelled（不必等 embedding）；文字保留；放行後也不會偷偷寫入向量", async () => {
    mode = "ok";
    const g = makeGate();
    const useForge = await freshStore();
    const p = useForge.getState().ingest(textSource(LONG));
    await vi.waitFor(() => expect(embedCalls).toBe(1));
    useForge.getState().cancel(useForge.getState().jobs[0].id);
    await p; // gate 尚未放行就已完成：取消即時生效
    const s = useForge.getState();
    expect(s.jobs[0].status).toBe("cancelled");
    expect([s.jobs[0].textStatus, s.jobs[0].vectorStatus]).toEqual(["ready", "cancelled"]);
    expect(await counts()).toEqual({ docs: 1, chunks: chunkText(LONG).length, vectors: 0 });
    g.release(); // 背景的 embedding 完成
    await sleep(60);
    expect((await counts()).vectors).toBe(0); // 取消後不寫入
    expect(useForge.getState().docs).toHaveLength(1);
  });

  it("Case D：embedding 非取消性失敗 → partial（不是 cancelled）、failed、文字保留", async () => {
    mode = "throw";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const useForge = await freshStore();
    await useForge.getState().ingest(textSource(LONG));
    errSpy.mockRestore();
    const s = useForge.getState();
    expect(s.jobs[0].status).toBe("partial");
    expect(s.jobs[0].status).not.toBe("cancelled");
    expect(s.jobs[0].vectorStatus).toBe("failed");
    expect(s.docs).toHaveLength(1);
    expect(await counts()).toMatchObject({ docs: 1, vectors: 0 });
  });

  it("Case D'：模型不可用 → partial、unavailable、文字保留", async () => {
    mode = "none";
    const useForge = await freshStore();
    await useForge.getState().ingest(textSource(LONG));
    const s = useForge.getState();
    expect([s.jobs[0].status, s.jobs[0].textStatus, s.jobs[0].vectorStatus]).toEqual(["partial", "ready", "unavailable"]);
    expect(s.docs).toHaveLength(1);
    expect(await counts()).toMatchObject({ docs: 1, vectors: 0 });
  });

  it("取消一個已經完成的 job 是 no-op（不會把 done 改成 cancelled）", async () => {
    mode = "ok";
    const useForge = await freshStore();
    await useForge.getState().ingest(textSource(TEXT));
    useForge.getState().cancel(useForge.getState().jobs[0].id);
    expect(useForge.getState().jobs[0].status).toBe("done");
  });
});

describe("重新整理（reload）：文字保留、可建圖、不初始化 embedder、語意索引顯示未完成", () => {
  it("import → text commit → 取消 embedding → reload：文件存在、graph 可重建、不呼叫 getVectorStore、vector 狀態為 pending", async () => {
    mode = "ok";
    const useForge = await freshStore();
    cancelWhen(useForge, (j) => j.textStatus === "ready");
    await useForge.getState().ingest(textSource(TEXT + "\n" + TEXT));
    expect(useForge.getState().jobs[0].status).toBe("cancelled");

    // ── 模擬重新整理：全新的 store 實例（沒有任何記憶體狀態），只用 IndexedDB 還原 ──
    getStoreCalls = 0;
    embedCalls = 0;
    const reloaded = await freshStore();
    expect(reloaded.getState().docs).toHaveLength(0);
    const docs = await loadCorpus(testDb);
    const presence = await loadVectorPresence(testDb);
    reloaded.getState().seedDocInfo(docInfoFromDb(docs, presence));

    expect(docs).toHaveLength(1);
    expect(buildGraph(docs).nodes.length).toBeGreaterThan(0); // graph 可重建
    expect(getStoreCalls).toBe(0); // 沒有初始化 embedder / 向量庫
    expect(embedCalls).toBe(0);
    const info = reloaded.getState().docInfo[docs[0].id];
    expect(info).toMatchObject({ text: "ready", vector: "pending" }); // 語意索引：未完成
    expect(canRetryIndexing(info)).toBe(true);
  });

  it("reload 後已有向量的文件顯示 indexed，不開放 retry", async () => {
    mode = "ok";
    const first = await freshStore();
    await first.getState().ingest(textSource(LONG));
    const reloaded = await freshStore();
    const docs = await loadCorpus(testDb);
    reloaded.getState().seedDocInfo(docInfoFromDb(docs, await loadVectorPresence(testDb)));
    const info = reloaded.getState().docInfo[docs[0].id];
    expect(info.vector).toBe("indexed");
    expect(canRetryIndexing(info)).toBe(false);
  });

  it("seedDocInfo 不覆蓋本次 session 已有的即時狀態", async () => {
    mode = "none";
    const useForge = await freshStore();
    await useForge.getState().ingest(textSource(TEXT));
    const id = useForge.getState().docs[0].id;
    useForge.getState().seedDocInfo({ [id]: { text: "ready", vector: "indexed" } });
    expect(useForge.getState().docInfo[id].vector).toBe("unavailable");
  });
});

describe("Retry indexing：只由使用者明確觸發；不重新 PARSE / DECONSTRUCT；不產生 duplicate docs / chunks", () => {
  /** 建立「文字 ready、向量 0」的狀態：模型不可用時匯入。 */
  async function textOnly(text = LONG) {
    mode = "none";
    const useForge = await freshStore();
    await useForge.getState().ingest(textSource(text));
    return { useForge, id: useForge.getState().docs[0].id, n: chunkText(text).length };
  }

  it("text ready、vectors=0 → retry → vectors > 0（= chunk 數）；docs / chunks 數量不變", async () => {
    const { useForge, id, n } = await textOnly();
    const before = await counts();
    expect(before).toEqual({ docs: 1, chunks: n, vectors: 0 });
    mode = "ok";
    await useForge.getState().retryIndexing(id);
    expect(await counts()).toEqual({ docs: 1, chunks: n, vectors: n });
    expect(useForge.getState().docInfo[id]).toMatchObject({ text: "ready", vector: "indexed" });
    expect(useForge.getState().docs).toHaveLength(1);
  });

  it("再 retry 一次：不重複新增（不再 embedding、DB 不變）；按鈕資格已消失", async () => {
    const { useForge, id, n } = await textOnly();
    mode = "ok";
    await useForge.getState().retryIndexing(id);
    const calls = embedCalls;
    await useForge.getState().retryIndexing(id);
    expect(embedCalls).toBe(calls);
    expect(await counts()).toEqual({ docs: 1, chunks: n, vectors: n });
    expect(canRetryIndexing(useForge.getState().docInfo[id])).toBe(false);
  });

  it("retry 使用 IndexedDB 內已 commit 的文字：不重新 PARSE（chunk 內容與邊界逐筆相同）", async () => {
    const { useForge, id } = await textOnly();
    const chunksBefore = await testDb.chunks.toArray();
    mode = "ok";
    await useForge.getState().retryIndexing(id);
    const chunksAfter = await testDb.chunks.toArray();
    expect(chunksAfter.sort((a, b) => a.index - b.index)).toEqual(chunksBefore.sort((a, b) => a.index - b.index));
    expect(useForge.getState().jobs).toHaveLength(1); // retry 不產生新 job
  });

  it("失敗與恢復（recovery）：第一次 embedding 丟錯 → 文字保留、failed；第二次 retry 成功 → indexed", async () => {
    mode = "throw";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const useForge = await freshStore();
    await useForge.getState().ingest(textSource(LONG));
    const id = useForge.getState().docs[0].id;
    expect(useForge.getState().docInfo[id]).toMatchObject({ text: "ready", vector: "failed" });
    expect(await counts()).toMatchObject({ docs: 1, vectors: 0 });
    // retry 仍然失敗：文字保持不變，狀態仍為 failed
    await useForge.getState().retryIndexing(id);
    expect(useForge.getState().docInfo[id]).toMatchObject({ text: "ready", vector: "failed" });
    expect(await counts()).toMatchObject({ docs: 1, vectors: 0 });
    // 模型恢復 → retry 成功
    mode = "ok";
    await useForge.getState().retryIndexing(id);
    errSpy.mockRestore();
    expect(useForge.getState().docInfo[id]).toMatchObject({ text: "ready", vector: "indexed" });
    expect(await counts()).toEqual({ docs: 1, chunks: chunkText(LONG).length, vectors: chunkText(LONG).length });
  });

  it("取消後 retry：取消的 job 之後可補建索引（job 仍是 cancelled，文件變 indexed）", async () => {
    mode = "ok";
    const useForge = await freshStore();
    cancelWhen(useForge, (j) => j.textStatus === "ready");
    await useForge.getState().ingest(textSource(LONG));
    const id = useForge.getState().docs[0].id;
    expect(useForge.getState().docInfo[id].vector).toBe("cancelled");
    await useForge.getState().retryIndexing(id);
    expect(useForge.getState().docInfo[id].vector).toBe("indexed");
    expect(useForge.getState().jobs[0].status).toBe("cancelled"); // 歷史事實不變
    expect((await counts()).vectors).toBe(chunkText(LONG).length);
  });

  it("模型仍不可用時 retry：狀態為 unavailable（附原因），文字與 DB 不變", async () => {
    const { useForge, id, n } = await textOnly();
    await useForge.getState().retryIndexing(id);
    expect(useForge.getState().docInfo[id]).toMatchObject({ text: "ready", vector: "unavailable" });
    expect(useForge.getState().docInfo[id].vectorNote).toMatch(/模型未安裝/);
    expect(await counts()).toEqual({ docs: 1, chunks: n, vectors: 0 });
  });

  it("建立中不可重複觸發（連點兩次只 embedding 一次）", async () => {
    const { useForge, id } = await textOnly();
    mode = "ok";
    const g = makeGate();
    const a = useForge.getState().retryIndexing(id);
    const b = useForge.getState().retryIndexing(id); // 第二次：已 building → no-op
    await vi.waitFor(() => expect(embedCalls).toBe(1));
    expect(useForge.getState().docInfo[id].vector).toBe("building");
    g.release();
    await Promise.all([a, b]);
    expect(embedCalls).toBe(1);
  });

  it("沒有資格的 retry 都是 no-op：未知 id、text 未保存（persist_failed）、已 indexed", async () => {
    mode = "ok";
    const useForge = await freshStore();
    await useForge.getState().retryIndexing("no-such-doc");
    expect(embedCalls).toBe(0);
    expect(getStoreCalls).toBe(0);
    expect(useForge.getState().docInfo["no-such-doc"]).toBeUndefined(); // 不會憑空建立狀態

    dbShouldThrow = true;
    await useForge.getState().ingest(textSource(TEXT));
    dbShouldThrow = false;
    const id = useForge.getState().docs[0].id;
    const before = useForge.getState().docInfo[id];
    await useForge.getState().retryIndexing(id);
    expect(embedCalls).toBe(0);
    expect(getStoreCalls).toBe(0);
    expect(useForge.getState().docInfo[id]).toEqual(before); // 狀態完全不被改動（仍是 unavailable，沒有變 building / failed）
    expect(before).toMatchObject({ text: "persist_failed", vector: "unavailable" });

    // 已 indexed：同樣 no-op
    const calls = embedCalls;
    await useForge.getState().ingest(textSource(LONG));
    const id2 = useForge.getState().docs.find((d) => d.rawText === LONG)!.id;
    expect(useForge.getState().docInfo[id2].vector).toBe("indexed");
    const afterIngest = embedCalls;
    expect(afterIngest).toBeGreaterThan(calls);
    await useForge.getState().retryIndexing(id2);
    expect(embedCalls).toBe(afterIngest);
  });
});

describe("沒有任何自動 / 背景重試", () => {
  it("向量化失敗後等待，不會自行重試；reload 後 seed 狀態也不會觸發 embedding 或取得向量庫", async () => {
    mode = "throw";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const useForge = await freshStore();
    await useForge.getState().ingest(textSource(LONG));
    errSpy.mockRestore();
    const calls = embedCalls;
    const stores = getStoreCalls;
    mode = "ok"; // 模型「恢復」了，但沒有人觸發
    await sleep(150);
    expect(embedCalls).toBe(calls);
    expect(getStoreCalls).toBe(stores);
    expect((await counts()).vectors).toBe(0);

    const reloaded = await freshStore();
    reloaded.getState().seedDocInfo(docInfoFromDb(await loadCorpus(testDb), await loadVectorPresence(testDb)));
    await sleep(100);
    expect(embedCalls).toBe(calls);
    expect(getStoreCalls).toBe(stores);
  });
});

describe("重新匯入同一份內容（Re-import semantics）", () => {
  it("向量已存在：不新增第二份 document / chunks，也不重複 embedding", async () => {
    mode = "ok";
    const useForge = await freshStore();
    await useForge.getState().ingest(textSource(LONG));
    const calls = embedCalls;
    const before = await counts();
    await useForge.getState().ingest(textSource(LONG));
    expect(embedCalls).toBe(calls);
    expect(await counts()).toEqual(before);
    expect(useForge.getState().docs).toHaveLength(1);
    expect(useForge.getState().jobs[0].status).toBe("done");
  });

  it("只有文字（text ready、無向量）：重新匯入 reuse 既有 text / chunks，補建向量，不新增第二份 document", async () => {
    mode = "none";
    const useForge = await freshStore();
    await useForge.getState().ingest(textSource(LONG));
    const textOnly = await counts();
    expect(textOnly.vectors).toBe(0);
    mode = "ok";
    await useForge.getState().ingest(textSource(LONG));
    const after = await counts();
    expect([after.docs, after.chunks]).toEqual([textOnly.docs, textOnly.chunks]);
    expect(after.vectors).toBe(textOnly.chunks);
    expect(useForge.getState().docs).toHaveLength(1);
    expect(useForge.getState().docInfo[useForge.getState().docs[0].id].vector).toBe("indexed");
  });

  it("同一份內容在 text commit 時重複 commit：idempotent（document 與 chunk 數量不增加）", async () => {
    mode = "none";
    const useForge = await freshStore();
    await useForge.getState().ingest(textSource(LONG));
    await useForge.getState().ingest(textSource(LONG));
    await useForge.getState().ingest(textSource(LONG));
    expect(await counts()).toEqual({ docs: 1, chunks: chunkText(LONG).length, vectors: 0 });
    expect(useForge.getState().docs).toHaveLength(1);
  });
});

describe("embedding 上限（MAX_EMBED_CHUNKS）：過大文件只略過向量化，文字與圖譜不受影響", () => {
  // 詞會重複出現（才會達到概念門檻、圖譜才有節點）；chunk 數只取決於 token 數
  const words = (n: number) => Array.from({ length: n }, (_, i) => `tray${i % 40}`).join(" ");
  const BIG = words(9051); // 21 個 chunk（上限 20）
  const EDGE = words(9050); // 剛好 20 個 chunk

  it("21 個 chunk：不取得向量庫、不 embedding；文字保存、可建圖；job PARTIAL；文件標 tooLarge / unavailable 並說明原因", async () => {
    mode = "ok"; // 模型可用，仍然要略過
    const useForge = await freshStore();
    await useForge.getState().ingest(textSource(BIG));
    const s = useForge.getState();
    const id = s.docs[0].id;
    expect(chunkText(BIG)).toHaveLength(21);
    expect(getStoreCalls).toBe(0);
    expect(embedCalls).toBe(0);
    expect(await counts()).toEqual({ docs: 1, chunks: 21, vectors: 0 });
    expect(s.jobs[0].status).toBe("partial");
    expect(s.jobs[0].vectorStatus).toBe("unavailable");
    expect(s.docInfo[id]).toMatchObject({ text: "ready", vector: "unavailable", tooLarge: true });
    expect(s.docInfo[id].vectorNote).toContain("文件過大");
    expect(s.jobs[0].stages.find((st) => st.id === "LINK")?.note).toContain("上限 20");
    expect(buildGraph(s.docs).nodes.length).toBeGreaterThan(0); // 圖譜只依賴文字
    expect(canRetryIndexing(s.docInfo[id])).toBe(false);
  });

  it("剛好 20 個 chunk：照常向量化", async () => {
    mode = "ok";
    const useForge = await freshStore();
    await useForge.getState().ingest(textSource(EDGE));
    const s = useForge.getState();
    expect(chunkText(EDGE)).toHaveLength(20);
    expect(embedCalls).toBeGreaterThan(0);
    expect(s.jobs[0].status).toBe("done");
    expect(await counts()).toMatchObject({ docs: 1, chunks: 20, vectors: 20 });
    expect(s.docInfo[s.docs[0].id].tooLarge).toBeUndefined();
  });

  it("直接呼叫 retryIndexing 也不能繞過上限：不 embedding、狀態維持 unavailable / tooLarge", async () => {
    mode = "ok";
    const useForge = await freshStore();
    await useForge.getState().ingest(textSource(BIG));
    const id = useForge.getState().docs[0].id;
    await useForge.getState().retryIndexing(id); // canRetryIndexing 已是 false → 直接 no-op
    expect(embedCalls).toBe(0);
    expect(useForge.getState().docInfo[id]).toMatchObject({ vector: "unavailable", tooLarge: true });
  });

  it("重新整理後：由 IndexedDB 推得 tooLarge / unavailable（不是誤導的「尚未建立」+ 重試鈕）", async () => {
    mode = "ok";
    const useForge = await freshStore();
    await useForge.getState().ingest(textSource(BIG));
    const id = useForge.getState().docs[0].id;
    const docs = await loadCorpus(testDb);
    const info = docInfoFromDb(docs, await loadVectorPresence(testDb));
    expect(info[id]).toMatchObject({ text: "ready", vector: "unavailable", tooLarge: true });
    expect(canRetryIndexing(info[id])).toBe(false);
  });
});

