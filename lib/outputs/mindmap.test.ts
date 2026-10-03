import { describe, expect, it } from "vitest";
import { buildGraph } from "../graph/build";
import type { GraphDocument, GraphNode } from "../graph/types";
import { chunkText } from "../pipeline/chunker";
import { buildDigest, type Digest } from "./digest";
import { MINDMAP_MAX_BRANCH, MINDMAP_MAX_DEPTH, MINDMAP_MAX_ROOTS, buildMindmap, mindNodeQuotes, mindmapLines, mindmapToMarkdown, type MindNode } from "./mindmap";
import { segmentsToText, verifySegments, type SourceDoc } from "./segments";
import { initialTreeState, reconcile, reduceKey, toggleExpanded, visibleItems } from "./tree-state";

/** 只含心智圖會用到的欄位的假 digest */
function fake(nodes: Array<[string, number]>, edges: Array<[string, string, number]>): Digest {
  const concepts = nodes.map(([id, score]) => ({ id, key: id, label: id, kind: "concept", heuristic: false, score, freq: 1 }) as unknown as GraphNode);
  return { docs: [], concepts, sentences: [], topEdges: [], edges: edges.map(([a, b, weight]) => ({ a, b, weight })), conceptDocs: {} } as unknown as Digest;
}
const ids = (n: MindNode): string[] => [n.id, ...n.children.flatMap(ids)];
const find = (n: MindNode, id: string): MindNode | undefined => (n.id === id ? n : n.children.map((c) => find(c, id)).find(Boolean));
const parentOf = (root: MindNode, id: string): string | undefined => {
  const walk = (n: MindNode): string | undefined => (n.children.some((c) => c.id === id) ? n.id : n.children.map(walk).find(Boolean));
  return walk(root);
};

describe("心智圖生成樹規則", () => {
  it("根 = 連通群組內分數最高者；分數相同取 id 較小者", () => {
    const m = buildMindmap(fake([["b", 5], ["a", 5], ["c", 1]], [["a", "b", 1], ["b", "c", 1]]));
    expect(m.groups[0].root.id).toBe("a");
  });

  it("多個可能的父節點：掛在『邊權重最大者』，不是先到先掛", () => {
    // r 連 x(w5)、y(w2)；z 連 x(w1)、y(w9) → z 的深度 2，父節點應為 y（權重 9），即使 x 排在前面
    const m = buildMindmap(fake([["r", 10], ["x", 5], ["y", 4], ["z", 3]], [["r", "x", 5], ["r", "y", 2], ["x", "z", 1], ["y", "z", 9]]));
    const root = m.groups[0].root;
    expect(parentOf(root, "z")).toBe("y");
  });

  it("權重相同時依 id 排序（取較小者）", () => {
    const m = buildMindmap(fake([["r", 10], ["y", 4], ["x", 4], ["z", 3]], [["r", "x", 5], ["r", "y", 5], ["x", "z", 3], ["y", "z", 3]]));
    expect(parentOf(m.groups[0].root, "z")).toBe("x");
  });

  it("不連通：每個連通群組各有根；依根的分數排序；超過 5 個群組的只計數、不默默消失", () => {
    const nodes: Array<[string, number]> = Array.from({ length: 8 }, (_, i) => [`n${i}`, 100 - i]);
    const m = buildMindmap(fake(nodes, [["n0", "n7", 1]])); // n0-n7 一組，其餘 6 個孤立 → 共 7 個群組
    expect(m.groups).toHaveLength(MINDMAP_MAX_ROOTS);
    expect(m.groups.map((g) => g.root.id)).toEqual(["n0", "n1", "n2", "n3", "n4"]);
    expect(m.omittedGroups).toBe(2);
    expect(m.omittedConcepts).toBe(2); // n5、n6
    expect(m.groups[0].size).toBe(2);
  });

  it("分支上限：每層最多 6 個；多的以 hiddenChildren 標示，並計入群組 hidden", () => {
    const kids: Array<[string, number]> = Array.from({ length: 9 }, (_, i) => [`k${i}`, 50 - i]);
    const m = buildMindmap(fake([["r", 100], ...kids], kids.map(([k], i) => ["r", k, 20 - i] as [string, string, number])));
    const root = m.groups[0].root;
    expect(root.children).toHaveLength(MINDMAP_MAX_BRANCH);
    expect(root.hiddenChildren).toBe(3);
    expect(m.groups[0].hidden).toBe(3);
    // 保留的是權重最大的前 6 個
    expect(root.children.map((c) => c.id)).toEqual(["k0", "k1", "k2", "k3", "k4", "k5"]);
  });

  it("深度上限：深度 3 的節點不再顯示子節點，並標示還有幾個", () => {
    const chain = ["r", "a", "b", "c", "d", "e"];
    const m = buildMindmap(fake(chain.map((id, i) => [id, 100 - i] as [string, number]), chain.slice(1).map((id, i) => [chain[i], id, 1] as [string, string, number])));
    const root = m.groups[0].root;
    expect(ids(root)).toEqual(["r", "a", "b", "c"]);
    expect(find(root, "c")!.depth).toBe(MINDMAP_MAX_DEPTH);
    expect(find(root, "c")!.hiddenChildren).toBe(1); // d
    expect(m.groups[0].hidden).toBe(2); // d、e
  });

  it("有環：每個節點只出現一次", () => {
    const m = buildMindmap(fake([["a", 3], ["b", 2], ["c", 1]], [["a", "b", 1], ["b", "c", 1], ["c", "a", 1]]));
    const all = ids(m.groups[0].root);
    expect(all.sort()).toEqual(["a", "b", "c"]);
  });

  it("決定性：節點與邊的輸入順序打亂後，結果完全相同", () => {
    const nodes: Array<[string, number]> = [["a", 9], ["b", 8], ["c", 7], ["d", 6], ["e", 5], ["f", 4]];
    const edges: Array<[string, string, number]> = [["a", "b", 3], ["a", "c", 3], ["b", "d", 2], ["c", "d", 2], ["d", "e", 1], ["f", "e", 1]];
    const base = JSON.stringify(buildMindmap(fake(nodes, edges)));
    expect(JSON.stringify(buildMindmap(fake([...nodes].reverse(), [...edges].reverse())))).toBe(base);
    expect(JSON.stringify(buildMindmap(fake([nodes[3], nodes[0], nodes[5], nodes[1], nodes[4], nodes[2]], [edges[4], edges[1], edges[5], edges[0], edges[3], edges[2]])))).toBe(base);
  });

  it("空 digest：沒有群組；Markdown 說明無法產生", () => {
    const m = buildMindmap(fake([], []));
    expect(m.groups).toEqual([]);
    expect(mindmapToMarkdown(m)).toContain("無法產生心智圖");
  });

  it("單一節點：一個群組、無子節點", () => {
    const m = buildMindmap(fake([["only", 1]], []));
    expect(m.groups).toHaveLength(1);
    expect(m.groups[0].root.children).toEqual([]);
    expect(m.groups[0].hidden).toBe(0);
  });
});

