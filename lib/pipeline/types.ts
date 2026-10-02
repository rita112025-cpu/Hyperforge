import type { Chunk } from "./chunker";

export type { Chunk };

export type StageId = "PARSE" | "DECONSTRUCT" | "LINK" | "RECOMBINE" | "EVOLVE" | "MANIFEST";

export const STAGE_ORDER: StageId[] = ["PARSE", "DECONSTRUCT", "LINK", "RECOMBINE", "EVOLVE", "MANIFEST"];

export const STAGE_LABEL_ZH: Record<StageId, string> = {
  PARSE: "解析",
  DECONSTRUCT: "解構",
  LINK: "連結",
  RECOMBINE: "重組",
  EVOLVE: "演化",
  MANIFEST: "具現",
};

/** skipped = 尚未接入實作；進度條不動，不偽造進度 */
export type StageStatus = "idle" | "running" | "done" | "error" | "skipped" | "cancelled";

export interface StageState {
  id: StageId;
  status: StageStatus;
  /** 0..1，單調遞增 */
  progress: number;
  note?: string;
}

export type IngestSource =
  | { kind: "file"; file: File }
  | { kind: "url"; url: string; subtype: "youtube" | "github" | "web" }
  | { kind: "text"; text: string };

/**
 * 文字是 primary data，向量是 derived data。兩者各自有狀態，不要用單一 job 狀態承擔全部語意，
 * 也不要再加 isPartial / hasText / hasVectors 之類互相矛盾的 boolean。
 *
 * TextStatus
 *   pending        文字尚未 commit（PARSE / DECONSTRUCT 還沒完成，或被取消、或失敗）
 *   ready          文字（docs + chunks）已 commit：已持久化，且畫布可用
 *   persist_failed 文字已解析完成、已加入本次 session 的畫布，但寫入 IndexedDB 失敗（重新整理後會遺失）
 */
export type TextStatus = "pending" | "ready" | "persist_failed";

/**
 * VectorStatus（衍生資料；可失敗、可延後、可重試）
 *   pending      尚未建立（進行中，或重新整理後只知道「沒有向量」）
 *   indexed      向量已寫入
 *   failed       向量化過程出錯（非使用者原因、非模型缺失）
 *   cancelled    使用者取消了這次向量化
 *   unavailable  無法向量化：模型未安裝 / 向量庫無法使用 / 文字未保存而刻意不建立向量
 */
export type VectorStatus = "pending" | "indexed" | "failed" | "cancelled" | "unavailable";

/** 文件層級的向量狀態 = VectorStatus + 「建立中」（job 進行中，或使用者觸發的 retry 進行中） */
export type DocVectorState = VectorStatus | "building";

/** 單一文件目前的狀態（job 進行中、job 結束後、retry、以及重新整理後由 IndexedDB 推得，都統一在這裡） */
export interface DocInfo {
  text: TextStatus;
  vector: DocVectorState;
  textNote?: string;
  vectorNote?: string;
  /** retry 進行中的進度 0..1 */
  progress?: number;
  /** 文件超過 MAX_EMBED_CHUNKS：不建立語意索引，也不開放「重新建立索引」（重試只會再卡住頁面） */
  tooLarge?: boolean;
}

/** text commit point 交給 onTextReady 的內容：只有在 PARSE 成功且 DECONSTRUCT 完整產生 chunks 之後才會呼叫 */
export interface TextCommitPayload {
  name: string;
  rawText: string;
  chunks: Chunk[];
}

export interface TextCommitResult {
  status: Exclude<TextStatus, "pending">;
  /** 文件 id（內容 SHA-256） */
  docId?: string;
  note?: string;
}

export interface IngestContext {
  name: string;
  rawText: string;
  chunks: Chunk[];
  keywords: string[];
  /** 文件 id（內容 SHA-256）；有 text commit 或向量化時才有 */
  docId?: string;
  textStatus: TextStatus;
  /** runner 結束時的向量結果（取消會直接 throw AbortError，不會走到這裡） */
  vectorStatus: VectorStatus;
}

/**
 * job 狀態
 *   running    進行中
 *   done       文字已就緒 且 向量已建立（= 規格的 completed）
 *   partial    系統完成了文字處理，但「非使用者原因」導致附加能力沒完成（向量失敗 / 不可用 / 文字未能保存）
 *   cancelled  使用者主動取消。即使 text commit 之後才取消、文字已保留，仍是 cancelled，不是 partial
 *   error      文字處理本身失敗（PARSE / DECONSTRUCT 出錯）
 * RECOMBINE / EVOLVE / MANIFEST 尚未接入，只在各自的列上標示，不影響 job 狀態。
 */
export type JobStatus = "running" | "done" | "partial" | "error" | "cancelled";

export interface IngestJob {
  id: string;
  name: string;
  stages: StageState[];
  status: JobStatus;
  error?: string;
  context?: IngestContext;
  textStatus: TextStatus;
  vectorStatus: VectorStatus;
  textNote?: string;
  /** text commit 之後才有 */
  docId?: string;
}
