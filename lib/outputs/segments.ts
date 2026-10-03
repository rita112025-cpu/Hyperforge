/**
 * 「模板不得造事實」要能被機器檢查：每個輸出內部都先表示成片段（Segment）陣列，
 * 再由同一份片段產生 Markdown 與 UI，所以測試檢查片段就等於檢查使用者看到的內容。
 *
 *   quote  原文切片。text 必須逐字等於 rawText.slice(start, end)。
 *   term   圖譜上的概念名稱（由抽取得到，不是模板寫的）。必須出現在同一項目引用的原文裡，或至少出現在某份來源文件裡（不分大小寫）。
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
  // ── 階段 B：心智圖 / 簡報 / Threads。全是「命名輸出種類或頁面角色」、標點與連接符，不含對內容的斷言 ──
  "\n\n",
  "• ",
  "、",
  " × ", // 兩個概念之間的連接符（共現），不是因果或評價
  "# 心智圖",
  "# 簡報大綱",
  "封面",
  "重點概念",
  "概念關聯",
  "講稿：",
  "代表性引文：", // 封面與「重點概念」頁的講稿是全文多樣性最高的引文，不是摘要；用這個中性標籤標示
  "來源：",
  // ── 階段 C：反問提示。標題標籤與固定問句（問句不新增任何斷言）──
  "# 反問提示（規則式，非論證）",
  "這個說法有例外嗎？",
  "依據是什麼？",
  "有沒有其他情況？",
]);

/**
 * 含數字的框架（樣式比對）。**數字來自圖譜統計（共現次數、被隱藏的數量、頁碼、則數），不是原文，也不是模板的斷言**；
 * verifySegments 只檢查「樣式」，數字是否正確由各輸出的測試用獨立計算驗證。
 */
const FRAME_PATTERNS: readonly RegExp[] = [
  /^\d{1,3}\. $/, // 編號
  /^( {2}){0,3}- $/, // 縮排條列（心智圖最多 3 層）
  /^（還有 \d{1,4} 個未顯示）$/, // 深度或分支上限而略過的節點
  /^## 群組 \d{1,2}$/,
  /^## 第 \d{1,2} 頁：$/,
  /^（共現 \d{1,4} 次）$/, // 前提：共現次數是「同一句內共同出現的句子數」，必為整數；非整數時 slides 不顯示這個框架
  /^\(\d{1,2}\/\d{1,2}\)$/, // Threads 的 (1/3)
];

export function isAllowedFrame(text: string): boolean {
  return FRAME_WHITELIST.has(text) || FRAME_PATTERNS.some((p) => p.test(text));
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
  const allText = [...docs.values()].map((d) => d.rawText.toLowerCase());
  for (const s of segments) {
    if (s.kind !== "term") continue;
    const t = s.text.toLowerCase();
    // 同一項目引用的原文裡有它，或（標題 / 心智圖節點這類沒有引文的項目）至少出現在某份來源文件裡
    if (!quoteTexts.some((q) => q.includes(t)) && !allText.some((x) => x.includes(t))) problems.push(`term 未出現在原文中：${JSON.stringify(s.text)}`);
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
