import { selectDiverse, type Digest, type DigestSentence } from "./digest";
import type { Segment } from "./segments";

/**
 * 金句卡（1080×1080）。內容只有「原文引文行 + 來源文件名」，加上固定的 HyperForge 浮水印（品牌字樣，不是內容）。
 * - 選句：只挑「較短」的高分句。字太長時**不靠截斷或改寫引文**，而是改挑較短的句子；沒有就如實說明不產生。
 * - 換行：純函式、注入 measure（Node 可測）。CJK 沒有空白 → 逐字量測；英文依空白斷行，超長詞逐字斷。
 *   避頭尾：行首不得是 ，。、；：？！）」』】》… , . ; : ? ! ) ] }；行尾不得是 （「『【《 ( [。違反時把前一行最後一字移到下一行，
 *   不改變引文內容。
 * - 字級從大到小嘗試，直到行數與高度放得下；仍放不下就不產生（不截斷）。
 */
export const CARD_SIZE = 1080;
export const CARD_PADDING = 120;
export const CARD_TEXT_WIDTH = CARD_SIZE - CARD_PADDING * 2;
export const CARD_TEXT_TOP = 220;
export const CARD_TEXT_HEIGHT = 560;
export const CARD_FONT_SIZES = [72, 64, 56, 48, 44, 40] as const;
export const CARD_LINE_HEIGHT = 1.5;
export const CARD_MAX_CHARS = 48;
export const CARD_MIN_CHARS = 8;
export const CARD_MAX_CARDS = 3;
export const CARD_WATERMARK = "HyperForge";

export const NO_LINE_START: ReadonlySet<string> = new Set(Array.from("，。、；：？！）」』】》…,.;:?!)]}”’"));
export const NO_LINE_END: ReadonlySet<string> = new Set(Array.from("（「『【《([“‘"));

export type Measure = (text: string, fontPx: number) => number;

export interface LineSlice {
  /** 在引文內的 [start, end)（已去掉行尾空白） */
  start: number;
  end: number;
  text: string;
}

/** 成對不可拆的符號（連續兩個相同時不可被斷在中間） */
const PAIRED: ReadonlySet<string> = new Set(["…", "—", "─", "―"]);
const isWordChar = (ch: string) => /[A-Za-z0-9]/.test(ch);
/** 懸掛標點的上限（個） */
export const MAX_HANG = 1;
const isSpace = (ch: string) => /\s/.test(ch);
const isCjk = (ch: string) => /[⺀-鿿豈-﫿＀-￯　-〿]/.test(ch);

/** 是否可以在 i 之前斷行（i 是 chars 的索引）：CJK 字元之間、空白之後、CJK 與非 CJK 交界 */
function canBreakBefore(chars: string[], i: number): boolean {
  if (i <= 0 || i >= chars.length) return false;
  const prev = chars[i - 1];
  const cur = chars[i];
  if (isSpace(prev) || isSpace(cur)) return true;
  return isCjk(prev) || isCjk(cur);
}

/**
 * 把引文切成多行（回傳每行在引文中的位移切片）。行寬以 measure 量測；maxWidth 為像素。
 * 引文內容不會被改寫：每一行都是原文的逐字切片（只去掉斷行處的空白）。
 */
export function wrapText(text: string, maxWidth: number, fontPx: number, measure: Measure): LineSlice[] {
  const chars = Array.from(text); // 以字元（code point）為單位
  const offsets: number[] = [];
  let o = 0;
  for (const ch of chars) {
    offsets.push(o);
    o += ch.length;
  }
  offsets.push(o);
  const slice = (a: number, b: number) => chars.slice(a, b).join("");
  const width = (a: number, b: number) => measure(slice(a, b).trimEnd(), fontPx);

  const lines: LineSlice[] = [];
  let start = 0;
  while (start < chars.length) {
    while (start < chars.length && isSpace(chars[start]) && lines.length > 0) start++; // 行首不留斷行空白
    if (start >= chars.length) break;
    // 找最大的 end，使 [start, end) 放得下
    let end = start + 1;
    while (end < chars.length && width(start, end + 1) <= maxWidth) end++;
    // 標點懸掛：剛好放不下的行首禁則標點（，。、）」…）最多 1 個，掛在行尾超出行寬（最大字級 72px 時只超出 72px，仍在 120px 邊界與 40px 外框內），
    // 比把它擠到下一行行首、或把前面的英文單字拆開好
    for (let h = 0; h < MAX_HANG && end < chars.length && NO_LINE_START.has(chars[end]); h++) end++;
    if (end < chars.length) {
      // 退到最近的可斷點；找不到（超長詞）就在 end 強制斷
      let p = end;
      while (p > start + 1 && !canBreakBefore(chars, p)) p--;
      if (canBreakBefore(chars, p) && p > start) end = p;
      // 避頭尾（以 code point 為單位）：行首不得是 NO_LINE_START（連續標點如「。」」會一路往回搬到整串都在下一行）、
      // 行尾不得是 NO_LINE_END、成對不可拆的符號（……、——）不可被斷開。搬下去的字讓下一行變長時，下一輪迴圈會重新量測與換行。
      for (let guard = 0; guard < 8 && end - start > 1; guard++) {
        const prev = chars[end - 1];
        const cur = chars[end];
        if (NO_LINE_START.has(cur)) end--;
        else if (NO_LINE_END.has(prev)) end--;
        else if (cur === prev && PAIRED.has(cur)) end--;
        else break;
      }
      // 英文單字與數字串不可拆：搬字後若落在單字中間，整個單字一起搬到下一行
      if (end - start > 1 && isWordChar(chars[end - 1]) && isWordChar(chars[end])) {
        let w = end - 1;
        while (w > start && isWordChar(chars[w - 1])) w--;
        if (w > start) end = w; // 單字比整行還長（w === start）時才逐字強制斷
      }
    }
    let lineEnd = end;
    while (lineEnd > start + 1 && isSpace(chars[lineEnd - 1])) lineEnd--;
    lines.push({ start: offsets[start], end: offsets[lineEnd], text: slice(start, lineEnd) });
    start = end;
  }
  return lines;
}

