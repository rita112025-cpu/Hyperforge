import { describe, expect, it } from "vitest";
import { handleMessage, isEmbedRequest, toTransferable, type EmbedEngine } from "./embed-protocol";

const engine = (impl: (t: string[]) => Promise<Float32Array[]>): EmbedEngine => ({ embed: impl });

describe("isEmbedRequest", () => {
  it("只接受 {type:'embed', id:number, texts:string[]}", () => {
    expect(isEmbedRequest({ type: "embed", id: 1, texts: ["a"] })).toBe(true);
    expect(isEmbedRequest({ type: "embed", id: 1, texts: [] })).toBe(true);
    for (const bad of [null, undefined, 3, "x", {}, { type: "embed", id: "1", texts: [] }, { type: "embed", id: 1, texts: [1] }, { type: "other", id: 1, texts: [] }, { type: "embed", id: 1 }]) {
      expect(isEmbedRequest(bad)).toBe(false);
    }
  });
});

describe("toTransferable", () => {
  it("每個向量擁有自己的完整 buffer；subarray 會被複製，buffer 不會洩漏整塊大 buffer", () => {
    const big = new Float32Array(100).map((_, i) => i);
    const sub = big.subarray(10, 14);
    const own = new Float32Array([1, 2, 3, 4]);
    const { vectors, transfer } = toTransferable([sub, own]);
    expect(Array.from(vectors[0])).toEqual([10, 11, 12, 13]);
    expect(vectors[0].buffer.byteLength).toBe(16);
    expect(vectors[1]).toBe(own); // 已擁有完整 buffer：不複製
    expect(transfer).toEqual([vectors[0].buffer, own.buffer]);
    expect(new Set(transfer).size).toBe(2);
  });
});

describe("handleMessage", () => {
  it("成功：回傳同 id 的向量與要 transfer 的 buffer", async () => {
    const { response, transfer } = await handleMessage(engine(async (t) => t.map(() => new Float32Array([1, 0]))), { type: "embed", id: 7, texts: ["a", "b"] });
    expect(response).toMatchObject({ id: 7, ok: true });
    if (response.ok) expect(response.vectors).toHaveLength(2);
    expect(transfer).toHaveLength(2);
  });

  it("engine 丟錯：包成 {ok:false}（不丟出），訊息保留", async () => {
    const { response, transfer } = await handleMessage(engine(async () => { throw new Error("boom"); }), { type: "embed", id: 3, texts: ["a"] });
    expect(response).toEqual({ id: 3, ok: false, error: "boom" });
    expect(transfer).toEqual([]);
  });

  it("engine 丟非 Error 值：轉成字串", async () => {
    const { response } = await handleMessage(engine(async () => { throw "plain"; }), { type: "embed", id: 4, texts: [] });
    expect(response).toEqual({ id: 4, ok: false, error: "plain" });
  });

  it("無效請求：回 ok:false，且保留可辨識的 id；沒有 id 時為 -1；不呼叫 engine", async () => {
    let calls = 0;
    const e = engine(async () => { calls++; return []; });
    expect((await handleMessage(e, { type: "nope", id: 9 })).response).toMatchObject({ id: 9, ok: false });
    expect((await handleMessage(e, "garbage")).response).toMatchObject({ id: -1, ok: false });
    expect(calls).toBe(0);
  });
});
