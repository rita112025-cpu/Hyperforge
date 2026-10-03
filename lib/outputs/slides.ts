import { DIGEST_NOTE, representativeSentence, selectDiverse, type Digest, type DigestSentence } from "./digest";
import { escapeMarkdown } from "./markdown";
import { segmentsToText, type Segment } from "./segments";

/**
 * 簡報大綱（最多 10 頁，含講稿）。每一頁都由片段（Segment）組成，可被機器檢查：
 *   標題 = 固定頁面角色（封面 / 重點概念 / 概念關聯）或一個 term；不是模板寫的結論。
 *   條列 = term、ref、或原文 quote。講稿 = 只由 quote（附文件名）組成。
 * 頁數不足 10 頁就照實少給並在 notes 說明，不湊數。
 */
export const SLIDE_COUNT = 10;
export const SLIDE_CONCEPT_PAGES = 7;

export interface Slide {
  title: Segment[];
  bullets: Segment[][];
  /** 講稿：每行是一句引文 */
  notes: Segment[][];
}

export interface SlidesResult {
  slides: Slide[];
  /** 系統說明（不屬於內容） */
  notes: string[];
}

const f = (text: string): Segment => ({ kind: "frame", text });
const quoteLine = (s: DigestSentence): Segment[] => [
  { kind: "quote", docId: s.docId, start: s.start, end: s.end, text: s.text },
  f(" "),
  f("（"),
  { kind: "ref", docId: s.docId, text: s.docName },
  f("）"),
];

export function buildSlides(d: Digest): SlidesResult {
  const slides: Slide[] = [];
  if (!d.concepts.length) return { slides, notes: ["沒有概念可用，無法產生簡報大綱。"] };

  // 1. 封面：來源文件清單；講稿 = 兩句多樣性最高的引文
  slides.push({
    title: [f("封面")],
    bullets: d.docs.slice(0, 5).map((doc) => [f("- "), { kind: "ref", docId: doc.id, text: doc.name } as Segment]),
    notes: selectDiverse(d, 2).map(quoteLine),
  });

  // 2. 重點概念：前 6 個概念（term）
  slides.push({
    title: [f("重點概念")],
    bullets: d.concepts.slice(0, 6).map((c) => [f("- "), { kind: "term", text: c.label } as Segment]),
    notes: selectDiverse(d, 3).map(quoteLine),
  });

  // 3–9. 每個重點概念一頁（只收有可引用句子的概念）：條列 ≤2 句，講稿 ≤3 句
  let conceptPages = 0;
  for (const c of d.concepts) {
    if (conceptPages >= SLIDE_CONCEPT_PAGES) break;
    const used = new Set<DigestSentence>();
    for (let i = 0; i < 3; i++) {
      const s = representativeSentence(d, c.id, used);
      if (!s) break;
      used.add(s);
    }
    const picked = [...used];
    if (!picked.length) continue;
    slides.push({
      title: [{ kind: "term", text: c.label }, ...(c.heuristic ? [f("（人名 heuristic）")] : [])],
      bullets: picked.slice(0, 2).map((s) => [f("- "), ...quoteLine(s)]),
      notes: picked.map(quoteLine),
    });
    conceptPages++;
  }

  // 10. 概念關聯：共現最多的概念對；講稿 = 同一句裡同時含兩者的引文（沒有就不給）
  const edges = d.topEdges.slice(0, 5);
  if (edges.length) {
    slides.push({
      title: [f("概念關聯")],
      bullets: edges.map((e) => [f("- "), { kind: "term", text: e.a.label }, f(" × "), { kind: "term", text: e.b.label }, f(`（共現 ${e.weight} 次）`)] as Segment[]),
      notes: edges.flatMap((e) => {
        const s = d.sentences.find((x) => x.conceptIds.includes(e.a.id) && x.conceptIds.includes(e.b.id));
        return s ? [quoteLine(s)] : [];
      }),
    });
  }

  const notes: string[] = [];
  if (slides.length < SLIDE_COUNT) notes.push(`只能產生 ${slides.length} 頁（不足 ${SLIDE_COUNT} 頁，照實少給，不湊數）。`);
  return { slides: slides.slice(0, SLIDE_COUNT), notes };
}

/** 所有「內容行」片段（標題行、條列、講稿），供驗證與 Markdown 共用 */
export function slideLines(r: SlidesResult): Segment[][] {
  return r.slides.flatMap((s, i) => [[f(`## 第 ${i + 1} 頁：`), ...s.title], ...s.bullets, ...(s.notes.length ? [[f("講稿：")]] : []), ...s.notes.map((n) => [f("- "), ...n])]);
}

export function slidesToMarkdown(r: SlidesResult): string {
  const out: string[] = ["# 簡報大綱", "", `> ${DIGEST_NOTE}`, ""];
  if (!r.slides.length) {
    out.push(...r.notes.map((n) => `- ${n}`));
    return out.join("\n") + "\n";
  }
  r.slides.forEach((s, i) => {
    out.push(segmentsToText([f(`## 第 ${i + 1} 頁：`), ...s.title], { escape: escapeMarkdown }), "");
    for (const b of s.bullets) out.push(segmentsToText(b, { escape: escapeMarkdown }));
    if (s.notes.length) {
      out.push("", "講稿：");
      for (const n of s.notes) out.push(segmentsToText([f("- "), ...n], { escape: escapeMarkdown }));
    }
    out.push("");
  });
  if (r.notes.length) out.push("## 說明", "", ...r.notes.map((n) => `- ${n}`));
  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}
