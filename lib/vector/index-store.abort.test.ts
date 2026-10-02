import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { chunkText } from "../pipeline/chunker";
import { HyperforgeDB } from "./db";
import { VectorStore } from "./index-store";
import { WorkerEmbedder, type WorkerLike } from "./worker-embedder";

const dbs: HyperforgeDB[] = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) {
    d.close();
    await d.delete();
  }
});

describe("embedding 進行中被取消（真的 WorkerEmbedder + 假 Worker）", () => {
  it("ingest 以 AbortError（DOMException）結束、DB 無殘留、Worker 被終止；沒有被當成一般錯誤", async () => {
    let terminated = false;
    const posted: unknown[] = [];
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage: (m) => void posted.push(m),
      terminate: () => void (terminated = true),
    };
    const embedder = new WorkerEmbedder({ spawn: () => worker, supported: () => true });
    const db = new HyperforgeDB(`abort-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    dbs.push(db);
    const store = new VectorStore(db, embedder);
    await store.init();

    const raw = Array.from({ length: 900 }, (_, i) => `w${i}`).join(" ");
    const ac = new AbortController();
    const run = store.ingest({ name: "a.md", rawText: raw, chunks: chunkText(raw) }, () => undefined, ac.signal);
    await new Promise((r) => setTimeout(r, 20));
    expect(posted).toHaveLength(1); // 卡在第一個批次（Worker 沒有回覆）
    ac.abort();

    const err = await run.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
    expect(terminated).toBe(true);
    expect([await db.docs.count(), await db.chunks.count(), await db.vectors.count(), store.indexSize]).toEqual([0, 0, 0, 0]);
  });
});
