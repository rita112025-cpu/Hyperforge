/**
 * 概念抽取（純函式，不依賴 DOM / embedding / IndexedDB）。
 *
 * 【方法聲明】中文部分為「統計近似，非中文斷詞」：沒有詞典、沒有 NLP tokenizer、沒有 NER。
 * 只做：依 Unicode script / 標點 / stopword 切段 → 段內 2–3 字 n-gram 計數 →
 * 以「重複出現的片段覆蓋最多字」選詞 → 詞頻 / 文件頻率評分。
 * 已知會出錯的情況見 README「概念抽取限制」。
 *
 * 流程：
 *   句子切分 → 依 script 切 run（Latin token / Han run）
 *   Latin：token → stopword / 長度過濾
 *   Han：以標點（run 邊界）與 stopword 切段 → 2–3 字 n-gram 計數 → 覆蓋選詞（DP）
 *   英文人名：啟發式（連續 2–3 個首字大寫單字，或 Dr./Mr./Ms. + 姓），僅限英文
 *   → 證據門檻（詞頻、文件長度）→ score 排序
 *
 * 位移：不對全文做會改變長度的正規化；NFKC / 小寫只作用在單一詞的 key 上，
 * 因此 occurrence 的 start/end 一律是原文的 UTF-16 位移，可直接 slice 回放。
 */

export const EXTRACT_METHOD_NOTE = "統計近似，非中文斷詞";
export const PERSON_METHOD_NOTE = "英文啟發式（heuristic），非 NER、非 AI；不支援中文人名";

/** 詞需在整個語料中至少出現這麼多次才算概念（短文件、單次出現的詞不產生概念）。 */
export const MIN_TERM_FREQ = 2;
/** 文件至少要有這麼多「單位」（Han 字元數 + Latin token 數）才納入分析。 */
export const MIN_DOC_UNITS = 8;
const NGRAM_MIN = 2;
const NGRAM_MAX = 3;
/**
 * 3 字詞的凝聚度門檻：count(3 字) / max(count(前 2 字), count(後 2 字)) 需 ≥ 此值。
 * 意義：兩個 2 字半段在語料中至少有這個比例是出現在這個 3 字詞之內，否則視為跨詞界碎片（例如「槽保持」）。
 * 門檻值為經驗設定，未對大型語料校準。
 */
export const MIN_TRIGRAM_COHESION = 0.8;

export type ConceptKind = "concept" | "person";

export interface ExtractUnit {
  docId: string;
  text: string;
}

export interface TermOccurrence {
  /** `${kind}:${key}` */
  id: string;
  /** unit.text 內的 UTF-16 位移 [start, end) */
  start: number;
  end: number;
  /** unit 內的句子序號（co-occurrence 以句子為窗） */
  sentence: number;
}

export interface Concept {
  id: string;
  kind: ConceptKind;
  key: string;
  label: string;
  freq: number;
  docFreq: number;
  score: number;
}

export interface ExtractResult {
  /** 已通過證據門檻，依 score 由高到低（同分以 freq、key 決定，結果決定性） */
  concepts: Concept[];
  /** 與輸入 units 同序；只含通過門檻的概念 */
  occurrences: TermOccurrence[][];
  /** 因過短（< MIN_DOC_UNITS）而未分析的 unit 索引 */
  skippedUnits: number[];
}

// ───────────────────────── stopwords ─────────────────────────

/** 中文多字停用詞。以「切段」方式移除（詞本身與跨詞邊界的 n-gram 都不會產生）。 */
export const HAN_STOP_TERMS: readonly string[] = [
  "需要", "必須", "足夠", "位置", "之間", "不足", "可以", "可能", "能夠", "應該", "如果", "因為", "所以", "但是",
  "然後", "同時", "以及", "或者", "並且", "而且", "另外", "其中", "這個", "那個", "這些", "那些", "已經", "目前",
  "通過", "進行", "使用", "對於", "關於", "根據", "由於", "為了", "以下", "以上", "一個", "一些", "一種", "沒有",
  "不能", "無法", "如下", "我們", "你們", "他們", "她們", "它們", "自己", "什麼", "怎麼", "這樣", "那樣", "如此",
  "之後", "之前", "之中", "之上", "之下", "之內", "之外", "相關", "部分", "方面", "情況", "具有", "成為", "作為",
  "提供", "包括", "包含", "這種", "那種", "一定", "一般", "通常", "主要", "基本", "可是", "不過", "只是", "還是",
  "或是", "就是", "都是", "並不", "不會", "不要", "不是", "以便", "以免", "至於", "即使", "雖然", "儘管", "例如",
  "比如", "其他", "其餘", "某些", "某個", "每個", "各個", "各種", "任何", "所有", "全部", "有關", "的話", "時候",
  "避免", "適當",
];