export interface FitResult {
  fontPx: number;
  lines: LineSlice[];
}

/** 從大到小試字級，回傳第一個「行數與高度都放得下」的版面；全部放不下回傳原因（不截斷引文）。 */
export function fitCard(text: string, measure: Measure): { ok: true; fit: FitResult } | { ok: false; reason: string } {
  for (const fontPx of CARD_FONT_SIZES) {
    const lines = wrapText(text, CARD_TEXT_WIDTH, fontPx, measure);
    if (lines.length * fontPx * CARD_LINE_HEIGHT <= CARD_TEXT_HEIGHT) return { ok: true, fit: { fontPx, lines } };
  }
  return { ok: false, reason: `引文在最小字級（${CARD_FONT_SIZES[CARD_FONT_SIZES.length - 1]}px）下仍放不進 ${CARD_SIZE}×${CARD_SIZE} 的版面；不截斷引文，改挑較短的句子。` };
}

export interface CardSpec {
  sentence: DigestSentence;
  fontPx: number;
  lines: LineSlice[];
  /** 內容片段（每行一個 quote + 來源）。供驗證；浮水印不是內容 */
  segments: Segment[];
}

export interface CardsResult {
  cards: CardSpec[];
  notes: string[];
}

/** 候選句：長度在範圍內的高分句（字太長不截斷，直接不選） */
export function cardCandidates(d: Digest): DigestSentence[] {
  return d.sentences.filter((s) => {
    const n = Array.from(s.text).length;
    return n >= CARD_MIN_CHARS && n <= CARD_MAX_CHARS && !hasBidi(s.text);
  });
}

export function buildCards(d: Digest, measure: Measure): CardsResult {
  const pool = cardCandidates(d);
  const notes: string[] = [];
  // 含雙向控制字元的引文不選為候選（不改動引文），並在說明中計數
  const bidiSkipped = d.sentences.filter((s) => {
    const n = Array.from(s.text).length;
    return n >= CARD_MIN_CHARS && n <= CARD_MAX_CHARS && hasBidi(s.text);
  }).length;
  if (bidiSkipped) notes.push(`有 ${bidiSkipped} 個句子含雙向控制字元（會讓畫出的文字反向或錯位），未選為金句候選（不改動引文）。`);
  if (!pool.length) {
    notes.unshift(`沒有長度在 ${CARD_MIN_CHARS}–${CARD_MAX_CHARS} 個字元（code point）之間的原文句子，所以不產生金句卡（不截斷或改寫較長的句子；英文 48 字元大約只有 8 個單字）。`);
    return { cards: [], notes };
  }
  const picked = selectDiverse({ ...d, sentences: pool }, CARD_MAX_CARDS + 3); // 多挑幾個，放不下的略過
  const cards: CardSpec[] = [];
  let skipped = 0;
  for (const s of picked) {
    if (cards.length >= CARD_MAX_CARDS) break;
    const r = fitCard(s.text, measure);
    if (!r.ok) {
      skipped++;
      continue;
    }
    cards.push({
      sentence: s,
      fontPx: r.fit.fontPx,
      lines: r.fit.lines,
      segments: [
        ...r.fit.lines.map((l): Segment => ({ kind: "quote", docId: s.docId, start: s.start + l.start, end: s.start + l.end, text: l.text })),
        { kind: "frame", text: "（" },
        { kind: "ref", docId: s.docId, text: s.docName },
        { kind: "frame", text: "）" },
      ],
    });
  }
  if (skipped) notes.push(`有 ${skipped} 個句子在最小字級下仍放不下，已略過（不截斷引文）。`);
  if (cards.length < CARD_MAX_CARDS && cards.length) notes.push(`只有 ${cards.length} 張（不足 ${CARD_MAX_CARDS} 張，照實少給）。`);
  if (!cards.length) notes.push("沒有任何句子能放進卡片，所以不產生金句卡。");
  return { cards, notes };
}

