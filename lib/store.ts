"use client";
import { create } from "zustand";
import { getVectorStore } from "./vector/runtime";
import { initialStages, runPipeline } from "./pipeline/runner";
import type { IngestJob, IngestSource } from "./pipeline/types";

// 本輪僅 pipeline 狀態一個 slice（Yjs 等之後輪次再加）。模組層不碰 window。
interface PipelineSlice {
  jobs: IngestJob[];
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

export const useForge = create<PipelineSlice>((set) => ({
  jobs: [],
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
      const store = (await getVectorStore()) ?? undefined;
      const context = await runPipeline(source, {
        signal: ac.signal,
        store,
        onStage: (stageId, patch) =>
          patchJob((j) => ({ ...j, stages: j.stages.map((st) => (st.id === stageId ? { ...st, ...patch } : st)) })),
      });
      patchJob((j) => ({
        ...j,
        status: j.stages.some((st) => st.status === "skipped") || !context.indexed ? "partial" : "done",
        context,
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
