import { describe, expect, it } from "vitest";
import { chunkText } from "./chunker";
import { runDeconstruct, type DeconstructRequest } from "./deconstruct-core";
import { DeconstructClient, type DeconstructWorkerLike } from "./deconstruct-client";
import { runPipeline } from "./runner";

const big = Array.from({ length: 3200 }, (_, i) => `詞${i % 50}word${i}`).join(" ");
const expected = chunkText(big);

type FakeWorker = DeconstructWorkerLike & { sent: DeconstructRequest[]; terminated: boolean; reply(i: number): void; fail(msg: string): void };
function fakeWorker(): FakeWorker {
  const w: FakeWorker = {
    sent: [],
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage(m) {
      w.sent.push(m);
    },
    terminate() {
      w.terminated = true;
    },
    reply(i) {
      w.onmessage?.({ data: runDeconstruct(w.sent[i]) });
    },
    fail(msg) {
      w.onerror?.({ message: msg });
    },
  };
  return w;
}

describe("DeconstructClient", () => {
  it("測試語料確實產生多個 chunk", () => {
    expect(expected.length).toBeGreaterThan(5);
  });

  it("Worker 正常完成，結果與同步核心完全相同", async () => {
    const w = fakeWorker();
    const c = new DeconstructClient({ spawn: () => w, supported: () => true });
    const p = c.deconstruct(big);
    w.reply(0);
    expect(await p).toEqual(expected);
  });

  it("Worker 不存在 → 同步 fallback，結果相同", async () => {
    const c = new DeconstructClient({ supported: () => false });
    expect(await c.deconstruct(big)).toEqual(expected);
  });

  it("Worker constructor throw → fallback，不 pending", async () => {
    const c = new DeconstructClient({ spawn: () => { throw new Error("CSP"); }, supported: () => true });
    expect(await c.deconstruct(big)).toEqual(expected);
  });

  it("初始化失敗（尚未成功回應就 onerror）→ fallback；之後也不再嘗試 Worker", async () => {
    let spawned = 0;
    const w = fakeWorker();
    const c = new DeconstructClient({ spawn: () => { spawned++; return w; }, supported: () => true });
    const p = c.deconstruct(big);
    w.fail("script load failed");
    expect(await p).toEqual(expected);
    expect(w.terminated).toBe(true);
    expect(await c.deconstruct(big)).toEqual(expected);
    expect(spawned).toBe(1);
  });

  it("Worker 已可用後的執行錯誤 → reject 並保留訊息，下一筆在新 Worker 成功", async () => {
    const workers: FakeWorker[] = [];
    const c = new DeconstructClient({ spawn: () => { const w = fakeWorker(); workers.push(w); return w; }, supported: () => true });
    const p1 = c.deconstruct("alpha beta");
    workers[0].reply(0);
    await p1;
    const p2 = c.deconstruct(big);
    workers[0].fail("OOM in worker");
    await expect(p2).rejects.toThrow("OOM in worker");
    const p3 = c.deconstruct(big);
    expect(workers).toHaveLength(2);
    workers[1].reply(0);
    expect(await p3).toEqual(expected);
  });

  it("演算法錯誤（ok:false）→ reject，保留訊息", async () => {
    const w = fakeWorker();
    const c = new DeconstructClient({ spawn: () => w, supported: () => true });
    const p = c.deconstruct(big);
    w.onmessage?.({ data: { id: w.sent[0].id, ok: false, error: "boom" } });
    await expect(p).rejects.toThrow("boom");
  });

  it("取消進行中的請求 → AbortError 並終止 Worker；之後的請求可成功", async () => {
    const workers: FakeWorker[] = [];
    const c = new DeconstructClient({ spawn: () => { const w = fakeWorker(); workers.push(w); return w; }, supported: () => true });
    const ac = new AbortController();
    const p = c.deconstruct(big, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0].terminated).toBe(true);
    const next = c.deconstruct(big);
    workers[1].reply(0);
    expect(await next).toEqual(expected);
  });

  it("stale response 不會污染新 request", async () => {
    const workers: FakeWorker[] = [];
    const c = new DeconstructClient({ spawn: () => { const w = fakeWorker(); workers.push(w); return w; }, supported: () => true });
    const ac = new AbortController();
    const old = c.deconstruct("old text here", ac.signal);
    ac.abort();
    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    const fresh = c.deconstruct(big);
    // 舊 Worker 補送回應：handler 已拆除，不可能被配到新請求
    workers[0].onmessage?.({ data: runDeconstruct({ id: workers[0].sent[0].id, rawText: "old text here" }) });
    // 即使同一個 Worker 收到錯 id 的回應，也會被忽略
    workers[1].onmessage?.({ data: runDeconstruct({ id: 999999, rawText: "wrong" }) });
    workers[1].reply(0);
    expect(await fresh).toEqual(expected);
  });

  it("排隊中的請求取消不影響進行中的請求", async () => {
    const w = fakeWorker();
    const c = new DeconstructClient({ spawn: () => w, supported: () => true });
    const ac = new AbortController();
    const first = c.deconstruct(big);
    const queued = c.deconstruct("x y z", ac.signal);
    ac.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    w.reply(0);
    expect(await first).toEqual(expected);
    expect(w.sent).toHaveLength(1);
  });

  it("dispose 會 reject 所有未完成請求，不留 unresolved Promise", async () => {
    const w = fakeWorker();
    const c = new DeconstructClient({ spawn: () => w, supported: () => true });
    const a = c.deconstruct(big);
    const b = c.deconstruct(big);
    c.dispose();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    await expect(b).rejects.toMatchObject({ name: "AbortError" });
  });

  it("完成後不留下 abort listener", async () => {
    const w = fakeWorker();
    const c = new DeconstructClient({ spawn: () => w, supported: () => true });
    const ac = new AbortController();
    let live = 0;
    const add = ac.signal.addEventListener.bind(ac.signal);
    const rem = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((...a: Parameters<typeof add>) => { live++; return add(...a); }) as typeof add;
    ac.signal.removeEventListener = ((...a: Parameters<typeof rem>) => { live--; return rem(...a); }) as typeof rem;
    const p = c.deconstruct(big, ac.signal);
    expect(live).toBe(1);
    w.reply(0);
    await p;
    expect(live).toBe(0);
    ac.abort();
    expect(w.terminated).toBe(false);
  });
});

describe("runPipeline + chunker", () => {
  it("注入 Worker 版 chunker 後，pipeline 的 chunks 與同步版逐欄位相同", async () => {
    const w = fakeWorker();
    const c = new DeconstructClient({ spawn: () => w, supported: () => true });
    const stages: string[] = [];
    const run = runPipeline({ kind: "text", text: big }, {
      onStage: (id, patch) => { if (patch.status) stages.push(`${id}:${patch.status}`); },
      chunker: (t, s) => c.deconstruct(t, s),
    });
    await new Promise((r) => setTimeout(r, 20));
    w.reply(0);
    const ctx = await run;
    expect(ctx.chunks).toEqual(expected);
    expect(ctx.chunks.length).toBeGreaterThan(5);
    expect(stages).toContain("DECONSTRUCT:done");
  });

  it("DECONSTRUCT 期間取消 → pipeline 以 AbortError 結束且 Worker 被終止", async () => {
    const w = fakeWorker();
    const c = new DeconstructClient({ spawn: () => w, supported: () => true });
    const ac = new AbortController();
    const run = runPipeline({ kind: "text", text: big }, {
      onStage: () => undefined,
      signal: ac.signal,
      chunker: (t, s) => c.deconstruct(t, s),
    });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(w.terminated).toBe(true);
  });
});
