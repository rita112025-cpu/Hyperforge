import { describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { chunkText } from "./chunker";
import { raceAbort, runPipeline } from "./runner";
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

  it("未注入 store：LINK 略過向量化，vectorStatus=unavailable，不丟錯", async () => {
    const out = await runPipeline(textSource(100), { onStage: () => undefined });
    expect(out.vectorStatus).toBe("unavailable");
    expect(out.docId).toBeUndefined();
  });

  it("embedder 不可用：vectorStatus=unavailable、不寫入 DB、不丟錯", async () => {
    const db = new HyperforgeDB(`r-unavail-${Date.now()}`);
    const store = new VectorStore(db, new FakeEmbedder(64, false));
    await store.init();
    const out = await runPipeline(textSource(600), { store, onStage: () => undefined });
    expect(out.vectorStatus).toBe("unavailable");
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
    expect(out.vectorStatus).toBe("indexed");
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

    it("ingest 丟一般錯誤：runPipeline 仍回傳 context（vectorStatus=failed），LINK 註記失敗原因，DB 不留半個 doc", async () => {
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
      expect(out.vectorStatus).toBe("failed");
      expect(out.docId).toBeUndefined();
      expect(out.chunks.length).toBeGreaterThan(0);
      expect(out.rawText.length).toBeGreaterThan(0); // 文字仍交給呼叫端（畫布 / 持久化）
      expect(notes.some((n) => /向量化失敗：embed failed mid-way/.test(n) && /不使用假向量/.test(n))).toBe(true);
      expect([await db.docs.count(), await db.chunks.count(), await db.vectors.count()]).toEqual([0, 0, 0]);
      db.close();
      await db.delete();
    });

    it("isAvailable 本身丟錯：同樣降級為 vectorStatus=unavailable，不丟錯", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const db = new HyperforgeDB(`r-avail-throw-${Date.now()}`);
      const store = new VectorStore(db, { ...failing(), isAvailable: async () => Promise.reject(new Error("probe exploded")) });
      await store.init();
      const out = await runPipeline(textSource(100), { store, onStage: () => undefined });
      errSpy.mockRestore();
      expect(out.vectorStatus).toBe("unavailable");
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

// ───────────────────────── 第 5 輪：Text Commit Point 與取消語意 ─────────────────────────

const TEXT = Array.from({ length: 700 }, (_, i) => `word${i}`).join(" "); // 約 2 個 chunk

/** 可控的 embedder：呼叫會被記錄；可「卡住」到手動放行（模擬模型下載停滯 / 推論很慢）。 */
function controllable(opts: { gate?: boolean; fail?: boolean } = {}) {
  const base = new FakeEmbedder();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const calls: string[][] = [];
  const embedder: Embedder = {
    id: base.id,
    dim: base.dim,
    isAvailable: async () => true,
    embed: async (texts) => {
      calls.push(texts);
      if (opts.gate) await gate;
      if (opts.fail) throw new Error("embed exploded");
      return base.embed(texts);
    },
  };
  return { embedder, calls, release };
}

const dbName = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe("Text Commit Point：文字是 primary data，向量是 derived data", () => {
  it("onTextReady 恰好呼叫一次，在 DECONSTRUCT 完成之後、向量庫取得與 embedding 之前；chunks 完整", async () => {
    const db = new HyperforgeDB(dbName("tc-order"));
    const { embedder, calls } = controllable();
    const store = new VectorStore(db, embedder);
    await store.init();
    const events: string[] = [];
    const commits: unknown[] = [];
    await runPipeline(
      { kind: "text", text: TEXT },
      {
        onStage: (id, p) => p.status && events.push(`${id}:${p.status}`),
        onTextReady: async (payload) => {
          events.push("commit");
          commits.push(payload);
          return { status: "ready", docId: "doc-1" };
        },
        getStore: async () => {
          events.push("getStore");
          return { store };
        },
      },
    );
    expect(commits).toHaveLength(1);
    expect((commits[0] as { chunks: unknown[] }).chunks).toEqual(chunkText(TEXT)); // chunks 完整，與 DECONSTRUCT 的結果相同
    expect(calls.length).toBeGreaterThan(0);
    const at = (e: string) => events.indexOf(e);
    expect(at("DECONSTRUCT:done")).toBeGreaterThanOrEqual(0);
    expect(at("commit")).toBeGreaterThan(at("DECONSTRUCT:done"));
    expect(at("getStore")).toBeGreaterThan(at("commit")); // 向量庫（init 可能很慢）在文字 commit 之後才取得
    expect(at("LINK:running")).toBeGreaterThan(at("commit"));
    db.close();
    await db.delete();
  });

  it("成功：textStatus=ready、vectorStatus=indexed，docId 取自 commit", async () => {
    const db = new HyperforgeDB(dbName("tc-ok"));
    const store = new VectorStore(db, controllable().embedder);
    await store.init();
    const out = await runPipeline({ kind: "text", text: TEXT }, { onStage: () => undefined, onTextReady: () => ({ status: "ready", docId: "doc-1" }), getStore: async () => ({ store }) });
    expect([out.textStatus, out.vectorStatus, out.docId]).toEqual(["ready", "indexed", "doc-1"]);
    db.close();
    await db.delete();
  });

  it("文字 commit 完成時，向量庫尚未取得（getStore 卡住也不影響 commit）；此時取消 → 立即 AbortError，文字 commit 保留", async () => {
    const ac = new AbortController();
    let commits = 0;
    const run = runPipeline(
      { kind: "text", text: TEXT },
      {
        signal: ac.signal,
        onStage: () => undefined,
        onTextReady: () => (commits++, { status: "ready" as const, docId: "d" }),
        getStore: () => new Promise(() => undefined), // 永遠不 resolve：模擬向量庫初始化卡住
      },
    );
    await vi.waitFor(() => expect(commits).toBe(1));
    ac.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(commits).toBe(1);
  });

  it("沒有 onTextReady（舊式呼叫端）：textStatus 維持 pending，向量化照常進行", async () => {
    const db = new HyperforgeDB(dbName("tc-legacy"));
    const store = new VectorStore(db, controllable().embedder);
    await store.init();
    const out = await runPipeline({ kind: "text", text: TEXT }, { store, onStage: () => undefined });
    expect([out.textStatus, out.vectorStatus]).toEqual(["pending", "indexed"]);
    db.close();
    await db.delete();
  });

  it("空內容：沒有 chunk，不呼叫 onTextReady，textStatus=pending，vectorStatus=unavailable", async () => {
    const onTextReady = vi.fn();
    const out = await runPipeline({ kind: "text", text: "   " }, { onStage: () => undefined, onTextReady });
    expect(onTextReady).not.toHaveBeenCalled();
    expect([out.textStatus, out.vectorStatus]).toEqual(["pending", "unavailable"]);
  });
});

describe("取消語意（runner 層）：commit 之前取消不留資料；commit 之後取消不 rollback", () => {
  const abortOn = (match: (id: StageId, p: Partial<import("./types").StageState>) => boolean) => {
    const ac = new AbortController();
    const onTextReady = vi.fn(() => ({ status: "ready" as const, docId: "d" }));
    const run = () =>
      runPipeline({ kind: "text", text: TEXT }, { signal: ac.signal, onStage: (id, p) => match(id, p) && ac.abort(), onTextReady });
    return { run, onTextReady };
  };

  it("Case A：PARSE 開始時取消 → AbortError，onTextReady 不會被呼叫", async () => {
    const t = abortOn((id, p) => id === "PARSE" && p.status === "running");
    await expect(t.run()).rejects.toMatchObject({ name: "AbortError" });
    expect(t.onTextReady).not.toHaveBeenCalled();
  });

  it("Case A'：PARSE 完成的瞬間取消 → 不 commit", async () => {
    const t = abortOn((id, p) => id === "PARSE" && p.status === "done");
    await expect(t.run()).rejects.toMatchObject({ name: "AbortError" });
    expect(t.onTextReady).not.toHaveBeenCalled();
  });

  it("Case B：DECONSTRUCT 進行中取消 → 不 commit（不留半份 chunks）", async () => {
    const t = abortOn((id, p) => id === "DECONSTRUCT" && p.status === "running");
    await expect(t.run()).rejects.toMatchObject({ name: "AbortError" });
    expect(t.onTextReady).not.toHaveBeenCalled();
  });

  it("DECONSTRUCT 完成後、commit 之前的最後一刻取消 → 進入 commit 前的檢查擋下，不 commit", async () => {
    const t = abortOn((id, p) => id === "DECONSTRUCT" && p.status === "done");
    await expect(t.run()).rejects.toMatchObject({ name: "AbortError" });
    expect(t.onTextReady).not.toHaveBeenCalled();
  });

  it("Case C：commit 剛完成就取消 → AbortError，commit 已發生且只發生一次，向量化從未開始", async () => {
    const ac = new AbortController();
    const getStore = vi.fn();
    const onTextReady = vi.fn(() => {
      queueMicrotask(() => ac.abort()); // commit 完成後立刻取消
      return { status: "ready" as const, docId: "d" };
    });
    await expect(runPipeline({ kind: "text", text: TEXT }, { signal: ac.signal, onStage: () => undefined, onTextReady, getStore })).rejects.toMatchObject({ name: "AbortError" });
    expect(onTextReady).toHaveBeenCalledTimes(1);
    expect(getStore).not.toHaveBeenCalled();
  });

  it("Case C'：embedding 進行中取消 → 立即 rejects（不必等 embedding 結束）；之後 embedding 完成也不會寫入向量", async () => {
    const db = new HyperforgeDB(dbName("tc-cancel-embed"));
    const { embedder, calls, release } = controllable({ gate: true });
    const store = new VectorStore(db, embedder);
    await store.init();
    const ac = new AbortController();
    const onTextReady = vi.fn(() => ({ status: "ready" as const, docId: "d" }));
    const run = runPipeline({ kind: "text", text: TEXT }, { signal: ac.signal, onStage: () => undefined, onTextReady, getStore: async () => ({ store }) });
    await vi.waitFor(() => expect(calls.length).toBe(1)); // embedding 已開始並卡住
    ac.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" }); // gate 還沒放行，已經取消成功
    expect(onTextReady).toHaveBeenCalledTimes(1);
    release(); // 底層 embedding 在背景完成……
    await new Promise((r) => setTimeout(r, 50));
    expect([await db.docs.count(), await db.chunks.count(), await db.vectors.count()]).toEqual([0, 0, 0]); // ……但取消後不會寫入
    db.close();
    await db.delete();
  });

  it("getStore（向量庫初始化）進行中取消 → 立即 AbortError", async () => {
    const ac = new AbortController();
    const run = runPipeline({ kind: "text", text: TEXT }, { signal: ac.signal, onStage: () => undefined, onTextReady: () => ({ status: "ready" as const }), getStore: () => new Promise(() => undefined) });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
  });

  it("raceAbort：已取消的 signal 立即 reject；取消後底層才失敗的錯誤不會變成 unhandled rejection", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(raceAbort(Promise.resolve(1), ac.signal)).rejects.toMatchObject({ name: "AbortError" });
    const ac2 = new AbortController();
    let reject!: (e: Error) => void;
    const work = new Promise<number>((_, r) => (reject = r));
    const raced = raceAbort(work, ac2.signal);
    ac2.abort();
    await expect(raced).rejects.toMatchObject({ name: "AbortError" });
    reject(new Error("late failure")); // 不應造成 unhandled rejection（否則 vitest 會讓測試失敗）
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe("embedding 失敗 / 不可用 / 文字未保存：文字不受影響，且不做不該做的事", () => {
  it("embedding 丟一般錯誤 → vectorStatus=failed，textStatus=ready（文字不 rollback）", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = new HyperforgeDB(dbName("tc-fail"));
    const store = new VectorStore(db, controllable({ fail: true }).embedder);
    await store.init();
    const out = await runPipeline({ kind: "text", text: TEXT }, { onStage: () => undefined, onTextReady: () => ({ status: "ready", docId: "d" }), getStore: async () => ({ store }) });
    errSpy.mockRestore();
    expect([out.textStatus, out.vectorStatus]).toEqual(["ready", "failed"]);
    db.close();
    await db.delete();
  });

  it("模型不可用（getStore 回 null + 原因）→ vectorStatus=unavailable，LINK 註記原因", async () => {
    const notes: string[] = [];
    const out = await runPipeline(
      { kind: "text", text: TEXT },
      { onStage: (id, p) => id === "LINK" && p.note && notes.push(p.note), onTextReady: () => ({ status: "ready", docId: "d" }), getStore: async () => ({ store: null, reason: "模型未安裝（測試）" }) },
    );
    expect([out.textStatus, out.vectorStatus]).toEqual(["ready", "unavailable"]);
    expect(notes.some((n) => /向量化略過：模型未安裝（測試）/.test(n) && /文字已保留/.test(n))).toBe(true);
  });

  it("getStore 自己丟錯 → vectorStatus=unavailable，不丟錯", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await runPipeline({ kind: "text", text: TEXT }, { onStage: () => undefined, onTextReady: () => ({ status: "ready" }), getStore: async () => Promise.reject(new Error("init exploded")) });
    errSpy.mockRestore();
    expect([out.textStatus, out.vectorStatus]).toEqual(["ready", "unavailable"]);
  });

  it("文字持久化失敗（persist_failed）→ 不做 embedding，連向量庫都不取得（避免只有衍生資料、沒有原文）", async () => {
    const getStore = vi.fn();
    const out = await runPipeline({ kind: "text", text: TEXT }, { onStage: () => undefined, onTextReady: () => ({ status: "persist_failed", note: "disk full" }), getStore });
    expect(getStore).not.toHaveBeenCalled();
    expect([out.textStatus, out.vectorStatus]).toEqual(["persist_failed", "unavailable"]);
  });

  it("onTextReady 自己丟錯 → 無法確認文字已保存，保守視為 persist_failed 且不做 embedding", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const getStore = vi.fn();
    const out = await runPipeline({ kind: "text", text: TEXT }, { onStage: () => undefined, onTextReady: () => Promise.reject(new Error("hook exploded")), getStore });
    errSpy.mockRestore();
    expect(getStore).not.toHaveBeenCalled();
    expect(out.textStatus).toBe("persist_failed");
  });

  it("向量已存在（duplicate）→ vectorStatus=indexed，不重複 embedding", async () => {
    const db = new HyperforgeDB(dbName("tc-dup"));
    const { embedder, calls } = controllable();
    const store = new VectorStore(db, embedder);
    await store.init();
    const hooks = { onStage: () => undefined, onTextReady: () => ({ status: "ready" as const, docId: "d" }), getStore: async () => ({ store }) };
    await runPipeline({ kind: "text", text: TEXT }, hooks);
    const first = calls.length;
    const again = await runPipeline({ kind: "text", text: TEXT }, hooks);
    expect(again.vectorStatus).toBe("indexed");
    expect(calls.length).toBe(first);
    db.close();
    await db.delete();
  });
});
