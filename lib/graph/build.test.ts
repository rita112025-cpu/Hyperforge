import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chunkText } from "../pipeline/chunker";
import { chunksOverlapping, buildGraph, dedupeDocuments } from "./build";
import { MAX_GRAPH_EDGES, MAX_GRAPH_NODES } from "./constants";
import { seededPosition } from "./seed";
import type { GraphDocument } from "./types";

const doc = (id: string, text: string, name = id): GraphDocument => ({
  id,
  name,
  rawText: text,
  chunks: [{ index: 0, start: 0, end: text.length }],
});
const A = "電纜槽淨距不足，需要調整弱電橋架位置。";
const B = "弱電橋架與電纜槽之間必須保留足夠間距。";
const EN = "alpha bravo charlie. alpha bravo. charlie alpha. alpha."; // 8 個單位，剛好達到 MIN_DOC_UNITS

describe("buildGraph：節點、決定性", () => {
  it("A + B：節點 id 為 kind:key，且為 電纜槽 / 弱電 / 橋架", () => {
    const g = buildGraph([doc("A", A), doc("B", B)]);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["concept:弱電", "concept:橋架", "concept:電纜槽"].sort());
    expect(g.stats).toMatchObject({ docCount: 2, shownNodes: 3, nodesTruncated: false, totalConcepts: 3 });
  });

  it("相同輸入重建：節點 id、初始位置、拓撲、順序完全一致", () => {
    const docs = [doc("A", A), doc("B", B), doc("E", EN)];
    expect(buildGraph(docs)).toEqual(buildGraph(docs));
  });

  it("初始位置只取決於節點 id（與 seededPosition 一致，與其他節點無關）", () => {
    const g = buildGraph([doc("A", A), doc("B", B)]);
    for (const n of g.nodes) expect({ x: n.x, y: n.y }).toEqual(seededPosition(n.id));
  });

  it("文件順序不同：節點集合、id、位置、邊都相同", () => {
    const ab = buildGraph([doc("A", A), doc("B", B), doc("E", EN)]);
    const ba = buildGraph([doc("E", EN), doc("B", B), doc("A", A)]);
    const norm = (g: typeof ab) => ({
      nodes: [...g.nodes].sort((x, y) => (x.id < y.id ? -1 : 1)).map(({ id, x, y, r, score, freq }) => ({ id, x, y, r, score, freq })),
      edges: g.edges,
    });
    expect(norm(ab)).toEqual(norm(ba));
  });

  it("新增文件後：既有節點 id 與初始位置不變（圖不會整張跳位）", () => {
    const before = buildGraph([doc("A", A), doc("B", B)]);
    const after = buildGraph([doc("A", A), doc("B", B), doc("E", EN)]);
    const pos = new Map(after.nodes.map((n) => [n.id, [n.x, n.y]]));
    for (const n of before.nodes) expect(pos.get(n.id)).toEqual([n.x, n.y]);
    expect(after.nodes.length).toBeGreaterThan(before.nodes.length);
  });

  it("同一內容不重複計算：相同 id 或相同文字的文件只算一份", () => {
    const one = buildGraph([doc("A", A), doc("B", B)]);
    const dup = buildGraph([doc("A", A), doc("B", B), doc("A", A), doc("other-id", A)]);
    expect(dup.nodes.map((n) => [n.id, n.freq])).toEqual(one.nodes.map((n) => [n.id, n.freq]));
    expect(dedupeDocuments([doc("A", A), doc("x", A), doc("A", B)])).toHaveLength(1);
  });

  it("沒有 chunk 或空文字的文件不產生節點，也不報錯", () => {
    const g = buildGraph([{ id: "e", name: "e", rawText: "", chunks: [] }, doc("s", "你好")]);
    expect(g.nodes).toEqual([]);
    expect(g.stats.skippedDocCount).toBe(1);
  });
});

describe("buildGraph：co-occurrence 邊", () => {
  it("邊權重 = 同一句子內共同出現的句數", () => {
    const g = buildGraph([doc("E", EN)]);
    const w = Object.fromEntries(g.edges.map((e) => [e.id, e.weight]));
    expect(w).toEqual({
      "concept:alpha--concept:bravo": 2,
      "concept:alpha--concept:charlie": 2,
      "concept:bravo--concept:charlie": 1,
    });
    expect(g.edges.every((e) => e.kind === "co-occurrence")).toBe(true);
  });

  it("A + B：三個概念兩兩共現於 2 句，權重為 2", () => {
    const g = buildGraph([doc("A", A), doc("B", B)]);
    expect(g.edges).toHaveLength(3);
    expect(g.edges.every((e) => e.weight === 2)).toBe(true);
  });

  it("不同句子的詞不連邊", () => {
    const g = buildGraph([doc("E", "alpha bravo. alpha bravo. charlie delta. charlie delta.")]);
    const ids = g.edges.map((e) => e.id);
    expect(ids).toContain("concept:alpha--concept:bravo");
    expect(ids).toContain("concept:charlie--concept:delta");
    expect(ids).not.toContain("concept:alpha--concept:charlie");
  });

  it("邊上限：超過時依權重取前 N，並於 stats 明示，不靜默截斷", () => {
    const g = buildGraph([doc("E", EN)], { maxEdges: 2 });
    expect(g.edges).toHaveLength(2);
    expect(g.stats).toMatchObject({ totalEdges: 3, shownEdges: 2, edgeCap: 2, edgesTruncated: true });
    expect(g.edges.map((e) => e.weight)).toEqual([2, 2]);
    expect(MAX_GRAPH_EDGES).toBeGreaterThan(0);
  });
});

