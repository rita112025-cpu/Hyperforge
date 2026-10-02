import { describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { runPipeline } from "./runner";
import { HyperforgeDB } from "../vector/db";
import { FakeEmbedder } from "../vector/fake-embedder.test-util";
import { VectorStore } from "../vector/index-store";
import type { Embedder } from "../vector/embedder";
import type { StageId } from "./types";

const textSource = (n: number) => ({ kind: "text" as const, text: Array.from({ length: n }, (_, i) => `w${i}`).join(" ") });

describe("runPipeline", () => {
  it("每階段 progress 單調遞增且最終為 1；pending 階段不回報", async () => {
    const seen = new Map<StageId, number[]>();
    await runPipeline(textSource(2000), {
      onStage: (id, p) => {
        if (p.progress !== undefined) seen.set(id, [...(seen.get(id) ?? []), p.progress]);
      },
    });
    for (const id of ["PARSE", "DECONSTRUCT", "LINK"] as const) {
      const xs = seen.get(id)!;
      expect(xs.every((v, i) => i === 0 || v >= xs[i - 1])).toBe(true);
      expect(xs.at(-1)).toBe(1);
    }
    expect(seen.has("RECOMBINE")).toBe(false);
  });

  it("空輸入不產生 NaN", async () => {
    const all: number[] = [];
    await runPipeline({ kind: "text", text: "" }, { onStage: (_, p) => p.progress !== undefined && all.push(p.progress) });
    expect(all.every(Number.isFinite)).toBe(true);
  });

  it("取消後不再回報 progress", async () => {
    const ac = new AbortController();
    const calls: number[] = [];
    ac.abort();
    await expect(
      runPipeline(textSource(100), { signal: ac.signal, onStage: (_, p) => p.progress !== undefined && calls.push(p.progress) }),
    ).rejects.toThrow();
    expect(calls.filter((v) => v > 0)).toEqual([]);
  });

  it("中途取消（PARSE 完成時）：rejects、LINK 無 progress>0、DECONSTRUCT 不會 done", async () => {
    const ac = new AbortController();
    const events: Array<[StageId, Partial<import("./types").StageState>]> = [];
    await expect(
      runPipeline(textSource(2000), {
        signal: ac.signal,
        onStage: (id, p) => {
          events.push([id, p]);
          if (id === "PARSE" && p.status === "done") ac.abort();
        },
      }),
    ).rejects.toThrow();
    expect(events.filter(([id, p]) => id === "LINK" && (p.progress ?? 0) > 0)).toEqual([]);
    expect(events.filter(([id, p]) => id === "DECONSTRUCT" && p.status === "done")).toEqual([]);
  });

  it("未注入 store：LINK 略過向量化，indexed=false，不丟錯", async () => {
    const out = await runPipeline(textSource(100), { onStage: () => undefined });
    expect(out.indexed).toBe(false);
    expect(out.docId).toBeUndefined();
  });

  it("embedder 不可用：indexed=false、不寫入 DB、不丟錯", async () => {
    const db = new HyperforgeDB(`r-unavail-${Date.now()}`);
    const store = new VectorStore(db, new FakeEmbedder(64, false));
    await store.init();
    const out = await runPipeline(textSource(600), { store, onStage: () => undefined });
    expect(out.indexed).toBe(false);
    expect(await db.docs.count()).toBe(0);
    db.close();
    await db.delete();
  });

  it("注入 fake-embedder：向量化進度單調且最終 LINK=1，寫入 DB", async () => {
    const db = new HyperforgeDB(`r-ok-${Date.now()}`);
    const store = new VectorStore(db, new FakeEmbedder());
    await store.init();
    const xs: number[] = [];
    const out = await runPipeline(textSource(2000), {
      store,
      onStage: (id, p) => id === "LINK" && p.progress !== undefined && xs.push(p.progress),
    });
    expect(out.indexed).toBe(true);
    expect(xs.every((v, i) => i === 0 || v >= xs[i - 1])).toBe(true);
    expect(xs.at(-1)).toBe(1);
    expect(await db.docs.count()).toBe(1);
    db.close();
    await db.delete();
  });

  it("向量化中途取消：DB 不留資料", async () => {
    const db = new HyperforgeDB(`r-abort-${Date.now()}`);
    const store = new VectorStore(db, new FakeEmbedder());
    await store.init();
    const ac = new AbortController();
    await expect(
      runPipeline(textSource(6000), {
        store,
        signal: ac.signal,
        onStage: (id, p) => id === "LINK" && (p.progress ?? 0) > 0.3 && ac.abort(),
      }),
    ).rejects.toThrow();
    expect([await db.docs.count(), await db.chunks.count(), await db.vectors.count()]).toEqual([0, 0, 0]);
    db.close();
    await db.delete();
  });

  describe("向量化失敗（模型檔存在、isAvailable=true，但推論／載入失敗）：不得讓 job 變 error 或讓畫布資料消失", () => {
    const failing = (err: unknown = new Error("embed failed mid-way")): Embedder => ({
      id: "failing-v1",
      dim: 64,
      isAvailable: async () => true,
      embed: async () => {
        throw err;
      },
    });

    it("ingest 丟一般錯誤：runPipeline 仍回傳 context（indexed=false），LINK 註記失敗原因，DB 不留半個 doc", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const db = new HyperforgeDB(`r-embed-fail-${Date.now()}`);
      const store = new VectorStore(db, failing());
      await store.init();
      const notes: string[] = [];
      const out = await runPipeline(textSource(600), {
        store,
        onStage: (id, p) => id === "LINK" && p.note && notes.push(p.note),
      });
      errSpy.mockRestore();
      expect(out.indexed).toBe(false);
      expect(out.docId).toBeUndefined();
      expect(out.chunks.length).toBeGreaterThan(0);
      expect(out.rawText.length).toBeGreaterThan(0); // 文字仍交給呼叫端（畫布 / 持久化）
      expect(notes.some((n) => /向量化失敗：embed failed mid-way/.test(n) && /不使用假向量/.test(n))).toBe(true);
      expect([await db.docs.count(), await db.chunks.count(), await db.vectors.count()]).toEqual([0, 0, 0]);
      db.close();
      await db.delete();
    });

    it("isAvailable 本身丟錯：同樣降級為 indexed=false，不丟錯", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const db = new HyperforgeDB(`r-avail-throw-${Date.now()}`);
      const store = new VectorStore(db, { ...failing(), isAvailable: async () => Promise.reject(new Error("probe exploded")) });
      await store.init();
      const out = await runPipeline(textSource(100), { store, onStage: () => undefined });
      errSpy.mockRestore();
      expect(out.indexed).toBe(false);
      db.close();
      await db.delete();
    });

    it("取消仍然 rethrow（AbortError）：即使 embedder 在被取消後丟的是一般錯誤", async () => {
      const ac = new AbortController();
      const db = new HyperforgeDB(`r-abort-then-fail-${Date.now()}`);
      const store = new VectorStore(db, {
        ...failing(),
        embed: async () => {
          ac.abort();
          throw new Error("boom after abort");
        },
      });
      await store.init();
      await expect(runPipeline(textSource(600), { store, signal: ac.signal, onStage: () => undefined })).rejects.toMatchObject({ name: "AbortError" });
      db.close();
      await db.delete();
    });
  });
});
