import { chunkText, type Chunk } from "./chunker";

/** DECONSTRUCT Worker 的訊息協定。Worker 與同步 fallback 共用 runDeconstruct，不複製演算法。 */
export interface DeconstructRequest {
  id: number;
  rawText: string;
}

export type DeconstructResponse =
  | { id: number; ok: true; chunks: Chunk[]; durationMs: number }
  | { id: number; ok: false; error: string };

/** 純函式核心（不依賴 DOM / window / IndexedDB）：Worker 與主執行緒 fallback 都呼叫它。 */
export function runDeconstruct(req: DeconstructRequest, now: () => number = () => Date.now()): DeconstructResponse {
  const t0 = now();
  try {
    return { id: req.id, ok: true, chunks: chunkText(req.rawText), durationMs: now() - t0 };
  } catch (e) {
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