describe("心智圖：真實語料、片段檢查與 Markdown", () => {
  const doc = (name: string, text: string): GraphDocument => ({ id: `id-${name}`, name, rawText: text, chunks: chunkText(text).map((c) => ({ index: c.index, start: c.start, end: c.end })) });
  const ZH_A = ["電纜槽與通信線纜架需要保持淨距，避免訊號干擾。", "弱電橋架與其他管線應保持安全間距，方便日後維修。", "機房內的電纜槽必須分類敷設，強電與弱電不得混放。", "電纜槽內的線纜不得超過容量，橋架需預留擴充空間。", "通信線纜架的支撐間距應定期檢查，確保荷重安全。"].join("\n");
  const ZH_B = ["弱電橋架內的線纜應整齊綁紮，並標示用途。", "電纜槽施工前必須確認淨距，再安裝橋架與支撐。", "機房弱電系統完成後，需要測試通信線纜的訊號品質。"].join("\n");
  const docs = [doc("管線規範.md", ZH_A), doc("施工筆記.md", ZH_B)];
  const digest = buildDigest(docs, buildGraph(docs));
  const sources = new Map<string, SourceDoc>(docs.map((d) => [d.id, { name: d.name, rawText: d.rawText }]));
  const mm = buildMindmap(digest);

  it("fixture 有樹（避免空轉）", () => {
    expect(mm.groups.length).toBeGreaterThan(0);
    expect(ids(mm.groups[0].root).length).toBeGreaterThan(3);
  });

  it("每一行（標號縮排、term、heuristic、還有 N 個未顯示）都通過片段檢查；term 都出現在來源文件裡", () => {
    for (const line of mindmapLines(mm)) expect(verifySegments(line, sources), segmentsToText(line)).toEqual([]);
  });

  it("「還有 N 個未顯示」的 N 等於獨立算出的隱藏數", () => {
    for (const line of mindmapLines(mm)) {
      const hidden = line.find((s) => s.kind === "frame" && /還有 \d+ 個未顯示/.test(s.text));
      if (!hidden) continue;
      const label = (line.find((s) => s.kind === "term") as { text: string }).text;
      const node = mm.groups.map((g) => find(g.root, `concept:${label}`)).find(Boolean)!;
      expect(hidden.text).toBe(`（還有 ${node.hiddenChildren} 個未顯示）`);
    }
  });

  it("節點展開時的原文：quote 逐字等於原文切片，且含該概念", () => {
    const root = mm.groups[0].root;
    const qs = mindNodeQuotes(digest, root.id, 2);
    expect(qs.length).toBeGreaterThan(0);
    for (const q of qs) {
      expect(verifySegments(q, sources)).toEqual([]);
      expect((q[0] as { text: string }).text.toLowerCase()).toContain(root.label.toLowerCase());
    }
    expect(mindNodeQuotes(digest, "concept:不存在")).toEqual([]);
  });

  it("Markdown：標題、群組、縮排條列；使用者概念名稱經過跳脫", () => {
    const md = mindmapToMarkdown(mm);
    expect(md).toContain("# 心智圖");
    expect(md).toContain("## 群組 1");
    expect(md).toMatch(/^- .+/m);
    expect(md).toMatch(/^ {2}- .+/m);
  });
});

