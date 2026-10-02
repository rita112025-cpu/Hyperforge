/** 純函式，與 DOM 無關。token 為「近似值」：CJK 每字一個、其餘以空白分詞，並非 MiniLM 真 tokenizer。 */
export interface Chunk {
  index: number;
  /** rawText.slice(start, end)，保留原始空白/換行/標點 */
  text: string;
  /** rawText 的字元位移 [start, end) */
  start: number;
  end: number;
  /** 近似 token 數（非精確） */
  tokenCount: number;
}

export interface Span {
  start: number;
  end: number;
}

export const CHUNK_TOKENS = 500;
export const CHUNK_OVERLAP = 50;

const TOKEN_RE = /[㐀-鿿豈-﫿]|[^\s㐀-鿿豈-﫿]+/g;

export function tokenSpans(text: string): Span[] {
  return Array.from(text.matchAll(TOKEN_RE), (m) => ({ start: m.index!, end: m.index! + m[0].length }));
}

export function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

/** 以 size 個 token 為一塊、相鄰塊重疊 overlap 個 token。空輸入回傳 []。 */
export function chunkText(text: string, size = CHUNK_TOKENS, overlap = CHUNK_OVERLAP): Chunk[] {
  if (size <= 0 || overlap < 0 || overlap >= size) throw new RangeError("invalid chunk size/overlap");
  const spans = tokenSpans(text);
  const step = size - overlap;
  const chunks: Chunk[] = [];
  for (let first = 0; first < spans.length; first += step) {
    const last = Math.min(first + size, spans.length) - 1;
    const start = spans[first].start;
    const end = spans[last].end;
    chunks.push({ index: chunks.length, text: text.slice(start, end), start, end, tokenCount: last - first + 1 });
    if (first + size >= spans.length) break;
  }
  return chunks;
}

/** chunkText 會產生的塊數（供進度分母使用）。n = token 數。 */
export function chunkCount(n: number, size = CHUNK_TOKENS, overlap = CHUNK_OVERLAP): number {
  if (n <= 0) return 0;
  if (n <= size) return 1;
  return 1 + Math.ceil((n - size) / (size - overlap));
}
