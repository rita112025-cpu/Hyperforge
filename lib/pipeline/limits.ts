/**
 * embedding 在瀏覽器主執行緒執行（尚未改用 Web Worker），推論期間整個頁面會卡住。
 * 實測（多語言 MiniLM-L12 量化、WASM、numThreads=1）：每個 chunk 約切成 4–6 個視窗，每視窗約 0.2 秒；
 * 約 2,200 個近似 token（6 個 chunk）的文件熱機約 5 秒，0.6MB 單檔（約 290 個 chunk）會卡數分鐘。
 *
 * 所以超過這個 chunk 數的文件「只略過向量化」：文字仍保存、圖譜仍照常建立（文字處理很快）。
 * 以 chunk 數而不是位元組數為準，因為 chunk 數才決定推論量；20 個 chunk 約 50KB 英文或 27KB 中文，
 * 預期凍結約 15–25 秒（尚未用 Worker 前的折衷值，未在低階機器上量測）。
 */
export const MAX_EMBED_CHUNKS = 20;

export function embedLimitNote(chunkCount: number, limit: number = MAX_EMBED_CHUNKS): string {
  return `文件過大（${chunkCount} 個 chunk，上限 ${limit}）：略過語意索引以免頁面凍結；文字已保留、圖譜照常建立`;
}

export function exceedsEmbedLimit(chunkCount: number, limit: number = MAX_EMBED_CHUNKS): boolean {
  return chunkCount > limit;
}