/** 替代文字：用「整句原文」，不是把各行串起來（英文在空白處換行時行尾空白已去掉，串起來會變成 withthe） */
export const cardAltText = (card: CardSpec): string => `${card.sentence.text}（${card.sentence.docName}）`;

// ───────────── 繪製（Canvas 2D；使用者原文只用 fillText，不經 HTML） ─────────────

export const CARD_FONT_FAMILY = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", "Heiti TC", system-ui, sans-serif';

/** renderCard 用到的 CanvasRenderingContext2D 子集（讓測試可用記錄型 mock） */
export interface CardCtx {
  font: string;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): { addColorStop(offset: number, color: string): void };
}

/** 引文使用的字型字串。**量測與繪製必須用同一個**（否則量出來的行寬與實際畫出來的不一致）。 */
export const cardFont = (px: number, family = CARD_FONT_FAMILY) => `600 ${px}px ${family}`;

export function measureWith(ctx: Pick<CardCtx, "font" | "measureText">, family = CARD_FONT_FAMILY): Measure {
  return (text, px) => {
    ctx.font = cardFont(px, family);
    return ctx.measureText(text).width;
  };
}

/** 雙向控制字元（會讓畫出來的字視覺上反向或錯位） */
export const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩]/g;
export const stripBidi = (s: string) => s.replace(BIDI_CONTROLS, "");
/** 注意：BIDI_CONTROLS 有 g 旗標，不可直接 .test（lastIndex 有狀態）；用這個 */
export const hasBidi = (s: string) => new RegExp(BIDI_CONTROLS.source).test(s);

/** 標籤（文件名）過長時以量測結果截斷並加省略號——這是標籤不是引文，可以截。以 code point 為單位。 */
export function ellipsize(text: string, maxWidth: number, widthOf: (t: string) => number): string {
  if (widthOf(text) <= maxWidth) return text;
  const chars = Array.from(text);
  while (chars.length > 1 && widthOf(`${chars.join("")}…`) > maxWidth) chars.pop();
  return `${chars.join("")}…`;
}

/** 畫出一張卡。回傳實際用 fillText 畫出的字串（測試用）。 */
export function renderCard(ctx: CardCtx, card: CardSpec, family = CARD_FONT_FAMILY): string[] {
  const drawn: string[] = [];
  const text = (t: string, x: number, y: number) => {
    ctx.fillText(t, x, y);
    drawn.push(t);
  };
  ctx.fillStyle = "#09090b";
  ctx.fillRect(0, 0, CARD_SIZE, CARD_SIZE);
  const g = ctx.createLinearGradient(0, 0, CARD_SIZE, CARD_SIZE);
  g.addColorStop(0, "rgba(167,139,250,0.22)");
  g.addColorStop(1, "rgba(34,211,238,0.14)");
  ctx.fillStyle = g as unknown as string;
  ctx.fillRect(0, 0, CARD_SIZE, CARD_SIZE);
  ctx.strokeStyle = "rgba(167,139,250,0.55)";
  ctx.lineWidth = 4;
  ctx.strokeRect(40, 40, CARD_SIZE - 80, CARD_SIZE - 80);

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#e4e4e7";
  ctx.font = cardFont(card.fontPx, family);
  const lh = card.fontPx * CARD_LINE_HEIGHT;
  const blockH = card.lines.length * lh;
  const top = CARD_TEXT_TOP + Math.max(0, (CARD_TEXT_HEIGHT - blockH) / 2); // 垂直置中
  card.lines.forEach((l, i) => text(l.text, CARD_PADDING, top + i * lh));

  ctx.fillStyle = "#a1a1aa";
  ctx.font = `32px ${family}`;
  // 文件名也是使用者內容：移除雙向控制字元，過長就量測後截斷（標籤可以截，引文不行）
  const label = ellipsize(stripBidi(card.sentence.docName), CARD_TEXT_WIDTH, (t) => ctx.measureText(t).width);
  text(label, CARD_PADDING, CARD_SIZE - 170);
  ctx.fillStyle = "#a78bfa";
  ctx.font = `600 28px ${family}`;
  text(CARD_WATERMARK, CARD_PADDING, CARD_SIZE - 110);
  return drawn;
}
