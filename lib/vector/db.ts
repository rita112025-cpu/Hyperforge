import Dexie, { type Table } from "dexie";

export const SCHEMA_VERSION = 1;

export interface DocRow {
  /** 內容 SHA-256（hex）；重複拖入同一內容不會產生第二份 */
  id: string;
  name: string;
  createdAt: number;
  chunkCount: number;
  /** 原文，供「點節點回放原文出處」用 chunk.start/end 對回 */
  rawText: string;
}

export interface ChunkRow {
  /** `${docId}:${index}` 決定性主鍵 */
  id: string;
  docId: string;
  index: number;
  start: number;
  end: number;
  /** 文字不另存：= docs.rawText.slice(start, end) */
  tokenCount: number;
}

/** 向量獨立成表（主鍵 = chunkId），列 chunks 時不會連帶載入 384 維向量 */
export interface VectorRow {
  id: string;
  docId: string;
  vec: Float32Array;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

export interface EmbedMeta {
  model: string;
  dim: number;
}

/**
 * 注意：version(1) 一旦有使用者資料就不可修改；
 * 之後欄位變更請新增 version(2).stores(...).upgrade(...)。
 * 索引字串只列 id / docId，不得出現 vec。
 */
export class HyperforgeDB extends Dexie {
  docs!: Table<DocRow, string>;
  chunks!: Table<ChunkRow, string>;
  vectors!: Table<VectorRow, string>;
  meta!: Table<MetaRow, string>;

  constructor(name = "hyperforge") {
    super(name);
    this.version(1).stores({
      docs: "id",
      chunks: "id, docId",
      vectors: "id, docId",
      meta: "key",
    });
  }
}
