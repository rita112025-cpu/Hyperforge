"use client";
import { create } from "zustand";
import { contentIdOf, docFromJobResult, saveDocument } from "./graph/corpus";
import type { GraphDocument } from "./graph/types";
import { getVectorStore } from "./vector/runtime";
import { getSharedDb } from "./vector/shared-db";
import { initialStages, runPipeline } from "./pipeline/runner";
import type { IngestContext, IngestJob, IngestSource } from "./pipeline/types";

// 本輪僅 pipeline 狀態一個 slice（Yjs 等之後輪次再加）。模組層不碰 window。
interface PipelineSlice {
  jobs: IngestJob[];
  /**
   * 圖譜的「即時來源」：已完成 job 的記憶體結果（文字 + chunk 位移）。畫布直接使用，不需要再讀 DB，
   * 也與 embedding 成敗無關。只在 job 完成時追加一次（不是每個 progress 事件）。
   */
  docs: GraphDocument[];
  ingest: (source: IngestSource) => Promise<void>;
  cancel: (id: string) => void;
}

const controllers = new Map<string, AbortController>();
let seq = 0;

function sourceName(s: IngestSource): string {
  if (s.kind === "file") return s.file.name;
  if (s.kind === "url") return s.url;
  return "貼上文字";
}

/** 文字持久化（best-effort）：失敗不影響畫布，但結果會如實記在 job 上。 */
async function persistText(context: IngestContext): Promise<NonNullable<IngestJob["persist"]>> {
  try {
    const saved = await saveDocument(getSharedDb(), context);
    if (!saved) return { ok: false, note: "未寫入 IndexedDB（沒有內容，或環境不支援 crypto.subtle）" };
    return { ok: true, note: saved.created ? "文字已存入 IndexedDB（重新整理後畫布可由此重建）" : "文字已存在於 IndexedDB" };
  } catch (e) {
    return { ok: false, note: `文字未能存入 IndexedDB：${e instanceof Error ? e.message : String(e)}（本次內容仍顯示在畫布，重新整理後會消失）` };
  }
}

export const useForge = create<PipelineSlice>((set) => ({
  jobs: [],
  docs: [],
  cancel: (id) => controllers.get(id)?.abort(),
  ingest: async (source) => {
    const id = `job-${Date.now()}-${seq++}`;
    const ac = new AbortController();
    controllers.set(id, ac);
    const patchJob = (fn: (j: IngestJob) => IngestJob) =>
      set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? fn(j) : j)) }));

    set((s) => ({
      jobs: [{ id, name: sourceName(source), stages: initialStages(), status: "running" }, ...s.jobs],
    }));
    try {
      const { store, reason } = await getVectorStore();
      const context = await runPipeline(source, {
        signal: ac.signal,
        store: store ?? undefined,
        storeUnavailableReason: reason,
        onStage: (stageId, patch) =>
          patchJob((j) => ({ ...j, stages: j.stages.map((st) => (st.id === stageId ? { ...st, ...patch } : st)) })),
      });

      // 1) 即時來源：記憶體結果直接進圖譜（先於持久化，畫布不等 IndexedDB）
      if (context.chunks.length > 0) {
        const { id: contentId } = await contentIdOf(context.rawText);
        const doc = docFromJobResult(context, contentId);
        set((s) => (s.docs.some((d) => d.id === contentId) ? s : { docs: [...s.docs, doc] }));
      }
      // 2) 文字持久化（與向量化無關）
      const persist = await persistText(context);

      patchJob((j) => ({
        ...j,
        status: j.stages.some((st) => st.status === "skipped") || !context.indexed ? "partial" : "done",
        context,
        persist,
      }));
    } catch (e) {
      const cancelled = e instanceof DOMException && e.name === "AbortError";
      patchJob((j) => ({
        ...j,
        status: cancelled ? "cancelled" : "error",
        error: cancelled ? undefined : e instanceof Error ? e.message : String(e),
      }));
    } finally {
      controllers.delete(id);
    }
  },
}));
