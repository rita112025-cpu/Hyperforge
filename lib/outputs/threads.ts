import { selectDiverse, type Digest, type DigestSentence } from "./digest";
import { segmentsToText, type Segment } from "./segments";

/**
 * Threads 貼文草稿。沒有 AI，所以三種都是「版型」，不是語氣風格：
 *   professional（專業）  條列重點引文（• 開頭）
 *   dense（密排）          短句換行密排：把引文依子句標點（，；、）拆成一行一個子句，只靠標點與換行排版
 *   chain（串接）          依文件順序把引文串接成一段
 * 規格原本寫「專業 / 嗆辣 / 故事」。「嗆辣」需要新增斗氣的斷言、「故事」需要捏造情節或第一人稱經驗，
 * 在不造事實的前提下做不到，所以改成上面三種誠實版型（使用者已同意，見 README）。
 *
 * 每則 ≤ 500 字元（Threads 上限）、最多 3 則。內容只有 quote 與白名單框架。
 * 複製 / 下載給 Threads 是「純文字」（不是 Markdown），所以不做 Markdown 跳脫；UI 會說明。
 */
export type ThreadsLayout = "professional" | "dense" | "chain";

export const THREADS_LAYOUTS: ReadonlyArray<{ id: ThreadsLayout; label: string; description: string }> = [
  { id: "professional", label: "專業（條列）", description: "把重點引文條列成 • 項目" },
  { id: "dense", label: "密排（短句換行）", description: "引文依子句標點拆成一行一個子句；只靠標點與換行排版，不增加任何文字" },
  { id: "chain", label: "串接（依文件順序）", description: "依文件順序把引文串接成一段" },
];

export const THREADS_MAX_CHARS = 500;
export const THREADS_MAX_POSTS = 3;
const CANDIDATES = 14;

export interface ThreadsResult {
  layout: ThreadsLayout;
  posts: Segment[][];
  notes: string[];
}

const f = (text: string): Segment => ({ kind: "frame", text });
const len = (segs: readonly Segment[]) => Array.from(segmentsToText(segs)).length;
const q = (s: DigestSentence, start = s.start, end = s.end): Segment => ({ kind: "quote", docId: s.docId, start, end, text: s.text.slice(start - s.start, end - s.start) });

/** 把句子依子句標點拆成「原文子切片」（標點留在前一個子句尾端）；每一片仍是 rawText 的逐字切片 */
export function clauseSlices(s: DigestSentence): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let from = 0;
  const re = /[，,；;、]/g;
  for (let m = re.exec(s.text); m; m = re.exec(s.text)) {
    const end = m.index + 1;
    if (s.text.slice(from, end).trim()) out.push([from, end]);
    from = end;
  }
  if (from < s.text.length && s.text.slice(from).trim()) out.push([from, s.text.length]);
  return out.map(([a, b]) => {
    const raw = s.text.slice(a, b);
    const lead = raw.length - raw.trimStart().length;
    return [s.start + a + lead, s.start + b - (raw.length - raw.trimEnd().length)] as [number, number];
  });
}

type Unit = { segs: Segment[]; doc: { id: string; name: string } };

function unitsFor(layout: ThreadsLayout, sentences: DigestSentence[]): Unit[] {
  if (layout === "professional") return sentences.map((s) => ({ segs: [f("• "), q(s)], doc: { id: s.docId, name: s.docName } }));
  if (layout === "chain") return sentences.map((s) => ({ segs: [q(s)], doc: { id: s.docId, name: s.docName } }));
  // dense：一行一個子句
  return sentences.flatMap((s) => clauseSlices(s).map(([a, b]) => ({ segs: [q(s, a, b)], doc: { id: s.docId, name: s.docName } })));
}

export function buildThreads(d: Digest, layout: ThreadsLayout): ThreadsResult {
  let sentences = selectDiverse(d, CANDIDATES);
  if (layout === "chain") sentences = [...sentences].sort((a, b) => (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : a.start - b.start)); // 依文件順序
  const units = unitsFor(layout, sentences);
  const sep: Segment = layout === "chain" ? f(" ") : f("\n");
  const notes: string[] = [];

  // 貪婪裝箱：每則 = 內容 + 來源行；加上「(i/n)」頁碼後也不得超過上限（先保留頁碼與來源行的空間）
  const posts: Array<{ units: Unit[] }> = [];
  let cur: Unit[] = [];
  const footerOf = (us: Unit[]): Segment[] => {
    const docs = [...new Map(us.map((u) => [u.doc.id, u.doc])).values()].slice(0, 2);
    return [f("\n\n"), f("來源："), ...docs.flatMap((doc, i) => [...(i ? [f("、")] : []), { kind: "ref", docId: doc.id, text: doc.name } as Segment])];
  };
  const bodyOf = (us: Unit[]): Segment[] => us.flatMap((u, i) => (i ? [sep, ...u.segs] : u.segs));
  const fits = (us: Unit[]) => len([f("(1/3)"), f("\n"), ...bodyOf(us), ...footerOf(us)]) <= THREADS_MAX_CHARS;
  let dropped = 0;
  for (const u of units) {
    if (!fits([u])) {
      dropped++; // 單一單位（加上頁碼與來源行）就超過上限：不截斷引文，直接略過
      continue;
    }
    if (fits([...cur, u])) cur.push(u);
    else {
      posts.push({ units: cur });
      cur = [u];
    }
  }
  if (cur.length) posts.push({ units: cur });

  const kept = posts.slice(0, THREADS_MAX_POSTS);
  if (posts.length > THREADS_MAX_POSTS) notes.push(`內容超過 ${THREADS_MAX_POSTS} 則，其餘引文未收入。`);
  if (dropped) notes.push(`有 ${dropped} 個單位因為單獨就超過 ${THREADS_MAX_CHARS} 字元（含頁碼與來源）而略過（不截斷引文）。`);
  const total = kept.length;
  const out: Segment[][] = kept.map((p, i) => [f(`(${i + 1}/${total})`), f("\n"), ...bodyOf(p.units), ...footerOf(p.units)]);
  if (!out.length) notes.push("沒有可引用的原文句子，無法產生貼文。");
  return { layout, posts: out, notes };
}

/** 純文字（給 Threads 貼上用，不做 Markdown 跳脫）。多則之間以空行與分隔線隔開。 */
export function threadsToText(r: ThreadsResult): string {
  return r.posts.map((p) => segmentsToText(p)).join("\n\n---\n\n") + (r.posts.length ? "\n" : "");
}
