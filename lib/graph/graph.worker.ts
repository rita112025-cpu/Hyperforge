import { createGraphHost, type GraphResponse } from "./graph-protocol";

/**
 * 圖譜 Worker：chunk 切分 → 概念擷取 → 建圖全部在這裡，主執行緒只收訊息。
 * 薄殼：邏輯都在 createGraphHost（有單元測試），與 embed.worker.ts 相同的模式。
 */
const scope = self as unknown as {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(message: GraphResponse): void;
};
const host = createGraphHost((m) => scope.postMessage(m), { now: () => performance.now() });

scope.onmessage = (e) => host.onMessage(e.data);
