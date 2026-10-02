import { DIGEST_NOTE, MAX_SENTENCE_CHARS, MIN_SENTENCE_CHARS, representativeSentence, selectDiverse, type Digest, type DigestSentence } from "./digest";
import { escapeMarkdown } from "./markdown";
import { segmentsToText, type Segment } from "./segments";

/** 核心摘要：3 行 + 10 點 bullet。全部取自原文句子；不足時照實少給。內容以片段（Segment）表示，可被機器檢查。 */
export const SUMMARY_LINES = 3;
export const SUMMARY_BULLETS = 10;

export interface SummaryItem {
  segments: Segment[];
}

export interface SummaryBullet extends SummaryItem {
  concept: string;
}

export interface SummaryResult {
  lines: SummaryItem[];
  bullets: SummaryBullet[];
  /** 給使用者看的系統說明（資料不足、少給了多少…）。這不是內容，不屬於任何輸出項目的片段。 */
  notes: string[];
}

const quote = (s: DigestSentence): Segment => ({ kind: "quote", docId: s.docId, start: s.start, end: s.end, text: s.text });
const ref = (s: DigestSentence): Segment[] => [
  { kind: "frame", text: "（" },
  { kind: "ref", docId: s.docId, text: s.docName },
  { kind: "frame", text: "）" },
];

export function buildSummary(d: Digest): SummaryResult {
  const picked = selectDiverse(d, SUMMARY_LINES);
  const lines: SummaryItem[] = picked.map((s, i) => ({
    segments: [{ kind: "frame", text: `${i + 1}. ` }, quote(s), { kind: "frame", text: " " }, ...ref(s)],
  }));

  const used = new Set<DigestSentence>(picked);
  const bullets: SummaryBullet[] = [];
  for (const c of d.concepts) {
    if (bullets.length >= SUMMARY_BULLETS) break;
    // 優先用沒被「3 行」或其他 bullet 用過的句子；都用過了就允許重複使用同一句，但不編造
    const s = representativeSentence(d, c.id, used) ?? representativeSentence(d, c.id);
    if (!s) continue;
    used.add(s);
    bullets.push({
      concept: c.label,
      segments: [
        { kind: "frame", text: "- " },
        { kind: "term", text: c.label },
        ...(c.heuristic ? ([{ kind: "frame", text: "（人名 heuristic）" }] as Segment[]) : []),
        { kind: "frame", text: "：" },
        quote(s),
        { kind: "frame", text: " " },
        ...ref(s),
      ],
    });
  }

  const notes: string[] = [];
  if (!d.sentences.length) {
    notes.push(
      d.concepts.length
        ? `圖譜有 ${d.concepts.length} 個概念，但找不到長度適中（${MIN_SENTENCE_CHARS}–${MAX_SENTENCE_CHARS} 字元）且含概念的原文句子——內容可能沒有標點（整段過長）或句子太短，無法產生摘要。`
        : "沒有可引用的原文句子（內容太短、或沒有詞達到概念門檻），無法產生摘要。",
    );
  } else {
    if (lines.length < SUMMARY_LINES) notes.push(`只找到 ${lines.length} 句可用的原文，所以摘要少於 ${SUMMARY_LINES} 行（不湊數）。`);
    if (bullets.length < SUMMARY_BULLETS) notes.push(`只有 ${bullets.length} 個概念有可引用的原文，所以 bullet 少於 ${SUMMARY_BULLETS} 點（不湊數）。`);
  }
  return { lines, bullets, notes };
}

const bold = (t: string) => `**${t}**`;

export function summaryToMarkdown(r: SummaryResult): string {
  const out: string[] = ["# 核心摘要", "", `> ${DIGEST_NOTE}`, ""];
  if (!r.lines.length && !r.bullets.length) {
    out.push(...r.notes.map((n) => `- ${n}`));
    return out.join("\n") + "\n";
  }
  out.push("## 三行摘要", "", ...r.lines.map((l) => segmentsToText(l.segments, { escape: escapeMarkdown })));
  out.push("", "## 十個重點", "", ...r.bullets.map((b) => segmentsToText(b.segments, { term: bold, escape: escapeMarkdown })));
  if (r.notes.length) out.push("", "## 說明", "", ...r.notes.map((n) => `- ${n}`));
  return out.join("\n") + "\n";
}

/** 所有「內容」片段（供測試與 UI 共用） */
export function summarySegments(r: SummaryResult): Segment[][] {
  return [...r.lines.map((l) => l.segments), ...r.bullets.map((b) => b.segments)];
}
