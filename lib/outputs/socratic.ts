import { DIGEST_NOTE, selectDiverse, type Digest, type DigestSentence } from "./digest";
import { escapeMarkdown } from "./markdown";
import { segmentsToText, type Segment } from "./segments";

/**
 * 反問提示（規則式，非論證）。**不是**「最強反駁」：沒有 AI，這裡只做一件事——
 * 在原文中找出帶有「強斷言線索」的句子，引用該句原文，並附上固定的問句框架（問句，不新增任何斷言）。
 * 強斷言線索是關鍵字比對，會有誤判；這是「規則式」的本質，UI 與 README 都會說明。
 * 找不到 3 個候選就給 1–2 個並標註；0 個就說沒有偵測到強斷言——不退而求其次造句。
 */
export const SOCRATIC_TITLE = "反問提示（規則式，非論證）";
export const SOCRATIC_MAX = 3;

export type CueKind = "universal" | "necessity" | "exclusive";

export interface Cue {
  cue: string;
  kind: CueKind;
}

/** 中文線索（含排除非斷言用法的否定前瞻，例如「一定程度」「不可能」） */
const ZH_CUES: ReadonlyArray<[RegExp, CueKind]> = [
  [/所有/, "universal"],
  [/全部/, "universal"],
  [/一律/, "universal"],
  [/永遠/, "universal"],
  [/絕對/, "universal"],
  [/必須/, "necessity"],
  [/一定(?!程度|範圍|數量|比例|時間|的)/, "necessity"],
  [/必定/, "necessity"],
  [/務必/, "necessity"],
  [/不得/, "necessity"],
  [/禁止/, "necessity"],
  [/不可(?!能|靠|見|否|思議|或缺)/, "necessity"],
  [/只有/, "exclusive"],
  [/唯一/, "exclusive"],
];
const EN_CUES: ReadonlyArray<[RegExp, CueKind]> = [
  [/\b(always|never|all|every|none)\b/i, "universal"],
  [/\b(must|cannot|shall not)\b/i, "necessity"],
  [/\bonly\b/i, "exclusive"],
];

/** 專有詞組：包含線索字但不是斷言（先把它們遮掉再找線索） */
export const EXCLUDED_PHRASES: readonly string[] = [
  "不可燃", "不可見", "不可抗力", "不可逆", "不得已",
  "所有權", "所有人", "所有者", "所有格",
  "唯一識別", "全部門", "全部分",
  // 含單字否定「不／未／無」但不是否定的常見詞（否則會被誤當否定而漏掉真正的強斷言）
  "不同", "未來", "無線", "無論",
];

/**
 * 否定／緩和語境：線索詞「前面」這個視窗內出現下列詞，就是在緩和斷言（並非所有、不是唯一、未必、not all、not only…），
 * 此時問「有例外嗎？」是錯的，所以不算強斷言。視窗：中文 6 個字元、英文 14 個字元（code point）。
 */
const NEGATION_ZH = ["並非", "不是", "未必", "不一定", "不見得", "並不", "不", "未", "沒有", "無"];
const NEGATION_EN = /\b(not|no|never|hardly|isn['’]t|aren['’]t|doesn['’]t|don['’]t|cannot only)\b|n['’]t\b/i;
const WINDOW_ZH = 6;
const WINDOW_EN = 14;

function mask(text: string): string {
  let t = text;
  for (const p of EXCLUDED_PHRASES) t = t.split(p).join("　".repeat(Array.from(p).length));
  return t;
}

function negatedBefore(chars: string[], index: number, cue: string): boolean {
  const isLatin = /^[a-z]/i.test(cue);
  const start = Math.max(0, index - (isLatin ? WINDOW_EN : WINDOW_ZH));
  const prefix = chars.slice(start, index).join("");
  if (isLatin) return NEGATION_EN.test(prefix);
  // 「不得」「不可」本身就含「不」：只看線索之前的字
  return NEGATION_ZH.some((n) => prefix.includes(n));
}

/**
 * 找出句子中的強斷言線索（不重複；依規則順序，同一規則的多個不同線索都會列出）。
 * 規則：先遮掉專有詞組；線索詞前的視窗內有否定／緩和詞則不算；英文 \b 比對、不分大小寫。
 * 決定：cannot、shall not、must 算強斷言；can't / don't / isn't 這類縮寫否定本身「不算」線索（它們是否定，不是全稱或必要）。
 */
export function findCues(text: string): Cue[] {
  const masked = mask(text);
  const chars = Array.from(masked);
  const out: Cue[] = [];
  const seen = new Set<string>();
  for (const [re, kind] of [...ZH_CUES, ...EN_CUES]) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of masked.matchAll(global)) {
      const cue = m[0].toLowerCase();
      const charIndex = Array.from(masked.slice(0, m.index)).length;
      if (negatedBefore(chars, charIndex, cue)) continue;
      if (seen.has(cue)) continue;
      seen.add(cue);
      out.push({ cue, kind });
    }
  }
  return out;
}

