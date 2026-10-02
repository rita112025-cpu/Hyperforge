import { handleMessage, postResponse } from "./embed-protocol";
import { TransformersEmbedder } from "./transformers-embedder";

/**
 * Embedding Worker：模型載入、切窗、推論、mean pooling 全部在這裡，主執行緒不被佔用。
 * 薄殼：邏輯都在 handleMessage / TransformersEmbedder（有單元測試）。
 * 注意：不在這裡 import dom lib 以外的東西；wasm / 模型路徑都是絕對路徑（/ort/、/models/），Worker 內同樣可用。
 */
const scope = self as unknown as {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
};
const engine = new TransformersEmbedder();

scope.onmessage = (e) => {
  void handleMessage(engine, e.data).then(({ response, transfer }) => postResponse((m, t) => scope.postMessage(m, t), response, transfer));
};
