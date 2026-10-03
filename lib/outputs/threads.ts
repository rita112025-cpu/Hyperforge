import { selectDiverse, type Digest, type DigestSentence } from "./digest";
import { segmentsToText, type Segment } from "./segments";

/**
 * Threads 貼文草稿。沒有 AI，所以三種都是「版型」，不是語氣風格：
 *   professional（專業）  條列重點引文（• 開頭）
 *   dense（密排）          短句換行密排：把引文依子句標點（，；、）拆成一行一個子句，只靠標點與換行排版
 *   chain（串接）          依文件名稱、同文件內依原文位置，把引文串接成一段（先後是內部排序，不是上傳順序；各句原本不一定相鄰）
 * 規格原本寫「專業 / 嗆辣 / 故事」。「嗆辣」需要新增斗氣的斷言、「故事」需要捏造情節或第一人稱經驗，
 * 在不造事實的前提下做不到，所以改成上面三種誠實版型（使用者已同意，見 README）。
 *
 * 每則 ≤ 500 字元（Threads 上限）、最多 3 則。**一律以「整句」為進出單位**：一句放不下（含頁碼與來源行）就整句略過並記入 notes；
 * 3 則上限也只收整句，不會停在句子中途。內容只有 quote 與白名單框架。
 * 複製 / 下載給 Threads 是「純文字」（不是 Markdown），所以不做 Markdown 跳脫；UI 會說明。
 */
export type ThreadsLayout = "professional" | "dense" | "chain";

export const THREADS_LAYOUTS: ReadonlyArray<{ id: ThreadsLayout; label: string; description: string }> = [
  { id: "professional", label: "專業（條列）", description: "把重點引文條列成 • 項目" },
  { id: "dense", label: "密排（短句換行）", description: "引文依子句標點拆成一行一個子句；只靠標點與換行排版，不增加任何文字" },
  { id: "chain", label: "串接（依文件與原文位置）", description: "依文件名稱排序、同一文件內依原文位置，把引文串接成一段。文件之間的先後是內部排序，不是上傳順序；串接的各句引文原本不一定相鄰，彼此的指代（他、這個、上述）可能對不上" },
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

/** 進出單位 = 「整句」。密排只是把一句重新排版成多行（子句各自一行），不會把一句拆開放進不同貼文，也不會丟掉其中某個子句。 */
type Unit = { segs: Segment[]; doc: { id: string; name: string } };

function unitFor(layout: ThreadsLayout, s: DigestSentence): Unit {
  const doc = { id: s.docId, name: s.docName };
  if (layout === "professional") return { segs: [f("• "), q(s)], doc };
  if (layout === "chain") return { segs: [q(s)], doc };
  // dense：同一句的各子句各佔一行（子句之間以換行排版；每行仍是 rawText 的逐字子切片）
  const parts = clauseSlices(s);
  return { segs: parts.flatMap(([a, b], i) => (i ? [f("\n"), q(s, a, b)] : [q(s, a, b)])), doc };
}

/** 串接版型的排序：先依文件名稱（內部排序，不是上傳順序），同一文件內依原文位置 */
const byNameThenPosition = (a: DigestSentence, b: DigestSentence) =>
  a.docName < b.docName ? -1 : a.docName > b.docName ? 1 : a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : a.start - b.start;

export function buildThreads(d: Digest, layout: ThreadsLayout): ThreadsResult {
  let sentences = selectDiverse(d, CANDIDATES);
  if (layout === "chain") sentences = [...sentences].sort(byNameThenPosition);
  const units = sentences.map((s) => unitFor(layout, s));
  const sep: Segment = layout === "chain" ? f(" ") : f("\n");
  const notes: string[] = [];

  // 貪婪裝箱（整句為單位）：每則 = 內容 + 來源行；加上「(i/n)」頁碼後也不得超過上限
  const posts: Array<{ units: Unit[] }> = [];
  let cur: Unit[] = [];
  const footerOf = (us: Unit[]): Segment[] => {
    const docs = [...new Map(us.map((u) => [u.doc.id, u.doc])).values()].slice(0, 2);
    return [f("\n\n"), f("來源："), ...docs.flatMap((doc, i) => [...(i ? [f("、")] : []), { kind: "ref", docId: doc.id, text: doc.name } as Segment])];
  };
  const bodyOf = (us: Unit[]): Segment[] => us.flatMap((u, i) => (i ? [sep, ...u.segs] : u.segs));
  const fits = (us: Unit[]) => len([f("(1/3)"), f("\n"), ...bodyOf(us), ...footerOf(us)]) <= THREADS_MAX_CHARS;
  let dropped = 0;
  let overflow = 0;
  for (const u of units) {
    if (!fits([u])) {
      dropped++; // 整句（含頁碼與來源行）就放不下：整句略過，不截斷、不只丟其中某個子句
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
  for (const p of posts.slice(THREADS_MAX_POSTS)) overflow += p.units.length;
  if (overflow) notes.push(`超過 ${THREADS_MAX_POSTS} 則上限，另有 ${overflow} 個整句未收入（只收整句，不會停在句子中途）。`);
  if (dropped) notes.push(`有 ${dropped} 個整句因為單獨就超過 ${THREADS_MAX_CHARS} 字元（含頁碼與來源）而整句略過（不截斷引文，也不只丟其中某個子句）。`);
  const total = kept.length;
  const out: Segment[][] = kept.map((p, i) => [f(`(${i + 1}/${total})`), f("\n"), ...bodyOf(p.units), ...footerOf(p.units)]);
  if (!out.length) notes.push("沒有可引用的原文句子，無法產生貼文。");
  return { layout, posts: out, notes };
}

/** 純文字（給 Threads 貼上用，不做 Markdown 跳脫）。多則之間以空行與分隔線隔開。 */
export function threadsToText(r: ThreadsResult): string {
  return r.posts.map((p) => segmentsToText(p)).join("\n\n---\n\n") + (r.posts.length ? "\n" : "");
}
