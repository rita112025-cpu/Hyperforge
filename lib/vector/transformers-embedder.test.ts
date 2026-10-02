import { describe, expect, it, vi } from "vitest";
import { REQUIRED_FILES, TransformersEmbedder, splitWindows, type Extractor } from "./transformers-embedder";

const DIM = 384;
/** 假 extractor：每個輸入回傳確定性單位向量（依文字長度決定方向），並記錄呼叫 */
function fakeExtractor() {
  const calls: string[][] = [];
  const fn: Extractor = async (texts) => {
    calls.push(texts);
    const data = new Float32Array(texts.length * DIM);
    texts.forEach((t, i) => {
      const k = t.length % DIM;
      data[i * DIM + k] = 0.6;
      data[i * DIM + ((k + 1) % DIM)] = 0.8;
    });
    return { data, dims: [texts.length, DIM] };
  };
  return { fn, calls };
}
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const norm = (v: Float32Array) => Math.sqrt(v.reduce((a, x) => a + x * x, 0));

describe("TransformersEmbedder.embed", () => {
  it("維度 384、單位向量；空輸入回傳 []", async () => {
    const { fn } = fakeExtractor();
    const e = new TransformersEmbedder({ loadExtractor: async () => fn });
    const out = await e.embed(["hello world", "你好"]);
    expect(out).toHaveLength(2);
    out.forEach((v) => {
      expect(v.length).toBe(DIM);
      expect(norm(v)).toBeCloseTo(1, 5);
    });
    expect(await e.embed([])).toEqual([]);
  });

  it("長文字切成 ≤ windowTokens 的視窗，平均後仍為單位向量，且每個視窗都被送進模型", async () => {
    const { fn, calls } = fakeExtractor();
    const e = new TransformersEmbedder({ loadExtractor: async () => fn, windowTokens: 100 });
    const [v] = await e.embed([words(450)]);
    const sent = calls.flat();
    expect(sent).toHaveLength(5);
    sent.forEach((w) => expect(w.split(" ").length).toBeLessThanOrEqual(100));
    expect(norm(v)).toBeCloseTo(1, 5);
  });

  it("批次切分：超過 32 個視窗會分多次呼叫模型，結果順序對應輸入", async () => {
    const { fn, calls } = fakeExtractor();
    const e = new TransformersEmbedder({ loadExtractor: async () => fn });
    const texts = Array.from({ length: 70 }, (_, i) => "x".repeat(i + 1));
    const out = await e.embed(texts);
    expect(out).toHaveLength(70);
    expect(calls.map((c) => c.length)).toEqual([32, 32, 6]);
  });

  it("模型輸出形狀錯誤 → 丟錯", async () => {
    const bad: Extractor = async () => ({ data: new Float32Array(3), dims: [1, 3] });
    await expect(new TransformersEmbedder({ loadExtractor: async () => bad }).embed(["a"])).rejects.toThrow("形狀");
  });

  it("載入失敗 → 明確訊息，且下次可重試", async () => {
    const { fn } = fakeExtractor();
    const load = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValue(fn);
    const e = new TransformersEmbedder({ loadExtractor: load });
    await expect(e.embed(["a"])).rejects.toThrow("模型載入失敗：net");
    expect(await e.embed(["a"])).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("splitWindows", () => {
  it("短文字原樣回傳；長文字切塊且還原後涵蓋全部 token", () => {
    expect(splitWindows("a b c", 100)).toEqual(["a b c"]);
    const w = splitWindows(words(250), 100);
    expect(w).toHaveLength(3);
    expect(w.join(" ")).toBe(words(250));
  });
});

describe("TransformersEmbedder.isAvailable", () => {
  const res = (ok: boolean, type = "application/octet-stream") =>
    ({ ok, headers: new Headers({ "content-type": type }) }) as unknown as Response;
  const make = (impl: (url: string) => Response | Promise<Response>) => {
    const f = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => impl(String(url)));
    return { f, e: new TransformersEmbedder({ fetchFn: f as unknown as typeof fetch }) };
  };

  it("全部檔案都在 → true；請求使用 HEAD 與 no-store", async () => {
    const { e, f } = make(() => res(true));
    expect(await e.isAvailable()).toBe(true);
    expect(f).toHaveBeenCalledTimes(REQUIRED_FILES.length);
    expect(f.mock.calls[0][1]).toMatchObject({ method: "HEAD", cache: "no-store" });
  });
  it("缺任一檔（404）→ false", async () => {
    for (const missing of REQUIRED_FILES) {
      const { e } = make((u) => res(u !== missing));
      expect(await e.isAvailable()).toBe(false);
    }
  });
  it("200 但 content-type 為 text/html（Next 404 頁）→ false", async () => {
    const { e } = make((u) => (u.endsWith("tokenizer.json") ? res(true, "text/html; charset=utf-8") : res(true)));
    expect(await e.isAvailable()).toBe(false);
  });
  it("失敗不被永久快取：補齊檔案後變 true；fetch 丟錯 → false", async () => {
    let up = false;
    const { e } = make(() => (up ? res(true) : res(false)));
    expect(await e.isAvailable()).toBe(false);
    up = true;
    expect(await e.isAvailable()).toBe(true);
    const thrower = new TransformersEmbedder({
      fetchFn: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(await thrower.isAvailable()).toBe(false);
  });
});
