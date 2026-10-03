import { DIGEST_NOTE, representativeSentence, type Digest, type DigestSentence } from "./digest";
import { escapeMarkdown } from "./markdown";
import { segmentsToText, type Segment } from "./segments";

/**
 * 心智圖：把圖譜（不是樹）轉成「決定性的生成樹」。規則（全部寫死、可測）：
 *  1. 以共現邊定義連通元件。每個連通元件各有一個根：元件內 score 最高者（同分取 id 較小者）。
 *  2. 元件依「根的 score 由高到低、再依根的 id」排序，最多顯示 MINDMAP_MAX_ROOTS 個（其餘只計數，不默默消失）。
 *  3. 每個元件從根做 BFS，深度 = 到根的最短跳數。
 *  4. 深度 ≥ 1 的節點，父節點 =「深度少 1 的鄰居中，邊權重最大者」；權重相同取 id 較小者（不是先到先掛）。
 *  5. 每個父節點的子節點依「與父節點的邊權重 desc、score desc、id」排序，最多顯示 MINDMAP_MAX_BRANCH 個；
 *     深度達 MINDMAP_MAX_DEPTH 的節點不再顯示子節點。被略過的以「還有 N 個未顯示」標示，並計入各群組的 hidden。
 *  6. 節點標籤只是 term（抽取得來）；點開才顯示原文 quote。標題文字不是模板寫的結論。
 */
export const MINDMAP_MAX_DEPTH = 3;
export const MINDMAP_MAX_BRANCH = 6;
export const MINDMAP_MAX_ROOTS = 5;

export interface MindNode {
  id: string;
  label: string;
  heuristic: boolean;
  score: number;
  freq: number;
  depth: number;
  children: MindNode[];
  /** 因分支或深度上限而沒有顯示的「直接子節點」數 */
  hiddenChildren: number;
}

export interface MindGroup {
  /** 1 起算 */
  index: number;
  root: MindNode;
  /** 此連通元件的概念總數 */
  size: number;
  shown: number;
  /** size - shown：被分支 / 深度上限略過的概念總數（含更深的後代） */
  hidden: number;
}

