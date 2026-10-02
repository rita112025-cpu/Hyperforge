/**
 * 主執行緒 ↔ embedding Worker 的訊息協定（純型別 + 純函式，不依賴 DOM / Worker，Node 測試可直接用）。
 * Worker 一次只處理一個 request（由主執行緒的 WorkerEmbedder 序列化）。
 */
export interface EmbedRequest {
  id: number;
  type: "embed";
  texts: string[];
}

export type EmbedResponse =
  | { id: number; ok: true; vectors: Float32Array[] }
  | { id: number; ok: false; error: string };

/** Worker 內實際做推論的物件（TransformersEmbedder 符合這個形狀） */
export interface EmbedEngine {
  embed(texts: string[]): Promise<Float32Array[]>;
}

export function isEmbedRequest(m: unknown): m is EmbedRequest {
  if (typeof m !== "object" || m === null) return false;
  const r = m as Record<string, unknown>;
  return r.type === "embed" && typeof r.id === "number" && Array.isArray(r.texts) && r.texts.every((t) => typeof t === "string");
}

/**
 * 讓每個向量擁有自己的 ArrayBuffer（才能安全地以 transferable 傳回），並蒐集要 transfer 的 buffer。
 * transfer list 不可含重複的 buffer（會丟 DataCloneError）：同一個 Float32Array 實例出現多次、
 * 或多個向量共用同一塊 buffer 時，後出現的會被複製成獨立的 buffer。
 */
export function toTransferable(vectors: Float32Array[]): { vectors: Float32Array[]; transfer: ArrayBuffer[] } {
  const seen = new Set<ArrayBufferLike>();
  const out = vectors.map((v) => {
    const own = v.byteOffset === 0 && v.byteLength === v.buffer.byteLength && v.buffer instanceof ArrayBuffer && !seen.has(v.buffer);
    const result = own ? v : new Float32Array(v);
    seen.add(result.buffer);
    return result;
  });
  return { vectors: out, transfer: out.map((v) => v.buffer as ArrayBuffer) };
}

/** 處理一個訊息：任何錯誤都包成 { ok:false }，不會丟出（Worker 不能因一次推論失敗而死掉）。 */
export async function handleMessage(engine: EmbedEngine, msg: unknown): Promise<{ response: EmbedResponse; transfer: ArrayBuffer[] }> {
  const id = typeof (msg as { id?: unknown } | null)?.id === "number" ? (msg as { id: number }).id : -1;
  if (!isEmbedRequest(msg)) return { response: { id, ok: false, error: "無效的 embed 請求" }, transfer: [] };
  try {
    const { vectors, transfer } = toTransferable(await engine.embed(msg.texts));
    return { response: { id: msg.id, ok: true, vectors }, transfer };
  } catch (e) {
    return { response: { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) }, transfer: [] };
  }
}

/**
 * 回傳結果給主執行緒。postMessage 可能丟 DataCloneError 等例外；若不處理，Worker 內會是未處理的 promise rejection，
 * 主執行緒收不到 onerror，該請求會永遠懸著。所以失敗時改回傳 {ok:false}（沒有 transfer），讓請求能以錯誤結束。
 * 連錯誤回覆都送不出去時（例如 Worker 已被終止）就放棄，不再丟出。
 */
export function postResponse(post: (message: unknown, transfer: ArrayBuffer[]) => void, response: EmbedResponse, transfer: ArrayBuffer[]): void {
  try {
    post(response, transfer);
  } catch (e) {
    try {
      post({ id: response.id, ok: false, error: `無法回傳結果：${e instanceof Error ? e.message : String(e)}` } satisfies EmbedResponse, []);
    } catch {
      /* 無法再回覆：由主執行緒的取消 / 終止處理 */
    }
  }
}
