import { MAX_EVIDENCE_OCCURRENCES, MAX_GRAPH_EDGES, MAX_GRAPH_NODES } from "./constants";
import { extractConcepts, type TermOccurrence } from "./extract";
import { seededPosition } from "./seed";
import type { GraphChunk, GraphDocument, GraphEdge, GraphModel, GraphNode, NodeEvidence } from "./types";

/**
 * documents/chunks → concepts → nodes → co-occurrence edges。純函式。
 * 本層不依賴任何向量：邊只有 co-occurrence（同一句子內同時出現），沒有 semantic / vector-similarity 邊。
 */

export const NODE_RADIUS_MIN = 9;
export const NODE_RADIUS_MAX = 22;

export interface BuildOptions {
  maxNodes?: number;
  maxEdges?: number;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 以 id 去重；內容相同（rawText 相同）者也去重，避免記憶體 job 與 DB 內同一份文件被算兩次。 */
export function dedupeDocuments(docs: GraphDocument[]): GraphDocument[] {
  const ids = new Set<string>();
  const texts = new Set<string>();
  const out: GraphDocument[] = [];
  for (const d of docs) {
    if (ids.has(d.id) || texts.has(d.rawText)) continue;
    ids.add(d.id);
    texts.add(d.rawText);
    out.push(d);
  }
  return out;
}

/** 與 occurrence [start, end) 重疊的 chunk index（chunk 依 start/end 遞增排列，可二分搜尋）。 */
export function chunksOverlapping(chunks: GraphChunk[], start: number, end: number): number[] {
  let lo = 0;
  let hi = chunks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (chunks[mid].end > start) hi = mid;
    else lo = mid + 1;
  }
  const out: number[] = [];
  for (let i = lo; i < chunks.length && chunks[i].start < end; i++) out.push(chunks[i].index);
  return out;
}

export function buildGraph(input: GraphDocument[], opts: BuildOptions = {}): GraphModel {
  const maxNodes = opts.maxNodes ?? MAX_GRAPH_NODES;
  const maxEdges = opts.maxEdges ?? MAX_GRAPH_EDGES;
  const docs = dedupeDocuments(input).filter((d) => d.chunks.length > 0);
  const chunkCount = docs.reduce((n, d) => n + d.chunks.length, 0);

  const extraction = extractConcepts(docs.map((d) => ({ docId: d.id, text: d.rawText })));
  const ranked = extraction.concepts;
  const shown = ranked.slice(0, maxNodes);
  const maxScore = shown[0]?.score ?? 0;
  const indexOf = new Map(shown.map((c, i) => [c.id, i]));

  // 出處：各文件、各 chunk、可回放的 occurrence（freq 為精確值，occurrence 有上限）
  const perNodeDocs: Array<Map<number, { chunks: Set<number>; occurrences: number }>> = shown.map(() => new Map());
  const evidenceOcc: NodeEvidence["occurrences"][] = shown.map(() => []);
  const sentenceNodes = new Map<string, Set<number>>();
  extraction.occurrences.forEach((list, docIdx) => {
    const doc = docs[docIdx];
    for (const o of list as TermOccurrence[]) {
      const ni = indexOf.get(o.id);
      if (ni === undefined) continue;
      let d = perNodeDocs[ni].get(docIdx);
      if (!d) perNodeDocs[ni].set(docIdx, (d = { chunks: new Set(), occurrences: 0 }));
      d.occurrences += 1;
      for (const ci of chunksOverlapping(doc.chunks, o.start, o.end)) d.chunks.add(ci);
      if (evidenceOcc[ni].length < MAX_EVIDENCE_OCCURRENCES) evidenceOcc[ni].push({ docId: doc.id, start: o.start, end: o.end });
      const sk = `${docIdx}:${o.sentence}`;
      let set = sentenceNodes.get(sk);
      if (!set) sentenceNodes.set(sk, (set = new Set()));
      set.add(ni);
    }
  });

  const nodes: GraphNode[] = [];
  const evidence: Record<string, NodeEvidence> = {};
  shown.forEach((c, i) => {
    const pos = seededPosition(c.id);
    const chunkFreq = [...perNodeDocs[i].values()].reduce((n, d) => n + d.chunks.size, 0);
    const person = c.kind === "person";
    nodes.push({
      id: c.id,
      key: c.key,
      label: c.label,
      kind: c.kind,
      shape: person ? "diamond" : "circle",
      heuristic: person,
      temporary: false,
      score: c.score,
      freq: c.freq,
      docFreq: c.docFreq,
      chunkFreq,
      x: pos.x,
      y: pos.y,
      r: maxScore > 0 ? NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * Math.sqrt(c.score / maxScore) : NODE_RADIUS_MIN,
    });
    evidence[c.id] = {
      docs: [...perNodeDocs[i].entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([docIdx, d]) => ({
          docId: docs[docIdx].id,
          docName: docs[docIdx].name,
          chunkIndexes: [...d.chunks].sort((a, b) => a - b),
          occurrences: d.occurrences,
        })),
      occurrences: evidenceOcc[i],
    };
  });

  // co-occurrence：同一句子內同時出現的節點兩兩連邊，權重 = 共同出現的句子數
  const pair = new Map<string, number>();
  for (const set of sentenceNodes.values()) {
    if (set.size < 2) continue;
    const ids = [...set].map((i) => shown[i].id).sort(cmp);
    for (let x = 0; x < ids.length; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        const k = `${ids[x]}\u0000${ids[y]}`;
        pair.set(k, (pair.get(k) ?? 0) + 1);
      }
    }
  }
  const allEdges: GraphEdge[] = [...pair.entries()].map(([k, weight]) => {
    const [a, b] = k.split("\u0000");
    return { id: `${a}--${b}`, a, b, weight, kind: "co-occurrence" as const };
  });
  allEdges.sort((e1, e2) => e2.weight - e1.weight || cmp(e1.id, e2.id));
  const edges = allEdges.slice(0, maxEdges);

  return {
    nodes,
    edges,
    evidence,
    stats: {
      docCount: docs.length,
      chunkCount,
      skippedDocCount: extraction.skippedUnits.length,
      totalConcepts: ranked.length,
      shownNodes: nodes.length,
      nodeCap: maxNodes,
      nodesTruncated: ranked.length > maxNodes,
      totalEdges: allEdges.length,
      shownEdges: edges.length,
      edgeCap: maxEdges,
      edgesTruncated: allEdges.length > maxEdges,
    },
  };
}
