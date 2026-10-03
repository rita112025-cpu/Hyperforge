import { chunkText, tokenize, type Chunk } from "./chunker";
import type { IngestSource } from "./types";

export type Report = (progress: number, note?: string) => void;

const TEXT_EXT = /\.(md|txt|json|csv|html?|xml|ya?ml|toml|ini|log|[jt]sx?|py|go|rs|java|c|h|cpp|hpp|cs|rb|php|sh|sql|css|scss|vue|svelte)$/i;

export function isTextLike(file: { name: string; type: string }): boolean {
  return file.type.startsWith("text/") || TEXT_EXT.test(file.name);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

/** PARSE：文字檔以 stream 分段讀取（不整檔 arrayBuffer），回報真實 byte 進度。 */
export async function parse(
  source: IngestSource,
  report: Report,
  signal?: AbortSignal,
): Promise<{ name: string; rawText: string }> {
  if (source.kind === "text") {
    report(1);
    return { name: "貼上文字", rawText: source.text };
  }
  if (source.kind === "url") {
    // 本輪不發任何網路請求（CORS／新增網路呼叫）；僅辨識類型，視為尚未支援。
    throw new Error(`尚未支援：${source.subtype} 連結（本輪不發網路請求）`);
  }
  const { file } = source;
  if (!isTextLike(file)) {
    throw new Error(`尚未支援：${file.type || file.name.split(".").pop() || "binary"}（本輪僅支援文字類檔案）`);
  }
  if (file.size === 0) {
    report(1, "空檔案");
    return { name: file.name, rawText: "" };
  }
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let text = "";
  let read = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      text += decoder.decode(value, { stream: true });
      report(Math.min(1, read / file.size));
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  text += decoder.decode();
  report(1);
  return { name: file.name, rawText: text };
}

/** 切 chunk 的實作：預設同步（純函式 chunkText）；產品路徑可注入 Worker 版（lib/pipeline/deconstruct-client.ts）。 */
export type Chunker = (rawText: string, signal?: AbortSignal) => Promise<Chunk[]>;

/** DECONSTRUCT：切 chunk（純函式 chunkText，保留 rawText 位移），讓出主執行緒並回報進度。 */
export async function deconstruct(rawText: string, report: Report, signal?: AbortSignal, chunker?: Chunker): Promise<Chunk[]> {
  throwIfAborted(signal);
  const chunks = chunker ? await chunker(rawText, signal) : chunkText(rawText);
  // chunkText 是同步純函式，無逐塊進度；完成後一次回報 100%
  report(1, `${chunks.length} chunks（token 為近似值）`);
  await new Promise((r) => setTimeout(r, 0));
  throwIfAborted(signal);
  return chunks;
}

const STOP = new Set("the a an and or of to in is are was were be for on with as by at it this that from not but".split(" "));

/** LINK：以詞頻抽關鍵字（簡化版；實體/情感/時間線後續輪次）。 */
export async function link(chunks: Chunk[], report: Report, signal?: AbortSignal): Promise<string[]> {
  const freq = new Map<string, number>();
  for (let i = 0; i < chunks.length; i++) {
    throwIfAborted(signal);
    for (const t of tokenize(chunks[i].text.toLowerCase())) {
      if (t.length < 2 || STOP.has(t)) continue;
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
    report((i + 1) / chunks.length);
    if (i % 20 === 19) await new Promise((r) => setTimeout(r, 0));
  }
  report(1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([w]) => w);
}