describe("可摺疊樹的狀態與鍵盤（純函式）", () => {
  // r → (a → (a1, a2), b)；另一個群組 s
  const m = buildMindmap(fake([["r", 10], ["a", 9], ["b", 8], ["a1", 7], ["a2", 6], ["s", 5]], [["r", "a", 3], ["r", "b", 2], ["a", "a1", 2], ["a", "a2", 1]]));
  const groups = m.groups;

  it("初始：每個群組的根展開、焦點在第一個根、尚未選取", () => {
    const s = initialTreeState(groups);
    expect(s.focus).toBe("r");
    expect(s.selected).toBeNull();
    expect(visibleItems(groups, s.expanded).map((x) => x.node.id)).toEqual(["r", "a", "b", "s"]); // a 尚未展開，所以 a1/a2 不可見
  });

  it("↓/↑ 在可見節點間移動且不越界；Home/End 到頭尾", () => {
    let s = initialTreeState(groups);
    s = reduceKey(s, "ArrowDown", groups);
    expect(s.focus).toBe("a");
    s = reduceKey(s, "End", groups);
    expect(s.focus).toBe("s");
    s = reduceKey(s, "ArrowDown", groups);
    expect(s.focus).toBe("s");
    s = reduceKey(s, "Home", groups);
    expect(s.focus).toBe("r");
    s = reduceKey(s, "ArrowUp", groups);
    expect(s.focus).toBe("r");
  });

  it("→：已收合則展開；已展開則進入第一個子節點；葉節點不動", () => {
    let s = reduceKey(initialTreeState(groups), "ArrowDown", groups); // 焦點 a（收合）
    s = reduceKey(s, "ArrowRight", groups);
    expect(s.expanded.has("a")).toBe(true);
    expect(s.focus).toBe("a");
    s = reduceKey(s, "ArrowRight", groups);
    expect(s.focus).toBe("a1");
    s = reduceKey(s, "ArrowRight", groups);
    expect(s.focus).toBe("a1");
  });

  it("←：已展開則收合；否則回到父節點；根不動", () => {
    let s = initialTreeState(groups);
    s = reduceKey(s, "ArrowDown", groups);
    s = reduceKey(s, "ArrowRight", groups); // 展開 a
    s = reduceKey(s, "ArrowRight", groups); // → a1
    s = reduceKey(s, "ArrowLeft", groups); // a1 是葉：回到父 a
    expect(s.focus).toBe("a");
    s = reduceKey(s, "ArrowLeft", groups); // a 已展開：收合
    expect(s.expanded.has("a")).toBe(false);
    s = reduceKey(s, "ArrowLeft", groups); // a 已收合：回到父 r
    expect(s.focus).toBe("r");
    s = reduceKey(s, "ArrowLeft", groups); // r 已展開：收合
    expect(s.expanded.has("r")).toBe(false);
    s = reduceKey(s, "ArrowLeft", groups); // r 已收合且是根：不動
    expect(s.focus).toBe("r");
  });

  it("Enter / Space 切換『顯示原文』；再按一次關閉", () => {
    let s = initialTreeState(groups);
    s = reduceKey(s, "Enter", groups);
    expect(s.selected).toBe("r");
    s = reduceKey(s, " ", groups);
    expect(s.selected).toBeNull();
  });

  it("toggleExpanded 與 reconcile：語料變動後移除消失的節點，焦點與選取不指向不存在的節點", () => {
    let s = toggleExpanded(initialTreeState(groups), "a");
    s = { ...s, focus: "a2", selected: "a2" };
    const smaller = buildMindmap(fake([["r", 10], ["b", 8]], [["r", "b", 2]])).groups;
    const r = reconcile(s, smaller);
    expect(r.expanded.has("a")).toBe(false);
    expect(r.focus).toBe("r");
    expect(r.selected).toBeNull();
  });

  it("空群組：reduceKey 不丟錯、狀態不變", () => {
    const s = initialTreeState([]);
    expect(reduceKey(s, "ArrowDown", [])).toBe(s);
  });
});

describe("reconcile：資料晚到時新根預設展開；使用者收合的根不會被重新展開", () => {
  const withData = buildMindmap(fake([["r", 10], ["a", 9]], [["r", "a", 1]])).groups;
  it("一開始是空的，之後才有群組：根展開、焦點落在第一個根", () => {
    const s0 = initialTreeState([]);
    expect(s0.focus).toBeNull();
    const s1 = reconcile(s0, withData);
    expect(s1.expanded.has("r")).toBe(true);
    expect(s1.focus).toBe("r");
    expect(visibleItems(withData, s1.expanded).map((x) => x.node.id)).toEqual(["r", "a"]);
  });
  it("使用者收合根之後資料更新：維持收合", () => {
    let s = initialTreeState(withData);
    s = toggleExpanded(s, "r");
    expect(s.expanded.has("r")).toBe(false);
    const s2 = reconcile(s, withData);
    expect(s2.expanded.has("r")).toBe(false);
  });
});
