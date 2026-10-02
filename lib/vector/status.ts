import { checkModelFiles } from "./model-files";

/** 向量 / 語意功能的狀態（與畫布無關：畫布只依賴文字，不需要向量）。 */
export type VectorStatus =
  | { state: "AVAILABLE"; detail: string }
  | { state: "UNAVAILABLE"; detail: string };

/**
 * 探測模型檔是否存在。只做同源 HEAD，不建立 embedder、不載入模型。
 * 供畫布狀態列顯示「語意 / 向量功能」可用性；畫布本身不等待它，也不因它失敗而變空。
 */
export async function probeVectorStatus(fetchFn?: typeof fetch): Promise<VectorStatus> {
  const r = await checkModelFiles(undefined, fetchFn, { stopAtFirstMissing: true }); // 缺模型時只發 1 個請求
  if (r.available) return { state: "AVAILABLE", detail: "模型檔存在" };
  const why = r.error ? `無法檢查模型檔：${r.error}` : "模型檔未安裝（請執行 npm run fetch-model）";
  return { state: "UNAVAILABLE", detail: why };
}
