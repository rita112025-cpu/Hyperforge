/** 向量化介面。批次 async API：之後換成 Web Worker 實作時呼叫端不必改。 */
export interface Embedder {
  /** 模型識別（寫入 DB meta；不同模型的向量不可混用） */
  readonly id: string;
  readonly dim: number;
  /** 模型檔是否可用（例如尚未自託管）。不可用時呼叫端應略過，而不是用假向量代替。 */
  isAvailable(): Promise<boolean>;
  embed(texts: string[]): Promise<Float32Array[]>;
}
