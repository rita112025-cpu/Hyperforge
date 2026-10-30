import { describe, expect, it } from "vitest";
import { buildGraph } from "./build";
import { buildDigest } from "../outputs/digest";
import { GraphClient, type GraphWorkerLike } from "./graph-client";
import { createGraphHost, type GraphRequest, type GraphResponse } from "./graph-protocol";
import type { GraphDocument } from "./types";

const doc = (id: string, text: string): GraphDocument => ({
  id,
  name: id,
  rawText: text,
  chunks: [{ index: 0, start: 0, end: text.length }],
});
const docs = [doc("A", "alpha bravo. alpha bravo. charlie delta. charlie delta.")];

/** 把 createGraphHost 包成 fake Worker：auto=false 時，訊息要等 flush() 才送達（模擬尚未回應的 Worker）。 */
function fakeWorker(auto = true) {
  const w: GraphWorkerLike & { sent: GraphRequest[]; terminated: boolean; flush(): void } = {
    sent: [],
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage(m) {
      w.sent.push(m);
      if (auto) host.onMessage(m);
    },
    terminate() {
      w.terminated = true;
    },
    flush() {
      for (const m of w.sent.splice(0)) host.onMessage(m);
    },
  };
  const host = createGraphHost((m) => w.onmessage?.({ data: m }));
  return w;
}

