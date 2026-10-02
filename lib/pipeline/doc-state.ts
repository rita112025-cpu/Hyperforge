import type { DocInfo, DocVectorState, JobStatus, TextStatus, VectorStatus } from "./types";

/** 純函式：狀態推導與顯示文字。UI 與 store 共用，避免各處各自判斷。 */

/** job 狀態只由「文字」與「向量」決定；取消與錯誤由 store 直接設定。 */
export function jobStatusFor(text: TextStatus, vector: VectorStatus): Extract<JobStatus, "done" | "partial"> {
  return text === "ready" && vector === "indexed" ? "done" : "partial";
}

/**
 * 明確的「重新建立索引」只對 文字已就緒 且 向量尚未完成（也不在建立中）的文件開放。
 * 不會重新 PARSE / DECONSTRUCT，也不會新增 document / chunks。
 * 超過 embedding 上限的文件（tooLarge）不開放：重試只會再次卡住頁面。
 */
export function canRetryIndexing(info: DocInfo | undefined): boolean {
  return !!info && info.text === "ready" && !info.tooLarge && info.vector !== "indexed" && info.vector !== "building";
}

export const TEXT_LABEL: Record<TextStatus, string> = {
  pending: "尚未就緒",
  ready: "已就緒",
  persist_failed: "尚未儲存，重新整理後可能遺失",
};

export const VECTOR_LABEL: Record<DocVectorState, string> = {
  pending: "尚未建立",
  building: "建立中",
  indexed: "已完成",
  failed: "失敗",
  cancelled: "已取消",
  unavailable: "不可用",
};

/** 一行摘要，例如「文字：已就緒 · 語意索引：已取消（文字已保留）」 */
export function summarize(info: DocInfo): string {
  const kept = info.text === "ready" && (info.vector === "cancelled" || info.vector === "failed" || info.vector === "unavailable") ? "（文字已保留）" : "";
  return `文字：${TEXT_LABEL[info.text]} · 語意索引：${VECTOR_LABEL[info.vector]}${kept}`;
}
