import type { MindGroup, MindNode } from "./mindmap";

/**
 * 可摺疊樹的狀態與鍵盤互動（純函式，Node 可測）。對應 WAI-ARIA tree pattern：
 *   ↓ / ↑  移到下一個 / 上一個「可見」節點
 *   →      已收合 → 展開；已展開 → 移到第一個子節點；葉節點不動
 *   ←      已展開 → 收合；否則移到父節點
 *   Home / End  第一個 / 最後一個可見節點
 *   Enter / Space  切換「顯示原文」的選取
 */
export interface TreeState {
  expanded: ReadonlySet<string>;
  focus: string | null;
  /** 目前打開、顯示原文的節點 */
  selected: string | null;
  /** 已經見過（並套用過「預設展開」）的根；之後才出現的新根會預設展開，使用者自己收合的根不會被重新展開 */
  seenRoots: ReadonlySet<string>;
}

export type TreeKey = "ArrowDown" | "ArrowUp" | "ArrowRight" | "ArrowLeft" | "Home" | "End" | "Enter" | " ";

export interface FlatItem {
  node: MindNode;
  /** 0 起算；與群組根的深度一致 */
  level: number;
  parent: string | null;
  groupIndex: number;
}

/** 依目前展開狀態攤平成「可見」的清單（群組依序，根永遠可見） */
export function visibleItems(groups: readonly MindGroup[], expanded: ReadonlySet<string>): FlatItem[] {
  const out: FlatItem[] = [];
  const walk = (n: MindNode, level: number, parent: string | null, g: number) => {
    out.push({ node: n, level, parent, groupIndex: g });
    if (n.children.length && expanded.has(n.id)) n.children.forEach((c) => walk(c, level + 1, n.id, g));
  };
  groups.forEach((g) => walk(g.root, 0, null, g.index));
  return out;
}

/** 初始狀態：每個群組的根展開（第一層可見），焦點在第一個根 */
export function initialTreeState(groups: readonly MindGroup[]): TreeState {
  const roots = groups.map((g) => g.root.id);
  return { expanded: new Set(roots), focus: roots[0] ?? null, selected: null, seenRoots: new Set(roots) };
}

export function toggleExpanded(s: TreeState, id: string): TreeState {
  const next = new Set(s.expanded);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return { ...s, expanded: next };
}

/** 資料變動（語料更新）後，移除已不存在的節點，避免焦點 / 選取指向消失的節點 */
export function reconcile(s: TreeState, groups: readonly MindGroup[]): TreeState {
  const all = new Set<string>();
  const walk = (n: MindNode) => (all.add(n.id), n.children.forEach(walk));
  groups.forEach((g) => walk(g.root));
  const expanded = new Set([...s.expanded].filter((id) => all.has(id)));
  const seenRoots = new Set([...s.seenRoots].filter((id) => all.has(id)));
  // 資料變動後才出現的新根（例如一開始是空的、之後才匯入文件）：預設展開
  for (const g of groups) if (!seenRoots.has(g.root.id)) (seenRoots.add(g.root.id), expanded.add(g.root.id));
  const first = groups[0]?.root.id ?? null;
  return { expanded, seenRoots, focus: s.focus && all.has(s.focus) ? s.focus : first, selected: s.selected && all.has(s.selected) ? s.selected : null };
}

export function reduceKey(s: TreeState, key: TreeKey, groups: readonly MindGroup[]): TreeState {
  const items = visibleItems(groups, s.expanded);
  if (!items.length) return s;
  let i = items.findIndex((x) => x.node.id === s.focus);
  if (i < 0) i = 0;
  const cur = items[i];
  const hasKids = cur.node.children.length > 0;
  const open = s.expanded.has(cur.node.id);
  const focusAt = (j: number): TreeState => ({ ...s, focus: items[Math.max(0, Math.min(items.length - 1, j))].node.id });
  switch (key) {
    case "ArrowDown":
      return focusAt(i + 1);
    case "ArrowUp":
      return focusAt(i - 1);
    case "Home":
      return focusAt(0);
    case "End":
      return focusAt(items.length - 1);
    case "ArrowRight":
      if (hasKids && !open) return toggleExpanded({ ...s, focus: cur.node.id }, cur.node.id);
      if (hasKids && open) return focusAt(i + 1); // 展開狀態下，下一個可見節點就是第一個子節點
      return { ...s, focus: cur.node.id };
    case "ArrowLeft":
      if (hasKids && open) return toggleExpanded({ ...s, focus: cur.node.id }, cur.node.id);
      if (cur.parent) return { ...s, focus: cur.parent };
      return { ...s, focus: cur.node.id };
    case "Enter":
    case " ":
      return { ...s, focus: cur.node.id, selected: s.selected === cur.node.id ? null : cur.node.id };
  }
}
