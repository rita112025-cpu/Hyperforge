import { describe, expect, it, vi } from "vitest";
import { handleMessage, type EmbedEngine, type EmbedRequest } from "./embed-protocol";
import { MULTILINGUAL, requiredFiles } from "./model-spec";
import { WorkerEmbedder, type WorkerLike } from "./worker-embedder";

const DIM = MULTILINGUAL.dim;
const vec = (seed: number) => new Float32Array(DIM).fill(seed);

/** 手動驅動的 fake worker：記錄 request，測試決定何時回覆 / 出錯 */
class ManualWorker implements WorkerLike {
  onmessage: WorkerLike["onmessage"] = null;
  onerror: WorkerLike["onerror"] = null;
  onmessageerror: WorkerLike["onmessageerror"] = null;
  requests: EmbedRequest[] = [];
  terminated = false;
  postMessage(m: unknown) {
    this.requests.push(m as EmbedRequest);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: unknown) {
    this.onmessage?.({ data });
  }
  ok(req: EmbedRequest) {
    this.reply({ id: req.id, ok: true, vectors: req.texts.map((_, i) => vec(i + 1)) });
  }
}

function harness() {
  const workers: ManualWorker[] = [];
  const spawn = vi.fn(() => {
    const w = new ManualWorker();
    workers.push(w);
    return w;
  });
  const e = new WorkerEmbedder({ spawn, supported: () => true });
  return { e, workers, spawn };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("WorkerEmbedder.embed", () => {
  it("空輸入不啟動 Worker", async () => {
    const { e, spawn } = harness();
    expect(await e.embed([])).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("送出 request、以 id 對應回覆、回傳向量", async () => {
    const { e, workers } = harness();
    const p = e.embed(["a", "b"]);
    expect(workers).toHaveLength(1);
    expect(workers[0].requests).toHaveLength(1);
    expect(workers[0].requests[0]).toMatchObject({ type: "embed", texts: ["a", "b"] });
    workers[0].ok(workers[0].requests[0]);
    const out = await p;
    expect(out).toHaveLength(2);
    expect(out[0][0]).toBe(1);
    expect(out[1][0]).toBe(2);
  });

  it("並發請求序列化：一次只送一個；前一個完成後才送下一個，且各自拿到自己的結果", async () => {
    const { e, workers } = harness();
    const p1 = e.embed(["x"]);
    const p2 = e.embed(["y", "z"]);
    expect(workers[0].requests).toHaveLength(1);
    workers[0].ok(workers[0].requests[0]);
    expect((await p1)).toHaveLength(1);
    expect(workers[0].requests).toHaveLength(2);
    workers[0].ok(workers[0].requests[1]);
    expect((await p2)).toHaveLength(2);
    expect(workers).toHaveLength(1); // 同一個 Worker 重複使用
  });

  it("過期 / 陌生 id 的訊息被忽略，不會 resolve 錯的請求", async () => {
    const { e, workers } = harness();
    const p = e.embed(["a"]);
    workers[0].reply({ id: 9999, ok: true, vectors: [vec(1)] });
    workers[0].reply("garbage");
    workers[0].reply(null);
    let settled = false;
    void p.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    workers[0].ok(workers[0].requests[0]);
    await p;
  });

  it("Worker 回 {ok:false}：reject 並帶出錯誤訊息；Worker 仍可繼續使用", async () => {
    const { e, workers } = harness();
    const p = e.embed(["a"]);
    workers[0].reply({ id: workers[0].requests[0].id, ok: false, error: "模型載入失敗：x" });
    await expect(p).rejects.toThrow("模型載入失敗：x");
    const p2 = e.embed(["b"]);
    workers[0].ok(workers[0].requests[1]);
    await expect(p2).resolves.toHaveLength(1);
    expect(workers).toHaveLength(1);
  });

  it("回傳的向量數量或維度不符 → reject", async () => {
    const { e, workers } = harness();
    const p = e.embed(["a", "b"]);
    workers[0].reply({ id: workers[0].requests[0].id, ok: true, vectors: [vec(1)] });
    await expect(p).rejects.toThrow("數量或維度");
    const p2 = e.embed(["a"]);
    workers[0].reply({ id: workers[0].requests[1].id, ok: true, vectors: [new Float32Array(3)] });
    await expect(p2).rejects.toThrow("數量或維度");
  });

  it("Worker onerror：進行中的請求 reject、Worker 被終止並丟棄；下一次呼叫建立新的 Worker；失敗的請求不會被自動重試", async () => {
    const { e, workers, spawn } = harness();
    const p = e.embed(["a"]);
    workers[0].onerror?.({ message: "wasm 載入失敗" });
    await expect(p).rejects.toThrow("wasm 載入失敗");
    expect(workers[0].terminated).toBe(true);
    expect(e.hasWorker).toBe(false);
    await tick();
    expect(spawn).toHaveBeenCalledTimes(1); // 沒有自動重試
    const p2 = e.embed(["a"]);
    expect(spawn).toHaveBeenCalledTimes(2);
    workers[1].ok(workers[1].requests[0]);
    await expect(p2).resolves.toHaveLength(1);
  });

  it("Worker 壞掉時，排隊中的其他請求會在新的 Worker 上繼續（不被牽連）", async () => {
    const { e, workers } = harness();
    const p1 = e.embed(["a"]);
    const p2 = e.embed(["b"]);
    workers[0].onerror?.({ message: "crash" });
    await expect(p1).rejects.toThrow("crash");
    expect(workers).toHaveLength(2);
    expect(workers[1].requests[0].texts).toEqual(["b"]);
    workers[1].ok(workers[1].requests[0]);
    await expect(p2).resolves.toHaveLength(1);
  });

  it("spawn 丟錯：reject（訊息說明無法啟動），不遺留 current 狀態", async () => {
    const e = new WorkerEmbedder({ spawn: () => { throw new Error("CSP 擋住了 worker"); }, supported: () => true });
    await expect(e.embed(["a"])).rejects.toThrow("無法啟動 embedding Worker：CSP 擋住了 worker");
    expect(e.queued).toBe(0);
  });

  it("onmessageerror：視同失敗", async () => {
    const { e, workers } = harness();
    const p = e.embed(["a"]);
    workers[0].onmessageerror?.({});
    await expect(p).rejects.toThrow("無法解析");
  });
});

describe("取消（AbortSignal）", () => {
  it("已 aborted：直接 reject，不啟動 Worker", async () => {
    const { e, spawn } = harness();
    const ac = new AbortController();
    ac.abort();
    await expect(e.embed(["a"], { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("進行中被取消：立即 reject(AbortError)、終止 Worker（真的停止運算）；佇列中的請求在新 Worker 上繼續", async () => {
    const { e, workers } = harness();
    const ac = new AbortController();
    const p1 = e.embed(["slow"], { signal: ac.signal });
    const p2 = e.embed(["next"]);
    ac.abort();
    await expect(p1).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1].requests[0].texts).toEqual(["next"]);
    // 舊 Worker 之後才回的結果不會影響新請求
    workers[0].reply({ id: workers[0].requests[0].id, ok: true, vectors: [vec(9)] });
    let settled = false;
    void p2.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    workers[1].ok(workers[1].requests[0]);
    await expect(p2).resolves.toHaveLength(1);
  });

  it("排隊中被取消：從佇列移除，不影響進行中的請求、不終止 Worker", async () => {
    const { e, workers } = harness();
    const ac = new AbortController();
    const p1 = e.embed(["a"]);
    const p2 = e.embed(["b"], { signal: ac.signal });
    ac.abort();
    await expect(p2).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0].terminated).toBe(false);
    workers[0].ok(workers[0].requests[0]);
    await expect(p1).resolves.toHaveLength(1);
    expect(workers[0].requests).toHaveLength(1); // 被取消的 b 從未送出
  });

  it("完成之後再 abort：不再有任何作用（listener 已移除）", async () => {
    const { e, workers } = harness();
    const ac = new AbortController();
    const p = e.embed(["a"], { signal: ac.signal });
    workers[0].ok(workers[0].requests[0]);
    await p;
    ac.abort();
    expect(workers[0].terminated).toBe(false);
  });

  it("取消後 queued 計數歸零，沒有洩漏 pending", async () => {
    const { e } = harness();
    const ac = new AbortController();
    const p = e.embed(["a"], { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toBeTruthy();
    expect(e.queued).toBe(0);
  });
});

describe("dispose", () => {
  it("終止 Worker，並讓進行中與排隊中的請求全部 reject", async () => {
    const { e, workers } = harness();
    const p1 = e.embed(["a"]);
    const p2 = e.embed(["b"]);
    e.dispose();
    await expect(p1).rejects.toThrow("已關閉");
    await expect(p2).rejects.toThrow("已關閉");
    expect(workers[0].terminated).toBe(true);
    expect(e.queued).toBe(0);
  });
});

describe("isAvailable", () => {
  const files = requiredFiles(MULTILINGUAL);
  const res = (ok: boolean, type = "application/octet-stream") => ({ ok, headers: new Headers({ "content-type": type }) }) as unknown as Response;

  it("沒有 Worker 支援 → false，原因說明「Worker 不可用」且不退回主執行緒；不發任何請求", async () => {
    const fetchFn = vi.fn();
    const e = new WorkerEmbedder({ supported: () => false, fetchFn: fetchFn as unknown as typeof fetch });
    expect(await e.isAvailable()).toBe(false);
    expect(e.unavailableReason()).toContain("Worker 不可用");
    expect(e.unavailableReason()).toContain("不退回主執行緒");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("模型檔缺任一個 → false，原因為「模型未安裝」；補齊後變 true（失敗不快取）", async () => {
    let missing: string | null = files[1];
    const fetchFn = vi.fn(async (u: RequestInfo | URL) => res(String(u) !== missing));
    const e = new WorkerEmbedder({ supported: () => true, fetchFn: fetchFn as unknown as typeof fetch });
    expect(await e.isAvailable()).toBe(false);
    expect(e.unavailableReason()).toContain("模型未安裝");
    missing = null;
    expect(await e.isAvailable()).toBe(true);
    expect(e.unavailableReason()).toBeUndefined();
  });

  it("text/html（Next 404 頁）視為不存在", async () => {
    const fetchFn = vi.fn(async (u: RequestInfo | URL) => (String(u).endsWith("tokenizer.json") ? res(true, "text/html") : res(true)));
    const e = new WorkerEmbedder({ supported: () => true, fetchFn: fetchFn as unknown as typeof fetch });
    expect(await e.isAvailable()).toBe(false);
  });
});

describe("與 handleMessage 串接（同一份協定，不經過真的 Worker）", () => {
  /** 以 handleMessage 驅動的 fake worker：行為等同 embed.worker.ts 的薄殼 */
  function loopbackWorker(engine: EmbedEngine): WorkerLike {
    const w: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(m) {
        void handleMessage(engine, m).then(({ response }) => queueMicrotask(() => w.onmessage?.({ data: response })));
      },
      terminate() {},
    };
    return w;
  }

  it("端到端：WorkerEmbedder → handleMessage(engine) → 向量；engine 丟錯會變成 reject", async () => {
    const good = new WorkerEmbedder({ spawn: () => loopbackWorker({ embed: async (t) => t.map((_, i) => vec(i + 1)) }), supported: () => true });
    const out = await good.embed(["a", "b", "c"]);
    expect(out.map((v) => v[0])).toEqual([1, 2, 3]);
    const bad = new WorkerEmbedder({ spawn: () => loopbackWorker({ embed: async () => { throw new Error("推論失敗"); } }), supported: () => true });
    await expect(bad.embed(["a"])).rejects.toThrow("推論失敗");
  });
});
