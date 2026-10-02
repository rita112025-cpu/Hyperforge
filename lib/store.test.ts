import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { HyperforgeDB } from "./vector/db";

// 整合點測試：useForge.ingest 完成後，(1) 記憶體結果進 docs（畫布即時來源），(2) 文字持久化到 IndexedDB，
// 兩者都與向量化成敗無關。runtime（會碰 embedder）與 shared-db 以測試替身取代。
let testDb: HyperforgeDB;
let dbShouldThrow = false;
vi.mock("./vector/runtime", () => ({
  getVectorStore: async () => ({ store: null, reason: "模型未安裝（測試）" }),
}));
vi.mock("./vector/shared-db", () => ({
  getSharedDb: () => {
    if (dbShouldThrow) throw new Error("IndexedDB 被封鎖（測試）");
    return testDb;
  },
}));

const TEXT = "電纜槽淨距不足，需要調整弱電橋架位置。弱電橋架與電纜槽之間必須保留足夠間距。";

async function freshStore() {
  vi.resetModules();
  const { useForge } = await import("./store");
  return useForge;
}

beforeEach(() => {
  testDb = new HyperforgeDB(`store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dbShouldThrow = false;
});
afterEach(async () => {
  testDb.close();
  await testDb.delete();
});

describe("useForge.ingest：即時來源與文字持久化（與向量化無關）", () => {
  it("模型不可用：job 為 PARTIAL，但 docs 已有該文件、IndexedDB 已有文字（沒有向量）", async () => {
    const useForge = await freshStore();
    await useForge.getState().ingest({ kind: "text", text: TEXT });
    const s = useForge.getState();
    expect(s.jobs[0].status).toBe("partial");
    expect(s.jobs[0].context?.indexed).toBe(false);
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].rawText).toBe(TEXT);
    expect(s.docs[0].id).toMatch(/^[0-9a-f]{64}$/); // 與 IndexedDB docs.id 相同的 SHA-256
    expect(s.jobs[0].persist).toMatchObject({ ok: true });
    expect([await testDb.docs.count(), await testDb.chunks.count(), await testDb.vectors.count()]).toEqual([1, s.docs[0].chunks.length, 0]);
    expect((await testDb.docs.get(s.docs[0].id))?.rawText).toBe(TEXT);
  });

  it("同一份內容再匯入：docs 不重複追加，持久化回報「已存在」", async () => {
    const useForge = await freshStore();
    await useForge.getState().ingest({ kind: "text", text: TEXT });
    await useForge.getState().ingest({ kind: "text", text: TEXT });
    const s = useForge.getState();
    expect(s.docs).toHaveLength(1);
    expect(s.jobs).toHaveLength(2);
    expect(s.jobs[0].persist?.note).toMatch(/已存在/);
    expect(await testDb.docs.count()).toBe(1);
  });

  it("IndexedDB 不可用（持久化失敗）：畫布資料仍在 docs，job 如實回報未持久化，不變成 error", async () => {
    dbShouldThrow = true;
    const useForge = await freshStore();
    await useForge.getState().ingest({ kind: "text", text: TEXT });
    const s = useForge.getState();
    expect(s.jobs[0].status).toBe("partial");
    expect(s.jobs[0].persist?.ok).toBe(false);
    expect(s.jobs[0].persist?.note).toMatch(/未能存入 IndexedDB/);
    expect(s.docs).toHaveLength(1);
  });

  it("空輸入 / 失敗的 job 不會產生 doc；doc 只在完成時追加一次（不是每個 progress 事件）", async () => {
    const useForge = await freshStore();
    const seen: number[] = [];
    const unsub = useForge.subscribe((st) => seen.push(st.docs.length));
    await useForge.getState().ingest({ kind: "text", text: "" });
    await useForge.getState().ingest({ kind: "url", url: "https://example.com", subtype: "web" }); // 本輪不支援 → error
    expect(useForge.getState().docs).toHaveLength(0);
    expect(useForge.getState().jobs.map((j) => j.status).sort()).toEqual(["error", "partial"]);
    await useForge.getState().ingest({ kind: "text", text: TEXT });
    unsub();
    const changes = seen.filter((n, i) => i === 0 || n !== seen[i - 1]);
    expect(changes.at(-1)).toBe(1);
    expect(seen.filter((n) => n === 1).length).toBeGreaterThan(0);
    // docs 長度只從 0 變成 1 一次
    expect(changes.filter((n) => n === 1)).toHaveLength(1);
  });
});
