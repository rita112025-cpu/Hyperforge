import { describe, expect, it } from "vitest";
import { toTransferable } from "./embed-protocol";

describe("toTransferable：transfer list 不可含重複 buffer（否則 postMessage 會丟 DataCloneError）", () => {
  it("同一個 Float32Array 實例出現多次：後者被複製，transfer 沒有重複", () => {
    const same = new Float32Array([1, 2]);
    const { vectors, transfer } = toTransferable([same, same, same]);
    expect(new Set(transfer).size).toBe(3);
    expect(vectors.map((v) => Array.from(v))).toEqual([
      [1, 2],
      [1, 2],
      [1, 2],
    ]);
  });

  it("多個向量共用同一塊 buffer（不同 subarray）：各自獨立、各自佔滿自己的 buffer", () => {
    const big = new Float32Array([1, 2, 3, 4]);
    const { vectors, transfer } = toTransferable([big.subarray(0, 2), big.subarray(2, 4)]);
    expect(new Set(transfer).size).toBe(2);
    expect(Array.from(vectors[1])).toEqual([3, 4]);
    expect(vectors.every((v) => v.byteLength === v.buffer.byteLength)).toBe(true);
  });

  it("結果真的可以被 structuredClone 的 transfer list 接受（不丟 DataCloneError）", () => {
    const same = new Float32Array([5, 6]);
    const { vectors, transfer } = toTransferable([same, same]);
    expect(() => structuredClone(vectors, { transfer })).not.toThrow();
  });

  it("每個回傳向量各有自己的 buffer（slice 出來的獨立副本）", () => {
    const data = new Float32Array(8).map((_, i) => i);
    const parts = [data.slice(0, 4), data.slice(4, 8)];
    const { transfer } = toTransferable(parts);
    expect(new Set(transfer).size).toBe(2);
    expect(parts.every((p) => p.buffer.byteLength === 16)).toBe(true);
  });
});

describe("postResponse：postMessage 丟例外時改回傳 {ok:false}，請求不會懸著", () => {
  it("正常：直接 post 原回應與 transfer", async () => {
    const { postResponse } = await import("./embed-protocol");
    const calls: unknown[][] = [];
    const buf = new ArrayBuffer(8);
    postResponse((m, t) => void calls.push([m, t]), { id: 5, ok: true, vectors: [new Float32Array(buf)] }, [buf]);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual([buf]);
  });

  it("第一次 post 丟 DataCloneError：第二次以同一個 id 回傳 ok:false，且不帶 transfer", async () => {
    const { postResponse } = await import("./embed-protocol");
    const calls: unknown[][] = [];
    let n = 0;
    postResponse(
      (m, t) => {
        calls.push([m, t]);
        if (n++ === 0) throw new Error("DataCloneError");
      },
      { id: 9, ok: true, vectors: [new Float32Array(2)] },
      [],
    );
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toMatchObject({ id: 9, ok: false });
    expect((calls[1][0] as { error: string }).error).toContain("DataCloneError");
    expect(calls[1][1]).toEqual([]);
  });

  it("連錯誤回覆都送不出去：不丟出（不產生未處理的 rejection）", async () => {
    const { postResponse } = await import("./embed-protocol");
    expect(() =>
      postResponse(
        () => {
          throw new Error("worker 已終止");
        },
        { id: 1, ok: false, error: "x" },
        [],
      ),
    ).not.toThrow();
  });
});
