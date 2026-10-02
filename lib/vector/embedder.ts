/** 向量化介面。批次 async API（實作可以在主執行緒，也可以在 Web Worker）。 */
export interface EmbedOptions {
  /** 取消：實作應盡快 reject（AbortError），並盡可能停止運算（例如終止 Worker） */
  signal?: AbortSignal;
}

export interface Embedder {
  /** 模型識別（寫入 DB meta；不同模型的向量不可混用） */
  readonly id: string;
  readonly dim: number;
  /** 模型檔是否可用（例如尚未自託管）。不可用時呼叫端應略過，而不是用假向量代替。 */
  isAvailable(): Promise<boolean>;
  /** isAvailable() 回 false 時的原因（顯示給使用者）；沒有就用預設的「模型未安裝」。 */
  unavailableReason?(): string | undefined;
  embed(texts: string[], opts?: EmbedOptions): Promise<Float32Array[]>;
}
