import { runDeconstruct, type DeconstructRequest, type DeconstructResponse } from "./deconstruct-core";

type WorkerScope = {
  onmessage: ((e: { data: DeconstructRequest }) => void) | null;
  postMessage(message: DeconstructResponse): void;
};

// 只在 Worker 環境掛 handler（測試 / SSR import 此檔時不動 globalThis）
const g = globalThis as unknown as Partial<WorkerScope> & { WorkerGlobalScope?: unknown; document?: unknown };
if (g.WorkerGlobalScope !== undefined && g.document === undefined) {
  const scope = g as unknown as WorkerScope;
  scope.onmessage = (e) => scope.postMessage(runDeconstruct(e.data, () => performance.now()));
}