export interface Mindmap {
  groups: MindGroup[];
  /** 超過 MINDMAP_MAX_ROOTS 而完全沒顯示的連通元件數與其概念數 */
  omittedGroups: number;
  omittedConcepts: number;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function buildMindmap(d: Digest): Mindmap {
  const nodeOf = new Map(d.concepts.map((c) => [c.id, c]));
  const adj = new Map<string, Map<string, number>>();
  for (const c of d.concepts) adj.set(c.id, new Map());
  for (const e of d.edges) {
    if (!nodeOf.has(e.a) || !nodeOf.has(e.b) || e.a === e.b) continue;
    adj.get(e.a)!.set(e.b, e.weight);
    adj.get(e.b)!.set(e.a, e.weight);
  }

  // 連通元件
  const seen = new Set<string>();
  const comps: string[][] = [];
  for (const c of [...d.concepts].sort((a, b) => cmp(a.id, b.id))) {
    if (seen.has(c.id)) continue;
    const comp: string[] = [];
    const stack = [c.id];
    seen.add(c.id);
    while (stack.length) {
      const id = stack.pop()!;
      comp.push(id);
      for (const n of adj.get(id)!.keys()) if (!seen.has(n)) (seen.add(n), stack.push(n));
    }
    comps.push(comp);
  }
  const better = (a: string, b: string) => nodeOf.get(b)!.score - nodeOf.get(a)!.score || cmp(a, b); // 負 = a 較前
  const rooted = comps.map((comp) => ({ comp, root: [...comp].sort(better)[0] }));
  rooted.sort((x, y) => better(x.root, y.root));

  const shownComps = rooted.slice(0, MINDMAP_MAX_ROOTS);
  const rest = rooted.slice(MINDMAP_MAX_ROOTS);

  const groups: MindGroup[] = shownComps.map(({ comp, root }, i) => {
    // BFS 深度
    const depth = new Map<string, number>([[root, 0]]);
    const queue = [root];
    for (let h = 0; h < queue.length; h++) {
      const id = queue[h];
      for (const n of [...adj.get(id)!.keys()].sort(cmp)) if (!depth.has(n)) (depth.set(n, depth.get(id)! + 1), queue.push(n));
    }
    // 父節點：深度少 1 的鄰居中，邊權重最大者（同權重取 id 較小者）
    const children = new Map<string, string[]>();
    for (const id of comp) {
      if (id === root) continue;
      let parent = "";
      let bestW = -Infinity;
      for (const [n, w] of [...adj.get(id)!.entries()].sort((a, b) => cmp(a[0], b[0]))) {
        if (depth.get(n) !== depth.get(id)! - 1) continue;
        if (w > bestW) (bestW = w, (parent = n));
      }
      (children.get(parent) ?? children.set(parent, []).get(parent)!).push(id);
    }
    let shown = 0;
    const build = (id: string): MindNode => {
      shown++;
      const c = nodeOf.get(id)!;
      const dep = depth.get(id)!;
      const kids = (children.get(id) ?? []).sort(
        (a, b) => adj.get(id)!.get(b)! - adj.get(id)!.get(a)! || nodeOf.get(b)!.score - nodeOf.get(a)!.score || cmp(a, b),
      );
      const visible = dep >= MINDMAP_MAX_DEPTH ? [] : kids.slice(0, MINDMAP_MAX_BRANCH);
      return {
        id,
        label: c.label,
        heuristic: c.heuristic,
        score: c.score,
        freq: c.freq,
        depth: dep,
        children: visible.map(build),
        hiddenChildren: kids.length - visible.length,
      };
    };
    const tree = build(root);
    return { index: i + 1, root: tree, size: comp.length, shown, hidden: comp.length - shown };
  });

  return { groups, omittedGroups: rest.length, omittedConcepts: rest.reduce((s, r) => s + r.comp.length, 0) };
}

/** 節點展開時顯示的原文：最多 max 句含該概念的句子（quote + 文件名） */
export function mindNodeQuotes(d: Digest, conceptId: string, max = 2): Segment[][] {
  const out: Segment[][] = [];
  const used = new Set<DigestSentence>();
  for (let i = 0; i < max; i++) {
    const s = representativeSentence(d, conceptId, used);
    if (!s) break;
    used.add(s);
    out.push([
      { kind: "quote", docId: s.docId, start: s.start, end: s.end, text: s.text },
      { kind: "frame", text: " " },
      { kind: "frame", text: "（" },
      { kind: "ref", docId: s.docId, text: s.docName },
      { kind: "frame", text: "）" },
    ]);
  }
  return out;
}

/** 心智圖的「內容行」片段（Markdown 與驗證共用）。每行 = 一個節點。 */
export function mindmapLines(m: Mindmap): Segment[][] {
  const lines: Segment[][] = [];
  const walk = (n: MindNode, depth: number) => {
    const line: Segment[] = [{ kind: "frame", text: `${"  ".repeat(depth)}- ` }, { kind: "term", text: n.label }];
    if (n.heuristic) line.push({ kind: "frame", text: "（人名 heuristic）" });
    if (n.hiddenChildren > 0) line.push({ kind: "frame", text: `（還有 ${n.hiddenChildren} 個未顯示）` });
    lines.push(line);
    n.children.forEach((c) => walk(c, depth + 1));
  };
  m.groups.forEach((g) => walk(g.root, 0));
  return lines;
}

/** Markdown：每個群組一個標題與縮排條列（term 經 Markdown 跳脫；frame 不跳脫） */
export function mindmapToMarkdown(m: Mindmap): string {
  const out: string[] = ["# 心智圖", "", `> ${DIGEST_NOTE}`, ""];
  if (!m.groups.length) {
    out.push("- 沒有概念可用，無法產生心智圖。");
    return out.join("\n") + "\n";
  }
  for (const g of m.groups) {
    out.push(`## 群組 ${g.index}`, "");
    for (const line of mindmapLines({ groups: [g], omittedGroups: 0, omittedConcepts: 0 })) out.push(segmentsToText(line, { escape: escapeMarkdown }));
    out.push("");
  }
  if (m.omittedGroups > 0) out.push("## 說明", "", `- 另有 ${m.omittedGroups} 個群組（共 ${m.omittedConcepts} 個概念）未顯示（最多顯示 ${MINDMAP_MAX_ROOTS} 個群組）。`);
  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}
