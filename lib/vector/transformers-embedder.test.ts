import { describe, expect, it, vi } from "vitest";
import { MULTILINGUAL, requiredFiles } from "./model-spec";
import { TransformersEmbedder, sliceIds, toWindows, type Extractor, type Tok } from "./transformers-embedder";

const DIM = 384;

/** 假 tokenizer：一個空白分隔的詞 = 一個 token，有可逆詞表 */
function fakeTok(maxLength = 512): Tok {
  const vocab: string[] = [];
  return {
    maxLength,
    encode: (t) =>
      t
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => {
          let i = vocab.indexOf(w);
          if (i < 0) i = vocab.push(w) - 1;
          return i;
        }),
    decode: (ids) => ids.map((i) => vocab[i]).join(" "),
  };
}

/** 假 extractor：每個輸入回傳單位向量（方向依文字長度），並記錄呼叫 */
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
const mk = (tok = fakeTok(), ex = fakeExtractor()) => ({
  ...ex,
  e: new TransformersEmbedder({ load: async () => ({ extractor: ex.fn, tokenizer: tok }) }),
});

describe("model-spec", () => {
  it("設計值 maxSeq=128、dim=384，且有固定 revision", () => {
    expect(MULTILINGUAL.maxSeq).toBe(128);
    expect(MULTILINGUAL.dim).toBe(384);
    expect(MULTILINGUAL.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(MULTILINGUAL.id).toContain("multilingual");
  });
});

describe("toWindows / sliceIds", () => {
  it("sliceIds 切成 ≤ size 的片段，且串回去等於原陣列", () => {
    const parts = sliceIds(Array.from({ length: 300 }, (_, i) => i), 126);
    expect(parts.map((p) => p.length)).toEqual([126, 126, 48]);
    expect(parts.flat()).toEqual(Array.from({ length: 300 }, (_, i) => i));
  });
  it("短文字（≤ maxSeq-2 個 token）原樣保留；126 恰好 1 窗、127 切 2 窗", () => {
    const tok = fakeTok();
    expect(toWindows("a b c", tok, 128)).toEqual([{ text: "a b c", weight: 3 }]);
    expect(toWindows(words(126), tok, 128)).toHaveLength(1);
    expect(toWindows(words(127), tok, 128)).toHaveLength(2);
  });
  it("每個 window 的 token 數 ≤ 126，weight 為其 token 數，總和等於原 token 數", () => {
    const tok = fakeTok();
    const w = toWindows(words(500), tok, 128);
    expect(w).toHaveLength(4);
    w.forEach((x) => expect(tok.encode(x.text).length).toBeLessThanOrEqual(126));
    expect(w.reduce((a, x) => a + x.weight, 0)).toBe(500);
  });
  it("空字串仍回傳 1 個 window（weight ≥ 1）", () => {
    expect(toWindows("", fakeTok(), 128)).toEqual([{ text: "", weight: 1 }]);
  });
});

describe("TransformersEmbedder.embed", () => {
  it("維度 384、單位向量；空輸入回傳 []", async () => {
    const { e } = mk();
    const out = await e.embed(["hello world", "你好"]);
    expect(out).toHaveLength(2);
    out.forEach((v) => {
      expect(v.length).toBe(DIM);
      expect(norm(v)).toBeCloseTo(1, 5);
    });
    expect(await e.embed([])).toEqual([]);
  });

  it("500 token 的 chunk 被切成 4 次推論、每窗 ≤126 token，平均後仍為單位向量", async () => {
    const { e, calls } = mk();
    const [v] = await e.embed([words(500)]);
    const sent = calls.flat();
    expect(sent).toHaveLength(4);
    sent.forEach((w) => expect(w.split(" ").length).toBeLessThanOrEqual(126));
    expect(norm(v)).toBeCloseTo(1, 5);
  });

  it("加權：長窗權重大於短窗（結果偏向長窗的方向）", async () => {
    const tok = fakeTok();
    // 126 token 的長窗與 1 token 的短窗，extractor 依文字長度給不同方向
    const text = `${words(126)} tail`;
    const { fn } = fakeExtractor();
    const e = new TransformersEmbedder({ load: async () => ({ extractor: fn, tokenizer: tok }) });
    const [v] = await e.embed([text]);
    const [long] = await fn([toWindows(text, tok, 128)[0].text], { pooling: "mean", normalize: true }).then((r) => [r.data]);
    let dot = 0;
    for (let i = 0; i < DIM; i++) dot += v[i] * long[i];
    expect(dot).toBeGreaterThan(0.99);
  });

  it("批次切分：超過 32 個視窗會分多次呼叫模型，結果順序對應輸入", async () => {
    const { e, calls } = mk();
    const texts = Array.from({ length: 70 }, (_, i) => "x".repeat(i + 1));
    const out = await e.embed(texts);
    expect(out).toHaveLength(70);
    expect(calls.map((c) => c.length)).toEqual([32, 32, 6]);
  });

  it("模型輸出形狀錯誤 → 丟錯", async () => {
    const bad: Extractor = async () => ({ data: new Float32Array(3), dims: [1, 3] });
    const e = new TransformersEmbedder({ load: async () => ({ extractor: bad, tokenizer: fakeTok() }) });
    await expect(e.embed(["a"])).rejects.toThrow("形狀");
  });

  it("tokenizer.model_max_length 小於設計 maxSeq → 報錯", async () => {
    const { e } = mk(fakeTok(64));
    await expect(e.embed(["a"])).rejects.toThrow("model_max_length");
  });

  it("載入失敗 → 明確訊息，且下次可重試", async () => {
    const { fn } = fakeExtractor();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("net"))
      .mockResolvedValue({ extractor: fn, tokenizer: fakeTok() });
    const e = new TransformersEmbedder({ load });
    await expect(e.embed(["a"])).rejects.toThrow("模型載入失敗：net");
    expect(await e.embed(["a"])).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("TransformersEmbedder.isAvailable", () => {
  const res = (ok: boolean, type = "application/octet-stream") =>
    ({ ok, headers: new Headers({ "content-type": type }) }) as unknown as Response;
  const make = (impl: (url: string) => Response | Promise<Response>) => {
    const f = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => impl(String(url)));
    return { f, e: new TransformersEmbedder({ fetchFn: f as unknown as typeof fetch }) };
  };
  const FILES = requiredFiles(MULTILINGUAL);

  it("全部檔案都在 → true；請求使用 HEAD 與 no-store", async () => {
    const { e, f } = make(() => res(true));
    expect(await e.isAvailable()).toBe(true);
    expect(f).toHaveBeenCalledTimes(FILES.length);
    expect(f.mock.calls[0][1]).toMatchObject({ method: "HEAD", cache: "no-store" });
  });
  it("缺任一檔（404）→ false", async () => {
    for (const missing of FILES) {
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