describe("buildGraph：節點上限", () => {
  /** 產生 n 個互異的 Latin 概念，第 i 個詞出現 2 + (i % 4) 次。 */
  function manyConcepts(n: number): GraphDocument {
    const sentences: string[] = [];
    for (let i = 0; i < n; i++) {
      const term = `term${String(i).padStart(3, "0")}x`;
      for (let k = 0; k < 2 + (i % 4); k++) sentences.push(`${term} common${i % 7}pad ${term}.`);
    }
    return doc("many", sentences.join(" "));
  }

  it("MAX_GRAPH_NODES 為單一常數 150", () => {
    expect(MAX_GRAPH_NODES).toBe(150);
  });

  it("超過上限時取前 150 個，stats 明示截斷", () => {
    const g = buildGraph([manyConcepts(260)]);
    expect(g.nodes).toHaveLength(MAX_GRAPH_NODES);
    expect(g.stats.nodesTruncated).toBe(true);
    expect(g.stats.nodeCap).toBe(MAX_GRAPH_NODES);
    expect(g.stats.totalConcepts).toBeGreaterThan(MAX_GRAPH_NODES);
    expect(g.stats.shownNodes).toBe(MAX_GRAPH_NODES);
  });

  it("被截掉的概念分數不高於留下的最低分", () => {
    const all = buildGraph([manyConcepts(260)], { maxNodes: 10_000 });
    const cut = buildGraph([manyConcepts(260)]);
    const minShown = Math.min(...cut.nodes.map((n) => n.score));
    const shownIds = new Set(cut.nodes.map((n) => n.id));
    for (const n of all.nodes) if (!shownIds.has(n.id)) expect(n.score).toBeLessThanOrEqual(minShown);
  });

  it("相同輸入的截斷結果決定性（含 150 個節點的 id 與位置）", () => {
    expect(buildGraph([manyConcepts(260)]).nodes).toEqual(buildGraph([manyConcepts(260)]).nodes);
  });

  it("未超過上限時不標示截斷", () => {
    expect(buildGraph([manyConcepts(20)]).stats.nodesTruncated).toBe(false);
  });
});

describe("buildGraph：出處 evidence", () => {
  it("記錄各文件、各 chunk；occurrence 位移可回放原文", () => {
    const text = Array.from({ length: 1200 }, (_, i) => (i % 100 === 0 ? "cable" : `w${i}`)).join(" ");
    const chunks = chunkText(text, 500, 50).map((c) => ({ index: c.index, start: c.start, end: c.end }));
    expect(chunks.length).toBeGreaterThan(2);
    const g = buildGraph([{ id: "d1", name: "spec.md", rawText: text, chunks }]);
    const node = g.nodes.find((n) => n.key === "cable")!;
    const ev = g.evidence[node.id];
    expect(node.freq).toBe(12);
    expect(ev.docs).toHaveLength(1);
    expect(ev.docs[0]).toMatchObject({ docId: "d1", docName: "spec.md", occurrences: 12 });
    expect(ev.docs[0].chunkIndexes).toEqual([...ev.docs[0].chunkIndexes].sort((a, b) => a - b));
    expect(ev.docs[0].chunkIndexes.length).toBeGreaterThan(1);
    expect(node.chunkFreq).toBe(ev.docs[0].chunkIndexes.length);
    for (const o of ev.occurrences) expect(text.slice(o.start, o.end).toLowerCase()).toBe("cable");
  });

  it("chunksOverlapping：重疊區間同時屬於兩個 chunk", () => {
    const chunks = [
      { index: 0, start: 0, end: 100 },
      { index: 1, start: 80, end: 180 },
      { index: 2, start: 160, end: 260 },
    ];
    expect(chunksOverlapping(chunks, 10, 20)).toEqual([0]);
    expect(chunksOverlapping(chunks, 85, 90)).toEqual([0, 1]);
    expect(chunksOverlapping(chunks, 170, 175)).toEqual([1, 2]);
    expect(chunksOverlapping(chunks, 300, 310)).toEqual([]);
  });

  it("人名節點標記 heuristic；概念節點不標", () => {
    const g = buildGraph([
      doc("e", "Ada Lovelace wrote notes on the engine. Ada Lovelace published the notes. engine notes engine notes."),
    ]);
    const p = g.nodes.find((n) => n.kind === "person")!;
    expect(p).toMatchObject({ label: "Ada Lovelace", heuristic: true, shape: "diamond" });
    expect(g.nodes.filter((n) => n.kind === "concept").every((n) => !n.heuristic)).toBe(true);
  });
});

describe("Graph 與 embedding 解耦（靜態檢查）", () => {
  const read = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
  const importsOf = (f: string) => [...read(f).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

  it("build / extract / alchemy / seed / types / constants 不 import 任何 vector 模組", () => {
    for (const f of ["build.ts", "extract.ts", "alchemy.ts", "seed.ts", "types.ts", "constants.ts"]) {
      expect(importsOf(f).filter((i) => i.includes("vector")), f).toEqual([]);
    }
  });

  it("corpus 只允許 import vector/db（型別）與 vector/hash，不得碰 embedder / index-store / runtime / transformers", () => {
    const imports = importsOf("corpus.ts");
    expect(imports.filter((i) => i.includes("vector")).sort()).toEqual(["../vector/db", "../vector/hash"]);
    expect(imports.some((i) => /embedder|transformers|index-store|runtime/.test(i))).toBe(false);
  });

  it("沒有 vector-similarity / semantic edge：EdgeKind 只有 co-occurrence 與 alchemy", () => {
    expect(read("types.ts")).toMatch(/export type EdgeKind = "co-occurrence" \| "alchemy";/);
    expect(code("build.ts")).not.toMatch(/cosine|similarity|semantic/i);
  });
});
