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

export interface IngestContext {
  name: string;
  rawText: string;
  chunks: Chunk[];
  keywords: string[];
  /** 已寫入向量庫的文件 id；未向量化時為 undefined */
  docId?: string;
  /** false = 向量化被略過（例如模型未安裝），job 應視為 partial */
  indexed: boolean;
}

export interface IngestJob {
  id: string;
  name: string;
  stages: StageState[];
  /** partial = 已跑完，但有階段尚未接入（skipped） */
  status: "running" | "done" | "partial" | "error" | "cancelled";
  error?: string;
  context?: IngestContext;
}