/** 中文單字虛詞：只放「幾乎只當虛詞用」的字，避免切碎實詞。 */
export const HAN_STOP_CHARS: ReadonlySet<string> = new Set("的了與和及或並且而之於把被也都就是在有不為對其這那此該各每");

export const LATIN_STOPWORDS: ReadonlySet<string> = new Set(
  (
    "a about above after again against all also am an and any are as at be because been before being below between both but by can " +
    "could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it " +
    "its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the " +
    "their them then there these they this those through to too under until up very was we were what when where which while who whom " +
    "why will with would you your yours via per etc eg ie may might must shall use used using one two new get got let like make made " +
    "many much even still yet however therefore thus hence whether either neither since upon within without across among around"
  ).split(" "),
);

const STOP_BY_FIRST: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const t of [...HAN_STOP_TERMS].sort((a, b) => b.length - a.length)) {
    const list = m.get(t[0]) ?? [];
    list.push(t);
    m.set(t[0], list);
  }
  return m;
})();

// 人名啟發式的負面詞（句首虛詞、地名/機構常見首詞、月份、星期）。清單有限，會漏也會誤判。
const NON_NAME_FIRST: ReadonlySet<string> = new Set(
  (
    "The This That These Those A An In On At For And But Or If When While With Without After Before Our Your My His Her Its Their " +
    "We You They It He She There Here What Which Who How Why Where New Old United North South East West Machine Deep Artificial " +
    "Big Open Visual Node Java React Next Type Google Microsoft Apple Amazon Facebook Meta Open"
  ).split(" "),
);
const NON_NAME_ANY: ReadonlySet<string> = new Set(
  (
    "January February March April May June July August September October November December Monday Tuesday Wednesday Thursday " +
    "Friday Saturday Sunday University Institute Company Corporation Inc Ltd Learning Network Networks Database Databases " +
    "System Systems Engine Server Client Framework Library Language Model Models Studio Code Cloud Service Services"
  ).split(" "),
);

// ───────────────────────── scanning ─────────────────────────

interface Seg {
  text: string;
  start: number;
}
interface LatinTok {
  text: string;
  start: number;
  end: number;
}
interface PersonSpan {
  name: string;
  start: number;
  end: number;
}
interface SentenceScan {
  han: Seg[];
  latin: LatinTok[];
  persons: PersonSpan[];
}

const SENTENCE_END_CHARS = new Set(["。", "！", "？", "!", "?", "；", ";", "…", "\n", "\r"]);
const TITLE_BEFORE_DOT = /(?:^|[^A-Za-z])(?:Dr|Mr|Mrs|Ms|Prof|vs|etc|St|Jr|Sr|e\.g|i\.e)$/;

/** 句子邊界（回傳 [start, end) 區間，已略過純空白句）。"." 僅在後接空白/結尾、前非數字且非縮寫時視為句末。 */
export function splitSentences(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  const push = (end: number) => {
    if (end > start && text.slice(start, end).trim()) out.push([start, end]);
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (SENTENCE_END_CHARS.has(ch)) {
      push(i + 1);
    } else if (ch === ".") {
      const next = text[i + 1];
      const prev = text[i - 1];
      const atEnd = next === undefined || /\s/.test(next);
      if (atEnd && !(prev && /\d/.test(prev)) && !TITLE_BEFORE_DOT.test(text.slice(Math.max(0, i - 6), i))) push(i + 1);
    }
  }
  push(text.length);
  return out;
}

const TOKEN_RE = /(\p{Script=Han}+)|(\p{Script=Latin}[\p{Script=Latin}\p{N}]*(?:[-_][\p{Script=Latin}\p{N}]+)*)/gu;
const TITLED_RE = /\b(?:Dr|Mr|Mrs|Ms|Prof)\.?[ ]+([A-Z][a-z]+)\b/g;
const PERSON_RE = /\b(?:(?:Dr|Mr|Mrs|Ms|Prof)\.?[ ]+)?([A-Z][a-z]+(?:[ ][A-Z][a-z]+){1,2})\b/g;

