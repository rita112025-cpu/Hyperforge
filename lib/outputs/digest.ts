import { dedupeDocuments } from "../graph/build";
import { extractConcepts, splitSentences } from "../graph/extract";
import type { GraphDocument, GraphModel, GraphNode } from "../graph/types";

/**
 * 輸出層共用的「摘要資料」（純函式、決定性、本地）。
 * 這不是 AI：只是把圖譜上的概念對回原文句子，依概念分數排序句子。
 * 之後每種輸出（摘要、簡報、Threads…）都只能引用這裡挑出的原文句子，模板不得憑空造事實。
 */
export const DIGEST_NOTE = "抽取式（統計近似），非 AI：內容來自原文句子，模板只負責排版";

export const MIN_SENTENCE_CHARS = 12;
export const MAX_SENTENCE_CHARS = 140;

export interface DigestSentence {
  docId: string;
  docName: string;
  text: string;
  /** 在該文件 rawText 內的位移 [start, end)（已 trim） */
  start: number;
  end: number;
  score: number;
  /** 句內出現的（顯示在圖譜上的）概念 id，已去重 */
  conceptIds: string[];
}

export interface Digest {
  docs: Array<{ id: string; name: string }>;
  /** 圖譜上的真實概念 / 人名（排除暫存煉成節點），依 score 由高到低 */
  concepts: GraphNode[];
  /** 全部候選句子，依 score 由高到低（同分依文件 id、位移，決定性） */
  sentences: DigestSentence[];
  /** 共現最強的概念對（只含真實節點） */
  topEdges: Array<{ a: GraphNode; b: GraphNode; weight: number }>;
  /** 圖譜上真實節點之間的全部共現邊（依權重、id 排序），心智圖用 */
  edges: Array<{ a: string; b: string; weight: number }>;
  /** 概念 id → 出現過的文件（id 與名稱；取自圖譜的 evidence，是精確的，不受句子長度過濾影響） */
  conceptDocs: Record<string, Array<{ id: string; name: string }>>;
  /** 資料基礎（與畫布狀態列相同的數字），UI 必須顯示，截斷時要明說 */
  basis: { docCount: number; conceptsShown: number; conceptsTotal: number; nodeCap: number; truncated: boolean };
}

/** 資料基礎（只讀圖譜統計，很便宜；面板不必為了顯示它而先算 digest） */
export function basisOf(graph: GraphModel): Digest["basis"] {
  return {
    docCount: graph.stats.docCount,
    conceptsShown: graph.nodes.filter((n) => !n.temporary).length,
    conceptsTotal: graph.stats.totalConcepts,
    nodeCap: graph.stats.nodeCap,
    truncated: graph.stats.nodesTruncated,
  };
}

