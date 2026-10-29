import { buildGraph } from "./build";
import { buildDigest, type Digest } from "../outputs/digest";
import type { GraphDocument, GraphModel } from "./types";

/** 圖譜 Worker 的訊息協定（主執行緒一次只送一個 request，FIFO 由 graph-client 負責） */
export type GraphAnalysis = { graph: GraphModel; digest: Digest | null };
export type GraphRequest = { id: number; docs: GraphDocument[]; includeDigest?: boolean };
export type GraphResponse =
  | { id: number; ok: true; graph: GraphModel; digest?: Digest | null; durationMs: number }
  | { id: number; ok: false; error: string };

export function handleGraphRequest(req: GraphRequest, now: () => number = () => Date.now()): GraphResponse {
  const t0 = now();
  try {
    const graph = buildGraph(req.docs);
    const digest = req.includeDigest && graph.nodes.length > 0 ? buildDigest(req.docs, graph) : null;
    return { id: req.id, ok: true, graph, digest, durationMs: now() - t0 };
  } catch (e) {
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

type WorkerScope = {
  onmessage: ((e: { data: GraphRequest }) => void) | null;
  postMessage(message: GraphResponse): void;
};

// 只在 Worker 環境掛 handler（測試 / SSR import 此檔時沒有 self 或不是 Worker）
const g = globalThis as unknown as Partial<WorkerScope> & { WorkerGlobalScope?: unknown; document?: unknown };
if (g.WorkerGlobalScope !== undefined && g.document === undefined) {
  const scope = g as unknown as WorkerScope;
  scope.onmessage = (e) => scope.postMessage(handleGraphRequest(e.data, () => performance.now()));
}