function splitAtStops(run: string, base: number): Seg[] {
  const segs: Seg[] = [];
  let segStart = -1;
  const flush = (end: number) => {
    if (segStart >= 0 && end > segStart) segs.push({ text: run.slice(segStart, end), start: base + segStart });
    segStart = -1;
  };
  let i = 0;
  while (i < run.length) {
    const ch = run[i];
    let matched = 0;
    const terms = STOP_BY_FIRST.get(ch);
    if (terms) for (const t of terms) if (run.startsWith(t, i)) { matched = t.length; break; }
    if (matched) {
      flush(i);
      i += matched;
    } else if (HAN_STOP_CHARS.has(ch)) {
      flush(i);
      i += 1;
    } else {
      if (segStart < 0) segStart = i;
      i += 1;
    }
  }
  flush(run.length);
  return segs;
}

function detectPersons(sentence: string, base: number): PersonSpan[] {
  const spans: PersonSpan[] = [];
  const taken = (s: number, e: number) => spans.some((p) => s < p.end && p.start < e);
  for (const m of sentence.matchAll(TITLED_RE)) {
    const s = m.index!;
    const e = s + m[0].length;
    const name = m[1];
    if (NON_NAME_FIRST.has(name) || NON_NAME_ANY.has(name)) continue;
    spans.push({ name, start: base + s, end: base + e });
  }
  for (const m of sentence.matchAll(PERSON_RE)) {
    const s = m.index!;
    const e = s + m[0].length;
    if (taken(base + s, base + e)) continue;
    const words = m[1].split(" ");
    if (NON_NAME_FIRST.has(words[0]) || words.some((w) => NON_NAME_ANY.has(w))) continue;
    spans.push({ name: m[1], start: base + s, end: base + e });
  }
  return spans;
}

function scanSentence(text: string, base: number): SentenceScan {
  const persons = detectPersons(text, base);
  const han: Seg[] = [];
  const latin: LatinTok[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = base + m.index!;
    if (m[1] !== undefined) han.push(...splitAtStops(m[1], start));
    else if (!persons.some((p) => start >= p.start && start < p.end)) latin.push({ text: m[2], start, end: start + m[2].length });
  }
  return { han, latin, persons };
}

// ───────────────────────── Han n-gram cover ─────────────────────────

function distinctChars(cps: string[]): boolean {
  for (let i = 1; i < cps.length; i++) if (cps[i] !== cps[0]) return true;
  return false;
}

function countNgrams(segments: Seg[], into: Map<string, number>): void {
  for (const seg of segments) {
    const cps = Array.from(seg.text);
    for (let i = 0; i < cps.length; i++) {
      for (let n = NGRAM_MIN; n <= NGRAM_MAX && i + n <= cps.length; n++) {
        const gram = cps.slice(i, i + n);
        if (!distinctChars(gram)) continue;
        const key = gram.join("");
        into.set(key, (into.get(key) ?? 0) + 1);
      }
    }
  }
}

/**
 * 在單一 Han 段上選出「重複出現的 2–3 字片段」，目標是覆蓋最多字（其次是「頻次 × 長度」總和最大，
 * 其餘平手時偏好較長片段，結果決定性）。未被覆蓋的字不產生概念。
 * 這避免 n-gram 重疊爆量（電纜槽 不會同時產生 電纜、纜槽），也不會產生跨詞界碎片。
 */
function coverSegment(seg: Seg, counts: Map<string, number>): Array<{ term: string; start: number; end: number }> {
  const cps = Array.from(seg.text);
  const n = cps.length;
  if (n < NGRAM_MIN) return [];
  const off = new Array<number>(n + 1);
  let o = 0;
  for (let k = 0; k < n; k++) {
    off[k] = o;
    o += cps[k].length;
  }
  off[n] = o;

  const covered = new Array<number>(n + 1).fill(0);
  const sum = new Array<number>(n + 1).fill(0);
  const back = new Array<number>(n + 1).fill(0); // 0 = 略過該字；2/3 = 取該長度的片段
  for (let i = 1; i <= n; i++) {
    covered[i] = covered[i - 1];
    sum[i] = sum[i - 1];
    back[i] = 0;
    for (const len of [3, 2]) {
      if (i - len < 0) continue;
      const gram = cps.slice(i - len, i);
      if (!distinctChars(gram)) continue;
      const c = counts.get(gram.join("")) ?? 0;
      if (c < MIN_TERM_FREQ) continue;
      if (len === 3) {
        const half = Math.max(counts.get(gram.slice(0, 2).join("")) ?? 0, counts.get(gram.slice(1).join("")) ?? 0);
        if (c / half < MIN_TRIGRAM_COHESION) continue;
      }
      const cv = covered[i - len] + len;
      const sm = sum[i - len] + c * len; // 次要目標：頻次 × 長度加權的覆蓋量（偏好反覆出現的長片段，而非碎片）
      if (cv > covered[i] || (cv === covered[i] && sm > sum[i])) {
        covered[i] = cv;
        sum[i] = sm;
        back[i] = len;
      }
    }
  }
  const out: Array<{ term: string; start: number; end: number }> = [];
  for (let i = n; i > 0; ) {
    const len = back[i];
    if (len === 0) i -= 1;
    else {
      out.push({ term: cps.slice(i - len, i).join(""), start: seg.start + off[i - len], end: seg.start + off[i] });
      i -= len;
    }
  }
  return out.reverse();
}

