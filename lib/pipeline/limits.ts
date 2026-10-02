/**
 * embedding 原本在瀏覽器主執行緒執行，推論期間整個頁面會卡住；現在已改在 Web Worker 執行（頁面不凍結、可取消），
 * 但 CPU 時間不變，所以這個上限現在是「運算時間保護」。是否移除或調高由使用者決定。
 * 以下是改用 Worker 之前的實測（保留作為推論成本的依據）：
 * 實測（多語言 MiniLM-L12 量化、WASM、numThreads=1）：每個 chunk 約切成 4–6 個視窗，每視窗約 0.2 秒；
 * 約 2,200 個近似 token（6 個 chunk）的文件熱機約 5 秒，0.6MB 單檔（約 290 個 chunk）會卡數分鐘。
 *
 * 所以超過這個 chunk 數的文件「只略過向量化」：文字仍保存、圖譜仍照常建立（文字處理很快）。
 * 以 chunk 數而不是位元組數為準，因為 chunk 數才決定推論量；20 個 chunk 約 50KB 英文或 27KB 中文，
 * 改用 Worker 後實測：剛好 20 個 chunk 約 30 秒（含載入模型約 2 秒）的背景運算，embedding 期間主執行緒
 * longtask（>50ms）只有 1 次、172ms（未在低階機器上量測；畫布 fps 在 hidden 分頁無法量測）。
 */
export const MAX_EMBED_CHUNKS = 20;

export function embedLimitNote(chunkCount: number, limit: number = MAX_EMBED_CHUNKS): string {
  return `文件過大（${chunkCount} 個 chunk，上限 ${limit}）：略過語意索引以控制運算時間；文字已保留、圖譜照常建立`;
}

export function exceedsEmbedLimit(chunkCount: number, limit: number = MAX_EMBED_CHUNKS): boolean {
  return chunkCount > limit;
}