/** 輸出頁面上的資料基礎說明（一行） */
export function describeBasis(b: Digest["basis"]): string {
  const base = `基於 ${b.docCount} 份文件、圖譜上顯示的 ${b.conceptsShown} 個概念`;
  return b.truncated ? `${base}（共 ${b.conceptsTotal} 個，概念上限 ${b.nodeCap}，其餘未納入）` : base;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const charLen = (s: string) => Array.from(s).length;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function buildDigest(input: GraphDocument[], graph: GraphModel): Digest {
  // 與畫布同一份語料：呼叫端傳入畫布當下的 docs 與 graph；digest 只使用「顯示在圖譜上的」概念（受 MAX_GRAPH_NODES 限制），
  // 所以輸出不會提到畫布上看不到的概念。依文件 id 排序，結果與傳入順序無關（近似重複去除時「保留哪一份」也不受順序影響）。
  const docs = dedupeDocuments(input)
    .filter((d) => d.chunks.length > 0)
    .sort((a, b) => cmp(a.id, b.id));
  const concepts = graph.nodes.filter((n) => !n.temporary).sort((a, b) => b.score - a.score || cmp(a.id, b.id));
  const byId = new Map(concepts.map((n) => [n.id, n]));

  const extraction = extractConcepts(docs.map((d) => ({ docId: d.id, text: d.rawText })));
  const sentences: DigestSentence[] = [];
  const seen = new Set<string>();

  docs.forEach((doc, docIdx) => {
    const ranges = splitSentences(doc.rawText);
    const perSentence = new Map<number, Set<string>>();
    for (const o of extraction.occurrences[docIdx] ?? []) {
      if (!byId.has(o.id)) continue; // 只用顯示在圖譜上的概念（與使用者看到的一致）
      (perSentence.get(o.sentence) ?? perSentence.set(o.sentence, new Set()).get(o.sentence)!).add(o.id);
    }
    for (const [sIdx, ids] of perSentence) {
      const range = ranges[sIdx];
      if (!range) continue;
      const raw = doc.rawText.slice(range[0], range[1]);
      const text = raw.trim();
      const len = charLen(text);
      if (len < MIN_SENTENCE_CHARS || len > MAX_SENTENCE_CHARS) continue;
      const key = norm(text);
      if (seen.has(key)) continue; // 近似重複（同一句出現在多份文件）只留第一個
      seen.add(key);
      const start = range[0] + (raw.length - raw.trimStart().length);
      const conceptIds = [...ids].sort(cmp);
      const total = conceptIds.reduce((s, id) => s + byId.get(id)!.score, 0);
      sentences.push({
        docId: doc.id,
        docName: doc.name,
        text,
        start,
        end: start + text.length,
        score: total / (1 + len / 60), // 長句不因為「含的詞多」而天然勝出
        conceptIds,
      });
    }
  });
  sentences.sort((a, b) => b.score - a.score || cmp(a.docId, b.docId) || a.start - b.start);

  const realEdges = graph.edges
    .filter((e) => e.kind === "co-occurrence" && byId.has(e.a) && byId.has(e.b))
    .sort((a, b) => b.weight - a.weight || cmp(a.id, b.id));
  const topEdges = realEdges.slice(0, 20).map((e) => ({ a: byId.get(e.a)!, b: byId.get(e.b)!, weight: e.weight }));
  const edges = realEdges.map((e) => ({ a: e.a, b: e.b, weight: e.weight }));

  const conceptDocs: Digest["conceptDocs"] = {};
  for (const c of concepts) conceptDocs[c.id] = (graph.evidence[c.id]?.docs ?? []).map((d) => ({ id: d.docId, name: d.docName })).sort((a, b) => cmp(a.id, b.id)); // 依文件 id 排序：與輸入順序無關

  return {
    docs: docs.map((d) => ({ id: d.id, name: d.name })),
    concepts,
    sentences,
    topEdges,
    edges,
    conceptDocs,
    basis: basisOf(graph),
  };
}

/**
 * 貪婪挑 n 個「彼此涵蓋不同概念」的句子（MMR-lite）：每一步選「新增概念分數」最大者；
 * 概念都已涵蓋後，改依句子分數補滿（仍然是原文句子）。候選用完時照實少給，不湊數、不編造。
 */
export function selectDiverse(digest: Digest, n: number, exclude: ReadonlySet<DigestSentence> = new Set()): DigestSentence[] {
  const byId = new Map(digest.concepts.map((c) => [c.id, c]));
  const covered = new Set<string>();
  const picked: DigestSentence[] = [];
  const pool = digest.sentences.filter((s) => !exclude.has(s));
  while (picked.length < n && pool.length) {
    let best = -1;
    let bestGain = 0;
    for (let i = 0; i < pool.length; i++) {
      const gain = pool[i].conceptIds.reduce((s, id) => (covered.has(id) ? s : s + (byId.get(id)?.score ?? 0)), 0) + pool[i].score * 0.01;
      if (gain > bestGain) {
        bestGain = gain;
        best = i;
      }
    }
    if (best < 0) break;
    const s = pool.splice(best, 1)[0];
    s.conceptIds.forEach((id) => covered.add(id));
    picked.push(s);
  }
  return picked;
}

/** 某個概念的代表句：含該概念且分數最高者（可排除已使用的句子）。 */
export function representativeSentence(digest: Digest, conceptId: string, exclude: ReadonlySet<DigestSentence> = new Set()): DigestSentence | null {
  return digest.sentences.find((s) => !exclude.has(s) && s.conceptIds.includes(conceptId)) ?? null;
}