// ───────────────────────── aggregation ─────────────────────────

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function normalizeKey(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

function latinEligible(raw: string, key: string): boolean {
  if (LATIN_STOPWORDS.has(key)) return false;
  if (!distinctChars(Array.from(key))) return false; // aaaa、xxx 這類單字重複
  if (key.length >= 3) return true;
  return key.length === 2 && raw === raw.toUpperCase() && /^\p{L}{2}$/u.test(raw); // AI、UX 這類全大寫縮寫
}

interface Agg {
  kind: ConceptKind;
  key: string;
  surfaces: Map<string, number>;
  freq: number;
  docs: Set<number>;
}

export function scoreOf(freq: number, docFreq: number): number {
  return (1 + Math.log(freq)) * (1 + Math.log(docFreq));
}

export function extractConcepts(units: ExtractUnit[]): ExtractResult {
  const skippedUnits: number[] = [];
  const scans: Array<{ unit: number; sentences: Array<{ range: [number, number]; scan: SentenceScan }> }> = [];

  // 1) 掃描：句子 → script run → Han 段 / Latin token / 人名
  units.forEach((u, unit) => {
    const sentences = splitSentences(u.text).map((range) => ({ range, scan: scanSentence(u.text.slice(range[0], range[1]), range[0]) }));
    let size = 0;
    for (const s of sentences) {
      for (const seg of s.scan.han) size += Array.from(seg.text).length;
      size += s.scan.latin.length + s.scan.persons.length;
    }
    if (size < MIN_DOC_UNITS) skippedUnits.push(unit);
    else scans.push({ unit, sentences });
  });

  // 2) Han n-gram 計數（跨所有納入分析的文件）
  const gramCounts = new Map<string, number>();
  for (const s of scans) for (const sent of s.sentences) countNgrams(sent.scan.han, gramCounts);

  // 3) 逐句收集 occurrence
  const aggs = new Map<string, Agg>();
  const raw: TermOccurrence[][] = units.map(() => []);
  const add = (unit: number, id: string, kind: ConceptKind, key: string, surface: string, start: number, end: number, sentence: number) => {
    let a = aggs.get(id);
    if (!a) aggs.set(id, (a = { kind, key, surfaces: new Map(), freq: 0, docs: new Set() }));
    a.freq += 1;
    a.docs.add(unit);
    a.surfaces.set(surface, (a.surfaces.get(surface) ?? 0) + 1);
    raw[unit].push({ id, start, end, sentence });
  };
  for (const { unit, sentences } of scans) {
    sentences.forEach(({ scan }, sIdx) => {
      for (const seg of scan.han) {
        for (const p of coverSegment(seg, gramCounts)) add(unit, `concept:${p.term}`, "concept", p.term, p.term, p.start, p.end, sIdx);
      }
      for (const t of scan.latin) {
        const key = normalizeKey(t.text);
        if (latinEligible(t.text, key)) add(unit, `concept:${key}`, "concept", key, t.text, t.start, t.end, sIdx);
      }
      for (const p of scan.persons) {
        const key = normalizeKey(p.name);
        add(unit, `person:${key}`, "person", key, p.name, p.start, p.end, sIdx);
      }
    });
  }

  // 4) 證據門檻 + 評分
  const concepts: Concept[] = [];
  for (const [id, a] of aggs) {
    if (a.freq < MIN_TERM_FREQ) continue;
    const label = [...a.surfaces.entries()].sort((x, y) => y[1] - x[1] || cmp(x[0], y[0]))[0][0];
    concepts.push({ id, kind: a.kind, key: a.key, label, freq: a.freq, docFreq: a.docs.size, score: scoreOf(a.freq, a.docs.size) });
  }
  concepts.sort((x, y) => y.score - x.score || y.freq - x.freq || cmp(x.id, y.id));
  const kept = new Set(concepts.map((c) => c.id));
  const occurrences = raw.map((list) => list.filter((o) => kept.has(o.id)));
  return { concepts, occurrences, skippedUnits };
}
