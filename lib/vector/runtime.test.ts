import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HyperforgeDB } from "./db";
import { FakeEmbedder } from "./fake-embedder.test-util";
import { createStoreGetter, getVectorStore, resetVectorDb, RESET_HINT } from "./runtime";

const dbs: HyperforgeDB[] = [];
let n = 0;
const mkDb = () => {
  const d = new HyperforgeDB(`rt-${Date.now()}-${n++}`);
  dbs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of dbs.splice(0)) {
    d.close();
    await d.delete();
  }
});

describe("createStoreGetter", () => {
  it("非瀏覽器 → null", async () => {
    const get = createStoreGetter({ createDb: mkDb, createEmbedder: () => new FakeEmbedder(), isBrowser: () => false });
    expect(await get()).toMatchObject({ store: null, reason: expect.stringContaining("非瀏覽器") });
  });

  it("並發呼叫只建立並 init 一次，回傳同一個 store", async () => {
    const createEmbedder = vi.fn(() => new FakeEmbedder());
    const get = createStoreGetter({ createDb: mkDb, createEmbedder, isBrowser: () => true });
    const [ra, rb, rc] = await Promise.all([get(), get(), get()]);
    const [a, b, c] = [ra.store, rb.store, rc.store];
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(createEmbedder).toHaveBeenCalledTimes(1);
    expect((await get()).store).toBe(a);
  });

  it("模型不可用 → null，且不被永久快取：之後可用就會成功", async () => {
    let available = false;
    const get = createStoreGetter({
      createDb: mkDb,
      createEmbedder: () => new FakeEmbedder(64, available),
      isBrowser: () => true,
    });
    const first = await get();
    expect(first.store).toBeNull();
    expect(first.reason).toContain("fetch-model");
    available = true;
    expect((await get()).store).not.toBeNull();
  });

  it("init 丟錯 → null，下次呼叫重試", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let fail = true;
    const get = createStoreGetter({
      createDb: () => {
        if (fail) throw new Error("db boom");
        return mkDb();
      },
      createEmbedder: () => new FakeEmbedder(),
      isBrowser: () => true,
    });
    const first = await get();
    expect(first.store).toBeNull();
    expect(first.reason).toContain("db boom");
    fail = false;
    expect((await get()).store).not.toBeNull();
  });

  it("舊模型的向量庫 → reason 說明需重建並附重置途徑；清除後可重試成功", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = mkDb();
    await db.meta.put({ key: "embed", value: { model: "Xenova/all-MiniLM-L6-v2(quantized)", dim: 384 } });
    const get = createStoreGetter({ createDb: () => db, createEmbedder: () => new FakeEmbedder(384), isBrowser: () => true });
    const r = await get();
    expect(r.store).toBeNull();
    expect(r.reason).toContain("舊模型");
    expect(r.reason).toContain(RESET_HINT);
    await db.meta.delete("embed");
    expect((await get()).store).not.toBeNull();
  });

  it("resetVectorDb 刪除資料庫", async () => {
    const name = `reset-${Date.now()}`;
    const d = new HyperforgeDB(name);
    await d.meta.put({ key: "x", value: 1 });
    d.close();
    await resetVectorDb(name);
    const again = new HyperforgeDB(name);
    expect(await again.meta.count()).toBe(0);
    again.close();
    await again.delete();
  });
});

describe("Node 環境的預設 getter", () => {
  it("getVectorStore() 回傳 null（降級）", async () => {
    expect((await getVectorStore()).store).toBeNull();
  });
});
