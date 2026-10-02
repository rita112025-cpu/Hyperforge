/**
 * 「模板不得造事實」要能被機器檢查：每個輸出內部都先表示成片段（Segment）陣列，
 * 再由同一份片段產生 Markdown 與 UI，所以測試檢查片段就等於檢查使用者看到的內容。
 *
 *   quote  原文切片。text 必須逐字等於 rawText.slice(start, end)。
 *   term   圖譜上的概念名稱（由抽取得到，不是模板寫的）。必須出現在同一項目引用的原文裡（不分大小寫）。
 *   ref    文件名稱（必須等於該文件的 name）。
 *   frame  模板框架。只允許白名單內的固定字串：標號、標點、標題、固定標籤。
 *          白名單內不得含任何對內容的判斷、對比、評價或斷言。
 */
import { DIGEST_NOTE } from "./digest";

export type Segment =
  | { kind: "quote"; docId: string; start: number; end: number; text: string }
  | { kind: "term"; text: string }
  | { kind: "ref"; docId: string; text: string }
  | { kind: "frame"; text: string };

/** 固定框架字串（精確比對）。新增輸出需要新框架時，必須加進這裡並通過審查。 */
export const FRAME_WHITELIST: ReadonlySet<string> = new Set([
  // 標點 / 空白 / 換行
  " ",
  "\n",
  "：",
  "（",
  "）",
  // 條列
  "- ",
  // 固定標題與標籤（只命名輸出種類，不含對內容的斷言）
  "# 核心摘要",
  "## 三行摘要",
  "## 十個重點",
  "## 說明",
  "（人名 heuristic）",
  `> ${DIGEST_NOTE}`,
]);

const NUMBERING = /^\d{1,3}\. $/;

export function isAllowedFrame(text: string): boolean {
  return FRAME_WHITELIST.has(text) || NUMBERING.test(text);
}

export interface SourceDoc {
  name: string;
  rawText: string;
}

/** 檢查一組片段（一個輸出項目）；回傳違規描述，空陣列 = 全部合格。 */
export function verifySegments(segments: readonly Segment[], docs: ReadonlyMap<string, SourceDoc>): string[] {
  const problems: string[] = [];
  const quoteTexts: string[] = [];
  for (const s of segments) {
    if (s.kind === "frame") {
      if (!isAllowedFrame(s.text)) problems.push(`frame 不在白名單：${JSON.stringify(s.text)}`);
    } else if (s.kind === "quote") {
      const doc = docs.get(s.docId);
      if (!doc) problems.push(`quote 找不到文件 ${s.docId}`);
      else if (doc.rawText.slice(s.start, s.end) !== s.text) problems.push(`quote 與原文切片不符：${JSON.stringify(s.text.slice(0, 30))}`);
      quoteTexts.push(s.text.toLowerCase());
    } else if (s.kind === "ref") {
      const doc = docs.get(s.docId);
      if (!doc || doc.name !== s.text) problems.push(`ref 與文件名稱不符：${JSON.stringify(s.text)}`);
    }
  }
  for (const s of segments) {
    if (s.kind === "term" && !quoteTexts.some((q) => q.includes(s.text.toLowerCase()))) problems.push(`term 未出現在引用的原文中：${JSON.stringify(s.text)}`);
  }
  return problems;
}

export interface TextOptions {
  /** term 的包裝（Markdown 用 **粗體**）；在 escape 之後套用 */
  term?: (text: string) => string;
  /** 對「使用者內容」（quote / term / ref）的跳脫。frame 是固定白名單，不跳脫。 */
  escape?: (text: string) => string;
}

/** 片段 → 純文字（Markdown / 複製 / 下載共用）。 */
export function segmentsToText(segments: readonly Segment[], opts: TextOptions = {}): string {
  const esc = opts.escape ?? ((t: string) => t);
  return segments
    .map((s) => {
      if (s.kind === "frame") return s.text;
      const t = esc(s.text);
      return s.kind === "term" && opts.term ? opts.term(t) : t;
    })
    .join("");
}
