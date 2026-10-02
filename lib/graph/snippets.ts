import { chunksOverlapping } from "./build";
import { MAX_SNIPPETS, SNIPPET_CONTEXT_CHARS } from "./constants";
import type { GraphDocument, NodeEvidence } from "./types";

/**
 * Source panel 的「原文」片段（純資料）。
 * 原文是使用者任意檔案的內容，所以這裡只回傳純字串（before / match / after）；
 * UI 層必須用 React text node 顯示，絕不可 innerHTML / dangerouslySetInnerHTML。
 */
export interface Snippet {
  docId: string;
  docName: string;
  chunkIndexes: number[];
  before: string;
  match: string;
  after: string;
  /** 前後是否被截斷（顯示 …） */
  cutBefore: boolean;
  cutAfter: boolean;
}

/** 避免把 surrogate pair 切成兩半 */
function safeStart(text: string, i: number): number {
  const c = text.charCodeAt(i);
  return i > 0 && c >= 0xdc00 && c <= 0xdfff ? i - 1 : i;
}
function safeEnd(text: string, i: number): number {
  const c = text.charCodeAt(i - 1);
  return i < text.length && c >= 0xd800 && c <= 0xdbff ? i + 1 : i;
}

export function buildSnippets(
  evidence: NodeEvidence | undefined,
  docs: ReadonlyMap<string, GraphDocument>,
  max = MAX_SNIPPETS,
  context = SNIPPET_CONTEXT_CHARS,
): Snippet[] {
  if (!evidence) return [];
  const out: Snippet[] = [];
  for (const o of evidence.occurrences) {
    if (out.length >= max) break;
    const doc = docs.get(o.docId);
    if (!doc || o.end > doc.rawText.length) continue;
    const from = safeStart(doc.rawText, Math.max(0, o.start - context));
    const to = safeEnd(doc.rawText, Math.min(doc.rawText.length, o.end + context));
    out.push({
      docId: doc.id,
      docName: doc.name,
      chunkIndexes: chunksOverlapping(doc.chunks, o.start, o.end),
      before: doc.rawText.slice(from, o.start),
      match: doc.rawText.slice(o.start, o.end),
      after: doc.rawText.slice(o.end, to),
      cutBefore: from > 0,
      cutAfter: to < doc.rawText.length,
    });
  }
  return out;
}
