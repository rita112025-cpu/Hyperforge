import { describe, expect, it } from "vitest";
import { buildGraph } from "./build";
import { buildDigest } from "../outputs/digest";
import { GraphClient, type GraphWorkerLike } from "./graph-client";
import { handleGraphRequest, type GraphRequest } from "./graph.worker";
import type { GraphDocument } from "./types";

const doc = (id: string, text: string): GraphDocument => ({
  id,
  name: id,
  rawText: text,
  chunks: [{ index: 0, start: 0, end: text.length }],
});
const docs = [doc("A", "alpha bravo. alpha bravo. charlie delta. charlie delta.")];

function fakeWorker() {
  const w: GraphWorkerLike & { sent: GraphRequest[]; terminated: boolean; reply(i: number): void } = {
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
      w.onmessage?.({ data: handleGraphRequest(w.sent[i]) });
    },
  };
  return w;
}

describe("GraphClient", () => {
  it("worker 結果等同同步 buildGraph", async () => {
    const w = fakeWorker();
    const c = new GraphClient({ spawn: () => w, supported: () => true });
    const p = c.build(docs);
    w.reply(0);
    expect(await p).toEqual(buildGraph(docs));
  });

  it("不支援 Worker 時退回同步建圖", async () => {
    const c = new GraphClient({ supported: () => false });
    expect(await c.build(docs)).toEqual(buildGraph(docs));
  });

  it("Worker 建立失敗時退回同步建圖", async () => {
    const c = new GraphClient({ spawn: () => { throw new Error("CSP"); }, supported: () => true });
    expect(await c.build(docs)).toEqual(buildGraph(docs));
  });

  it("取消進行中的請求會終止 Worker 並以 AbortError reject", async () => {
    const w = fakeWorker();
    const c = new GraphClient({ spawn: () => w, supported: () => true });
    const ac = new AbortController();
    const p = c.build(docs, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(w.terminated).toBe(true);
  });

  it("排隊中的請求在取消另一個後仍會在新 Worker 完成", async () => {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const c = new GraphClient({ spawn: () => { const w = fakeWorker(); workers.push(w); return w; }, supported: () => true });
    const ac = new AbortController();
    const first = c.build(docs, ac.signal);
    const second = c.build(docs);
    ac.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(workers).toHaveLength(2);
    workers[1].reply(0);
    expect(await second).toEqual(buildGraph(docs));
  });

  it("已取消的 signal 直接 reject", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(new GraphClient({ supported: () => false }).build(docs, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("GraphClient analysis", () => {
  it("從同一次 Worker 運算取得一致的圖譜與摘要", async () => {
    const w = fakeWorker();
    const c = new GraphClient({ spawn: () => w, supported: () => true });
    const p = c.analyze(docs);
    expect(w.sent[0].includeDigest).toBe(true);
    w.reply(0);
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
    const broken = fakeWorker();
    broken.postMessage = () => { throw new DOMException("clone failed", "DataCloneError"); };
    const healthy = fakeWorker();
    let spawned = 0;
    const c = new GraphClient({ spawn: () => spawned++ === 0 ? broken : healthy, supported: () => true });
    await expect(c.analyze(docs)).rejects.toThrow("clone failed");
    expect(broken.terminated).toBe(true);
    const next = c.analyze(docs);
    healthy.reply(0);
    expect((await next).graph).toEqual(buildGraph(docs));
  });
});
