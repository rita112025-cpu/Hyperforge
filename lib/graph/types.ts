/** 圖譜最低資料需求：文件文字 + chunk 位移。不含、也不依賴任何向量。 */
export interface GraphChunk {
  index: number;
  /** rawText 的字元位移 [start, end) */
  start: number;
  end: number;
}

export interface GraphDocument {
  /** 內容 SHA-256（與 IndexedDB docs.id 相同），跨來源（記憶體 job / DB）據此去重 */
  id: string;
  name: string;
  rawText: string;
  chunks: GraphChunk[];
}

export type NodeKind = "concept" | "person" | "temp";
export type NodeShape = "circle" | "diamond" | "hexagon";

export interface GraphNode {
  /** `${kind}:${normalizedKey}`（temp 為 `temp:${hash}`）。決定性：同輸入必得同 id */
  id: string;
  key: string;
  label: string;
  kind: NodeKind;
  shape: NodeShape;
  /** true = 英文啟發式人名偵測（非 NER、非 AI），UI 必須標示 */
  heuristic: boolean;
  /** true = 暫存煉成節點，不寫入 IndexedDB，重整即消失 */
  temporary: boolean;
  score: number;
  freq: number;
  docFreq: number;
  chunkFreq: number;
  /** seeded 初始位置（world 座標） */
  x: number;
  y: number;
  r: number;
  /** 暫存節點的來源節點 id */
  parents?: string[];
}

export type EdgeKind = "co-occurrence" | "alchemy";

export interface GraphEdge {
  id: string;
  a: string;
  b: string;
  /** co-occurrence：同時出現的句子數；alchemy 固定 1 */
  weight: number;
  kind: EdgeKind;
}

export interface EvidenceOccurrence {
  docId: string;
  /** rawText 絕對位移 [start, end) */
  start: number;
  end: number;
}

export interface NodeEvidence {
  /** 出現過的文件，與各文件中出現的 chunk index */
  docs: { docId: string; docName: string; chunkIndexes: number[]; occurrences: number }[];
  /** 可回放的出處（有上限 MAX_EVIDENCE_OCCURRENCES；freq 為精確值） */
  occurrences: EvidenceOccurrence[];
}

export interface GraphStats {
  docCount: number;
  chunkCount: number;
  /** 因證據不足（過短）而未納入分析的文件數 */
  skippedDocCount: number;
  /** 通過證據門檻的概念總數（含被 cap 截掉的） */
  totalConcepts: number;
  shownNodes: number;
  nodeCap: number;
  nodesTruncated: boolean;
  totalEdges: number;
  shownEdges: number;
  edgeCap: number;
  edgesTruncated: boolean;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  evidence: Record<string, NodeEvidence>;
  stats: GraphStats;
}
