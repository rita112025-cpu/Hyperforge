import { chunkText } from "../pipeline/chunker";
import { buildDigest, type Digest } from "../outputs/digest";
import { assembleGraph, extractFromDocuments, prepareDocuments } from "./build";
import { contentIdOf, docFromJobResult } from "./corpus";
import type { GraphDocument, GraphModel } from "./types";

/**
 * 主執行緒 ↔ graph Worker 的訊息協定（純型別 + 純函式，不依賴 DOM / Worker，Node 測試可直接用）。
 * 每個 build 請求依序回傳：progress* → (graph | error) → done。done 是該 id 的最後一則訊息。
 */
export type GraphStage = "chunk" | "extract" | "build";

export type GraphRequest =
  | { type: "build"; id: number; docs: GraphDocument[]; includeDigest?: boolean }
  /** 原文直接送進 Worker：chunk 切分也在 Worker 內完成 */
  | { type: "build-text"; id: number; name: string; rawText: string }
  | { type: "abort"; id: number };

export type GraphStageTimings = Record<GraphStage, number>;

/** 工作區需要的分析結果：圖譜，以及（可選）在 Worker 內算好的摘要。 */
export interface GraphAnalysis {
  graph: GraphModel;
  digest: Digest | null;
}

export type GraphResponse =
  | { type: "progress"; id: number; stage: GraphStage; progress: number }
  | { type: "graph"; id: number; graph: GraphModel; digest: Digest | null; doc?: GraphDocument; durationMs: number; stageMs: GraphStageTimings }
  | { type: "error"; id: number; error: string; aborted: boolean }
  | { type: "done"; id: number };

type BuildRequest = Exclude<GraphRequest, { type: "abort" }>;

export function isGraphRequest(m: unknown): m is GraphRequest {
  if (typeof m !== "object" || m === null) return false;
  const r = m as Record<string, unknown>;
  if (typeof r.id !== "number") return false;
  if (r.type === "abort") return true;
  if (r.type === "build") return Array.isArray(r.docs);
  return r.type === "build-text" && typeof r.name === "string" && typeof r.rawText === "string";
}

export interface GraphHostDeps {
  now?: () => number;
  /** 讓出執行緒，使排隊中的 abort 訊息有機會被處理。預設 setTimeout(0)。 */
  yieldTask?: () => Promise<void>;
}

export interface GraphHost {
  onMessage(msg: unknown): void;
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/**
 * Worker 端：FIFO 佇列，一次執行一個 build；每個 build 有自己的 AbortController。
 * 取消只能在段與段之間生效（各段本身是同步純函式）；需要立即停止時，主執行緒會改為 terminate Worker。
 */
export function createGraphHost(post: (m: GraphResponse) => void, deps: GraphHostDeps = {}): GraphHost {
  const now = deps.now ?? (() => Date.now());
  const yieldTask = deps.yieldTask ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const queue: BuildRequest[] = [];
  let current: { id: number; controller: AbortController } | null = null;
  let draining = false;

  async function checkpoint(signal: AbortSignal) {
    await yieldTask();
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  }

  async function run(req: BuildRequest, signal: AbortSignal) {
    const t0 = now();
    const stageMs: GraphStageTimings = { chunk: 0, extract: 0, build: 0 };
    const progress = (stage: GraphStage, value: number) => post({ type: "progress", id: req.id, stage, progress: value });
    try {
      let docs: GraphDocument[];
      let doc: GraphDocument | undefined;
      if (req.type === "build-text") {
        progress("chunk", 0);
        const t = now();
        const chunks = chunkText(req.rawText);
        const { id } = await contentIdOf(req.rawText);
        doc = docFromJobResult({ name: req.name, rawText: req.rawText, chunks }, id);
        docs = [doc];
        stageMs.chunk = now() - t;
        progress("chunk", 1);
      } else {
        docs = req.docs;
      }
      await checkpoint(signal);

      progress("extract", 0);
      let t = now();
      const prepared = prepareDocuments(docs);
      const extraction = extractFromDocuments(prepared);
      stageMs.extract = now() - t;
      progress("extract", 1);
      await checkpoint(signal);

      progress("build", 0);
      t = now();
      const graph = assembleGraph(prepared, extraction);
      stageMs.build = now() - t;
      progress("build", 1);
      await checkpoint(signal);

      const digest = req.type === "build" && req.includeDigest && graph.nodes.length > 0 ? buildDigest(prepared, graph) : null;
      post({ type: "graph", id: req.id, graph, digest, doc, durationMs: now() - t0, stageMs });
    } catch (e) {
      post({ type: "error", id: req.id, error: e instanceof Error ? e.message : String(e), aborted: isAbort(e) });
    }
    post({ type: "done", id: req.id });
  }

  async function drain() {
    if (draining) return;
    draining = true;
    for (let req = queue.shift(); req; req = queue.shift()) {
      current = { id: req.id, controller: new AbortController() };
      await run(req, current.controller.signal);
      current = null;
    }
    draining = false;
  }

  return {
    onMessage(msg) {
      if (!isGraphRequest(msg)) {
        const id = typeof (msg as { id?: unknown } | null)?.id === "number" ? (msg as { id: number }).id : -1;
        post({ type: "error", id, error: "無效的 graph 請求", aborted: false });
        post({ type: "done", id });
        return;
      }
      if (msg.type === "abort") {
        if (current?.id === msg.id) {
          current.controller.abort();
          return;
        }
        const i = queue.findIndex((q) => q.id === msg.id);
        if (i >= 0) {
          queue.splice(i, 1);
          post({ type: "error", id: msg.id, error: "Aborted", aborted: true });
          post({ type: "done", id: msg.id });
        }
        return;
      }
      queue.push(msg);
      void drain();
    },
  };
}