describe("GraphClient", () => {
  it("worker 結果等同同步 buildGraph", async () => {
    const w = fakeWorker();
    const c = new GraphClient({ spawn: () => w, supported: () => true });
    expect(await c.build(docs)).toEqual(buildGraph(docs));
  });

  it("依序回報 extract → build 進度", async () => {
    const c = new GraphClient({ spawn: () => fakeWorker(), supported: () => true });
    const stages: string[] = [];
    await c.build(docs, { onProgress: (p) => stages.push(`${p.stage}:${p.progress}`) });
    expect(stages).toEqual(["extract:0", "extract:1", "build:0", "build:1"]);
  });

  it("buildFromText 在 Worker 內切 chunk，結果等同先切再同步建圖", async () => {
    const c = new GraphClient({ spawn: () => fakeWorker(), supported: () => true });
    const text = docs[0].rawText;
    const r = await c.buildFromText("a.md", text);
    expect(r.doc?.chunks.length).toBeGreaterThan(0);
    expect(r.graph).toEqual(buildGraph([r.doc!]));
    expect(r.stageMs).toEqual(expect.objectContaining({ chunk: expect.any(Number), extract: expect.any(Number) }));
  });

  it("不支援 Worker 時退回主執行緒建圖", async () => {
    const c = new GraphClient({ supported: () => false });
    expect(await c.build(docs)).toEqual(buildGraph(docs));
    expect(c.getStats().fallback).toBe(true);
  });

  it("Worker 建立失敗時退回主執行緒建圖", async () => {
    const c = new GraphClient({ spawn: () => { throw new Error("CSP"); }, supported: () => true });
    expect(await c.build(docs)).toEqual(buildGraph(docs));
  });

  it("取消進行中的請求（grace=0）會終止 Worker 並以 AbortError reject", async () => {
    const w = fakeWorker(false);
    const c = new GraphClient({ spawn: () => w, supported: () => true, abortGraceMs: 0 });
    const ac = new AbortController();
    const p = c.build(docs, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(w.terminated).toBe(true);
  });

  it("取消進行中的請求：Worker 在 grace 內回 done 就不終止，下一個請求沿用同一個 Worker", async () => {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const c = new GraphClient({ spawn: () => { const w = fakeWorker(); workers.push(w); return w; }, supported: () => true, abortGraceMs: 1000 });
    const ac = new AbortController();
    const first = c.build(docs, { signal: ac.signal });
    const second = c.build(docs);
    ac.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(await second).toEqual(buildGraph(docs));
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(false);
    expect(c.getStats()).toMatchObject({ completed: 1, aborted: 1, queued: 0, running: false });
  });

  it("排隊中的請求在取消另一個後仍會在新 Worker 完成", async () => {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const c = new GraphClient({ spawn: () => { const w = fakeWorker(false); workers.push(w); return w; }, supported: () => true, abortGraceMs: 0 });
    const ac = new AbortController();
    const first = c.build(docs, { signal: ac.signal });
    const second = c.build(docs);
    ac.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(workers).toHaveLength(2);
    workers[1].flush();
    expect(await second).toEqual(buildGraph(docs));
  });

  it("abortAll 取消進行中與排隊中的請求，之後仍可使用", async () => {
    const c = new GraphClient({ spawn: () => fakeWorker(false), supported: () => true, abortGraceMs: 0 });
    const a = c.build(docs);
    const b = c.build(docs);
    expect(c.getStats()).toMatchObject({ queued: 1, running: true });
    c.abortAll();
    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    await expect(b).rejects.toMatchObject({ name: "AbortError" });
    expect(c.getStats()).toMatchObject({ queued: 0, running: false, workerAlive: false });
  });

  it("已取消的 signal 直接 reject", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(new GraphClient({ supported: () => false }).build(docs, { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("createGraphHost", () => {
  it("FIFO：排隊中的請求被 abort 時回 error(aborted)+done，不影響進行中的請求", async () => {
    const out: GraphResponse[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const host = createGraphHost((m) => out.push(m), {
      yieldTask: () => (first ? ((first = false), gate) : Promise.resolve()),
    });
    host.onMessage({ type: "build", id: 1, docs });
    host.onMessage({ type: "build", id: 2, docs });
    host.onMessage({ type: "abort", id: 2 });
    expect(out.filter((m) => m.id === 2).map((m) => m.type)).toEqual(["error", "done"]);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(out.filter((m) => m.id === 1).map((m) => m.type)).toContain("graph");
  });

  it("進行中的請求被 abort 時在下一個段落邊界停下", async () => {
    const out: GraphResponse[] = [];
    const host = createGraphHost((m) => out.push(m));
    host.onMessage({ type: "build", id: 7, docs });
    host.onMessage({ type: "abort", id: 7 });
    await new Promise((r) => setTimeout(r, 10));
    expect(out.map((m) => m.type)).toEqual(["error", "done"]);
    expect(out[0]).toMatchObject({ type: "error", aborted: true });
  });

  it("無效請求回 error + done", () => {
    const out: GraphResponse[] = [];
    createGraphHost((m) => out.push(m)).onMessage({ id: 3, type: "nope" });
    expect(out).toEqual([{ type: "error", id: 3, error: "無效的 graph 請求", aborted: false }, { type: "done", id: 3 }]);
  });
});

describe("GraphClient analysis", () => {
  it("從同一次 Worker 運算取得一致的圖譜與摘要", async () => {
    const w = fakeWorker(false);
    const c = new GraphClient({ spawn: () => w, supported: () => true });
    const p = c.analyze(docs);
    expect(w.sent[0]).toMatchObject({ type: "build", includeDigest: true });
    w.flush();
    const graph = buildGraph(docs);
    expect(await p).toEqual({ graph, digest: buildDigest(docs, graph) });
  });

  it("沒有概念時不抽摘要，但保留文件統計", async () => {
    const short = [doc("short", "今天開會。")];
    const result = await new GraphClient({ supported: () => false }).analyze(short);
    expect(result.graph.nodes).toHaveLength(0);
    expect(result.digest).toBeNull();
    expect(result.graph.stats.docCount).toBe(1);
  });

  it("傳送失敗後清除進行中工作，下一份仍能完成", async () => {
    const broken = fakeWorker(false);
    broken.postMessage = () => { throw new DOMException("clone failed", "DataCloneError"); };
    const healthy = fakeWorker(false);
    let spawned = 0;
    const c = new GraphClient({ spawn: () => (spawned++ === 0 ? broken : healthy), supported: () => true });
    await expect(c.build(docs)).rejects.toThrow("clone failed");
    expect(broken.terminated).toBe(true);
    const next = c.build(docs);
    healthy.flush();
    expect(await next).toEqual(buildGraph(docs));
  });
});

