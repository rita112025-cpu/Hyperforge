import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HyperforgeDB } from "./db";
import { FakeEmbedder } from "./fake-embedder.test-util";
import { createStoreGetter, getVectorStore } from "./runtime";

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
    expect(await get()).toBeNull();
  });

  it("並發呼叫只建立並 init 一次，回傳同一個 store", async () => {
    const createEmbedder = vi.fn(() => new FakeEmbedder());
    const get = createStoreGetter({ createDb: mkDb, createEmbedder, isBrowser: () => true });
    const [a, b, c] = await Promise.all([get(), get(), get()]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(createEmbedder).toHaveBeenCalledTimes(1);
    expect(await get()).toBe(a);
  });

  it("模型不可用 → null，且不被永久快取：之後可用就會成功", async () => {
    let available = false;
    const get = createStoreGetter({
      createDb: mkDb,
      createEmbedder: () => new FakeEmbedder(64, available),
      isBrowser: () => true,
    });
    expect(await get()).toBeNull();
    available = true;
    expect(await get()).not.toBeNull();
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
    expect(await get()).toBeNull();
    fail = false;
    expect(await get()).not.toBeNull();
  });
});

describe("Node 環境的預設 getter", () => {
  it("getVectorStore() 回傳 null（降級）", async () => {
    expect(await getVectorStore()).toBeNull();
  });
});