/**
 * 線索類別 → 問句（表格寫死；問句只來自白名單，**不拼接成新句子**）。
 * 一個項目最多兩個問句：取「優先序最高的類別」那一列（全稱 > 唯一 > 必要／禁止）。
 */
export const QUESTION_TABLE: Readonly<Record<CueKind, readonly string[]>> = {
  universal: ["這個說法有例外嗎？", "依據是什麼？"],
  exclusive: ["有沒有其他情況？"],
  necessity: ["依據是什麼？"],
};
const KIND_PRIORITY: readonly CueKind[] = ["universal", "exclusive", "necessity"];

export function questionsFor(cues: readonly Cue[]): string[] {
  const kinds = new Set(cues.map((c) => c.kind));
  const top = KIND_PRIORITY.find((k) => kinds.has(k));
  return top ? [...QUESTION_TABLE[top]] : [];
}

export interface SocraticItem {
  sentence: DigestSentence;
  cues: Cue[];
  /** 內容片段：每個元素是一行 */
  lines: Segment[][];
}

export interface SocraticResult {
  items: SocraticItem[];
  /** 系統說明（不屬於內容） */
  notes: string[];
}

const f = (text: string): Segment => ({ kind: "frame", text });

export function buildSocratic(d: Digest): SocraticResult {
  const pool = d.sentences.filter((s) => findCues(s.text).length > 0);
  const picked = selectDiverse({ ...d, sentences: pool }, SOCRATIC_MAX);
  const items: SocraticItem[] = picked.map((s, i) => {
    const cues = findCues(s.text);
    return {
      sentence: s,
      cues,
      lines: [
        [f(`${i + 1}. `), { kind: "quote", docId: s.docId, start: s.start, end: s.end, text: s.text }, f(" "), f("（"), { kind: "ref", docId: s.docId, text: s.docName }, f("）")],
        ...questionsFor(cues).map((q): Segment[] => [f("  - "), f(q)]),
      ],
    };
  });
  const notes: string[] = [];
  if (!items.length) notes.push("沒有偵測到強斷言（原文中沒有含「必須／一定／所有／只有／always／never／only…」這類線索的句子），所以不產生反問提示。");
  else if (items.length < SOCRATIC_MAX) notes.push(`只偵測到 ${items.length} 個含強斷言線索的句子，所以少於 ${SOCRATIC_MAX} 個（不湊數、不造句）。`);
  return { items, notes };
}

export const socraticLines = (r: SocraticResult): Segment[][] => r.items.flatMap((i) => i.lines);

export function socraticToMarkdown(r: SocraticResult): string {
  const out: string[] = [`# ${SOCRATIC_TITLE}`, "", `> ${DIGEST_NOTE}`, ""];
  if (!r.items.length) {
    out.push(...r.notes.map((n) => `- ${n}`));
    return out.join("\n") + "\n";
  }
  for (const item of r.items) out.push(...item.lines.map((l) => segmentsToText(l, { escape: escapeMarkdown })), "");
  if (r.notes.length) out.push("## 說明", "", ...r.notes.map((n) => `- ${n}`));
  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}
