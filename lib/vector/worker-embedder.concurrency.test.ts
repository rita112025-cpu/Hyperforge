import { describe, expect, it, vi } from "vitest";
import type { EmbedRequest } from "./embed-protocol";
import { MULTILINGUAL } from "./model-spec";
import { WorkerEmbedder, type WorkerLike } from "./worker-embedder";

const DIM = MULTILINGUAL.dim;
const vec = (seed: number) => new Float32Array(DIM).fill(seed);
const tick = () => new Promise((r) => setTimeout(r, 0));

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
  return { e: new WorkerEmbedder({ spawn, supported: () => true }), workers, spawn };
}

describe("多檔並發：取消其中一個，其他不受影響（FIFO 佇列 + 重新派送，不是重試）", () => {
  it("A 進行中、B 與 C 排隊；取消 A → B、C 在新 Worker 上依序完成，結果各自正確，A 不會被重新執行", async () => {
    const { e, workers } = harness();
    const ac = new AbortController();
    const a = e.embed(["A"], { signal: ac.signal });
    const b = e.embed(["B1", "B2"]);
    const c = e.embed(["C"]);
    ac.abort();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    expect(workers).toHaveLength(2);
    expect(workers[1].requests.map((r) => r.texts)).toEqual([["B1", "B2"]]);
    workers[1].ok(workers[1].requests[0]);
    expect(await b).toHaveLength(2);
    expect(workers[1].requests.map((r) => r.texts)).toEqual([["B1", "B2"], ["C"]]);
    workers[1].ok(workers[1].requests[1]);
    expect(await c).toHaveLength(1);
    const sent = workers.flatMap((w) => w.requests.map((r) => r.texts.join()));
    expect(sent.filter((t) => t === "A")).toHaveLength(1); // A 只送出過一次
  });

  it("取消佇列中的 B：A 不受影響，Worker 不被終止，B 從未送出", async () => {
    const { e, workers } = harness();
    const ac = new AbortController();
    const a = e.embed(["A"]);
    const b = e.embed(["B"], { signal: ac.signal });
    ac.abort();
    await expect(b).rejects.toMatchObject({ name: "AbortError" });
    workers[0].ok(workers[0].requests[0]);
    await expect(a).resolves.toHaveLength(1);
    expect(workers[0].terminated).toBe(false);
    expect(workers[0].requests.map((r) => r.texts.join())).toEqual(["A"]);
  });

  it("Worker 自己 crash：進行中失敗、不重試；佇列中的請求在新 Worker 上繼續", async () => {
    const { e, workers } = harness();
    const a = e.embed(["A"]);
    const b = e.embed(["B"]);
    workers[0].onerror?.({ message: "oom" });
    await expect(a).rejects.toThrow("oom");
    expect(workers[1].requests.map((r) => r.texts.join())).toEqual(["B"]);
    workers[1].ok(workers[1].requests[0]);
    await expect(b).resolves.toHaveLength(1);
    expect(workers.flatMap((w) => w.requests.map((r) => r.texts.join())).filter((t) => t === "A")).toHaveLength(1);
  });
});

describe("過期回應與資源洩漏", () => {
  it("terminate 後舊 Worker 的 handler 已拆除：補送的舊回應 / 錯誤都無法抵達，也不影響新請求", async () => {
    const { e, workers } = harness();
    const ac = new AbortController();
    const a = e.embed(["A"], { signal: ac.signal });
    const old = workers[0];
    const oldReq = old.requests[0];
    ac.abort();
    await expect(a).rejects.toBeTruthy();
    expect(old.onmessage).toBeNull();
    expect(old.onerror).toBeNull();
    const b = e.embed(["B"]);
    old.reply({ id: oldReq.id, ok: true, vectors: [vec(7)] });
    old.onerror?.({ message: "late" });
    let settled = false;
    void b.then(
      () => (settled = true),
      () => (settled = true),
    );
    await tick();
    expect(settled).toBe(false);
    workers[1].ok(workers[1].requests[0]);
    const out = await b;
    expect(out[0][0]).toBe(1); // 新 Worker 的結果（vec(1)），不是舊的 vec(7)
  });

  it("即使舊 Worker 的 handler 仍被呼叫（模擬已在事件佇列中的訊息），過期 id 也不會配到新請求", async () => {
    const { e, workers } = harness();
    const ac = new AbortController();
    const a = e.embed(["A"], { signal: ac.signal });
    const old = workers[0];
    const staleHandler = old.onmessage!; // 在 terminate 之前先抓住 handler
    const oldId = old.requests[0].id;
    ac.abort();
    await a.catch(() => undefined);
    const b = e.embed(["B"]);
    staleHandler({ data: { id: oldId, ok: true, vectors: [vec(7)] } }); // 事件佇列中已存在的舊訊息
    let settled = false;
    void b.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    workers[1].ok(workers[1].requests[0]);
    expect((await b)[0][0]).toBe(1);
  });

  it("request id 全域遞增（跨 Worker 世代不重複）", async () => {
    const { e, workers } = harness();
    const ac = new AbortController();
    const a = e.embed(["A"], { signal: ac.signal });
    ac.abort();
    await a.catch(() => undefined);
    const b = e.embed(["B"]);
    workers[1].ok(workers[1].requests[0]);
    await b;
    expect(workers[1].requests[0].id).toBeGreaterThan(workers[0].requests[0].id);
  });

  it("abort listener 在請求結算時移除（成功、失敗兩種情況都不累積）", async () => {
    const { e, workers } = harness();
    const ac = new AbortController();
    const add = vi.spyOn(ac.signal, "addEventListener");
    const remove = vi.spyOn(ac.signal, "removeEventListener");
    const p1 = e.embed(["a"], { signal: ac.signal });
    workers[0].ok(workers[0].requests[0]);
    await p1;
    const p2 = e.embed(["b"], { signal: ac.signal });
    workers[0].reply({ id: workers[0].requests[1].id, ok: false, error: "x" });
    await p2.catch(() => undefined);
    expect(add).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("Worker 只在第一次 embed 時建立：建構 / isAvailable 不會 new Worker", async () => {
    const spawn = vi.fn(() => new ManualWorker());
    const e = new WorkerEmbedder({
      spawn,
      supported: () => true,
      fetchFn: (async () => ({ ok: true, headers: new Headers() })) as unknown as typeof fetch,
    });
    await e.isAvailable();
    expect(spawn).not.toHaveBeenCalled();
    void e.embed(["a"]).catch(() => undefined);
    expect(spawn).toHaveBeenCalledTimes(1);
    e.dispose();
  });

  it("disposeAll 終止所有存活的 WorkerEmbedder（開發時 HMR 重建模組用，避免孤兒 Worker）", async () => {
    const w1 = new ManualWorker();
    const w2 = new ManualWorker();
    const e1 = new WorkerEmbedder({ spawn: () => w1, supported: () => true });
    const e2 = new WorkerEmbedder({ spawn: () => w2, supported: () => true });
    const p1 = e1.embed(["a"]).catch(() => "rejected");
    const p2 = e2.embed(["b"]).catch(() => "rejected");
    WorkerEmbedder.disposeAll();
    expect(await p1).toBe("rejected");
    expect(await p2).toBe("rejected");
    expect(w1.terminated && w2.terminated).toBe(true);
  });
});
