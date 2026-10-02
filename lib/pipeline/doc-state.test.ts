import { describe, expect, it } from "vitest";
import { TEXT_LABEL, VECTOR_LABEL, canRetryIndexing, jobStatusFor, summarize } from "./doc-state";
import type { DocInfo, DocVectorState, TextStatus, VectorStatus } from "./types";

const TEXTS: TextStatus[] = ["pending", "ready", "persist_failed"];
const VECTORS: DocVectorState[] = ["pending", "building", "indexed", "failed", "cancelled", "unavailable"];

describe("canRetryIndexing：只對 文字已就緒 且 向量尚未完成（也不在建立中）的文件開放", () => {
  it("完整真值表", () => {
    for (const text of TEXTS) {
      for (const vector of VECTORS) {
        const expected = text === "ready" && vector !== "indexed" && vector !== "building";
        expect(canRetryIndexing({ text, vector }), `${text}/${vector}`).toBe(expected);
      }
    }
    expect(canRetryIndexing(undefined)).toBe(false);
  });
});

describe("jobStatusFor：job 狀態只由文字與向量決定（取消與錯誤由 store 設定，不會是 partial）", () => {
  it("只有 文字 ready 且 向量 indexed 才是 done；其餘（向量失敗 / 不可用 / 文字未保存）一律 partial", () => {
    const vectors: VectorStatus[] = ["pending", "indexed", "failed", "cancelled", "unavailable"];
    for (const text of TEXTS) {
      for (const vector of vectors) {
        expect(jobStatusFor(text, vector), `${text}/${vector}`).toBe(text === "ready" && vector === "indexed" ? "done" : "partial");
      }
    }
  });
});

describe("顯示文字", () => {
  it("取消後文字保留：摘要明確寫「文字已保留」，且不是錯誤措辭", () => {
    const s = summarize({ text: "ready", vector: "cancelled" });
    expect(s).toBe("文字：已就緒 · 語意索引：已取消（文字已保留）");
    expect(s).not.toMatch(/錯誤|失敗文件|ERROR/);
  });

  it("向量失敗 / 不可用：文字可用；文字未保存：明確警示重新整理後可能遺失", () => {
    expect(summarize({ text: "ready", vector: "failed" })).toBe("文字：已就緒 · 語意索引：失敗（文字已保留）");
    expect(summarize({ text: "ready", vector: "unavailable" })).toBe("文字：已就緒 · 語意索引：不可用（文字已保留）");
    expect(summarize({ text: "persist_failed", vector: "unavailable" })).toContain("尚未儲存，重新整理後可能遺失");
    expect(summarize({ text: "ready", vector: "building" })).toBe("文字：已就緒 · 語意索引：建立中");
  });

  it("每個狀態都有標籤", () => {
    for (const t of TEXTS) expect(TEXT_LABEL[t].length).toBeGreaterThan(0);
    for (const v of VECTORS) expect(VECTOR_LABEL[v].length).toBeGreaterThan(0);
  });
});

describe("DocInfo 型別", () => {
  it("可選欄位不影響判斷", () => {
    const info: DocInfo = { text: "ready", vector: "failed", vectorNote: "x", progress: 0.4 };
    expect(canRetryIndexing(info)).toBe(true);
  });
});
