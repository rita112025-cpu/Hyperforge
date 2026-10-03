"use client";
import { useEffect, useMemo, useReducer, useRef } from "react";
import type { Digest } from "../lib/outputs/digest";
import { MINDMAP_MAX_BRANCH, MINDMAP_MAX_DEPTH, MINDMAP_MAX_ROOTS, mindNodeQuotes, type Mindmap } from "../lib/outputs/mindmap";
import { initialTreeState, reconcile, reduceKey, toggleExpanded, visibleItems, type TreeKey, type TreeState } from "../lib/outputs/tree-state";
import SegmentLine from "./SegmentLine";

/**
 * 心智圖（可摺疊樹）。節點標籤只是 term（抽取得來），點開（Enter / Space / 點擊）才顯示原文 quote。
 * WAI-ARIA tree：role=tree / treeitem、aria-level / aria-expanded / aria-selected、roving tabindex；
 * 鍵盤：↑↓ 移動、→ 展開或進入第一個子節點、← 收合或回到父節點、Home / End、Enter / Space 顯示原文。
 * 互動邏輯（reducer）在 lib/outputs/tree-state.ts，是純函式。
 */
type Action = { type: "key"; key: TreeKey } | { type: "toggle"; id: string } | { type: "focus"; id: string } | { type: "select"; id: string } | { type: "reconcile" };

export interface MindmapViewProps {
  mindmap: Mindmap;
  digest: Digest;
}

const KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End", "Enter", " "]);

export default function MindmapView({ mindmap, digest }: MindmapViewProps) {
  const groups = mindmap.groups;
  const [state, dispatch] = useReducer(
    (s: TreeState, a: Action): TreeState => {
      switch (a.type) {
        case "key":
          return reduceKey(s, a.key, groups);
        case "toggle":
          return toggleExpanded({ ...s, focus: a.id }, a.id);
        case "focus":
          return s.focus === a.id ? s : { ...s, focus: a.id };
        case "select":
          return { ...s, focus: a.id, selected: s.selected === a.id ? null : a.id };
        case "reconcile":
          return reconcile(s, groups);
      }
    },
    groups,
    initialTreeState,
  );
  const items = useMemo(() => visibleItems(groups, state.expanded), [groups, state.expanded]);
  const rootRef = useRef<HTMLUListElement>(null);
  const fromKeyboard = useRef(false);

  // 語料變動後移除已消失的節點
  useEffect(() => {
    dispatch({ type: "reconcile" });
  }, [groups]);

  // 鍵盤移動焦點後，把 DOM 焦點移到對應的 treeitem（滑鼠點擊不搶焦點）
  useEffect(() => {
    if (!fromKeyboard.current || !state.focus) return;
    rootRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(state.focus)}"]`)?.focus();
  }, [state.focus, state.expanded]);

  const selectedNode = state.selected ? items.find((x) => x.node.id === state.selected)?.node : undefined;
  const quotes = useMemo(() => (selectedNode ? mindNodeQuotes(digest, selectedNode.id) : []), [selectedNode, digest]);

  if (!groups.length) return <div className="text-xs text-zinc-500">沒有概念可用，無法產生心智圖。</div>;

  // 每個同層（同 parent）內的位置，供 aria-posinset / aria-setsize
  const siblings = new Map<string | null, string[]>();
  for (const it of items) (siblings.get(it.parent ?? `root:${it.groupIndex}`) ?? siblings.set(it.parent ?? `root:${it.groupIndex}`, []).get(it.parent ?? `root:${it.groupIndex}`)!).push(it.node.id);

  return (
    <div className="space-y-2" data-testid="mindmap">
      <div className="text-[10px] text-zinc-500" data-testid="mindmap-rules">
        規則：每個連通群組以分數最高的概念為根；依最強共現邊決定性展開，深度 ≤ {MINDMAP_MAX_DEPTH}、每層 ≤ {MINDMAP_MAX_BRANCH} 個分支，最多 {MINDMAP_MAX_ROOTS} 個群組；略過的以「還有 N 個未顯示」標示。↑↓ 移動，→ 展開，← 收合，Enter 顯示原文。
      </div>
      <ul
        ref={rootRef}
        role="tree"
        aria-label="心智圖（概念樹）"
        className="space-y-0.5 text-xs text-zinc-200"
        onKeyDown={(e) => {
          if (!KEYS.has(e.key)) return;
          e.preventDefault();
          fromKeyboard.current = true;
          dispatch({ type: "key", key: e.key as TreeKey });
        }}
        data-testid="mindmap-tree"
      >
        {items.map((it, idx) => {
          const n = it.node;
          const hasKids = n.children.length > 0;
          const isOpen = state.expanded.has(n.id);
          const sib = siblings.get(it.parent ?? `root:${it.groupIndex}`)!;
          const g = groups[it.groupIndex - 1];
          const startsGroup = it.level === 0;
          return (
            <li key={n.id} role="none">
              {startsGroup && it.groupIndex > 1 && idx > 0 && (
                <div className="mt-2 text-[10px] uppercase tracking-wider text-zinc-500" data-testid="mindmap-group-label">
                  其他群組 {it.groupIndex}
                </div>
              )}
              <div
                role="treeitem"
                aria-level={it.level + 1}
                aria-posinset={sib.indexOf(n.id) + 1}
                aria-setsize={sib.length}
                aria-expanded={hasKids ? isOpen : undefined}
                aria-selected={state.selected === n.id}
                tabIndex={state.focus === n.id ? 0 : -1}
                data-node-id={n.id}
                style={{ paddingLeft: `${it.level * 14}px` }}
                className={`flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan ${state.selected === n.id ? "bg-violet-500/20" : "hover:bg-white/5"}`}
                onFocus={() => dispatch({ type: "focus", id: n.id })}
                onClick={() => {
                  fromKeyboard.current = false;
                  dispatch({ type: "select", id: n.id });
                }}
                data-testid="mindmap-node"
              >
                <span
                  aria-hidden="true"
                  className="w-3 shrink-0 text-zinc-500"
                  onClick={(e) => {
                    if (!hasKids) return;
                    e.stopPropagation();
                    fromKeyboard.current = false;
                    dispatch({ type: "toggle", id: n.id });
                  }}
                >
                  {hasKids ? (isOpen ? "▾" : "▸") : "·"}
                </span>
                <span className="text-violet-200">{n.label}</span>
                {n.heuristic && <span className="text-[10px] text-amber-300/80">（人名 heuristic）</span>}
                {n.hiddenChildren > 0 && (!hasKids || isOpen) && (
                  <span className="text-[10px] text-zinc-500" data-testid="mindmap-hidden">
                    （還有 {n.hiddenChildren} 個未顯示）
                  </span>
                )}
                {startsGroup && g.hidden > 0 && <span className="text-[10px] text-zinc-600">［群組內共 {g.hidden} 個未顯示］</span>}
              </div>
            </li>
          );
        })}
      </ul>
      {mindmap.omittedGroups > 0 && (
        <div className="text-[10px] text-amber-300/80" data-testid="mindmap-omitted">
          另有 {mindmap.omittedGroups} 個群組（共 {mindmap.omittedConcepts} 個概念）未顯示（最多顯示 {MINDMAP_MAX_ROOTS} 個群組）。
        </div>
      )}
      {selectedNode && (
        <div className="space-y-1 rounded border border-white/10 bg-black/30 p-2" data-testid="mindmap-quotes">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">原文：{selectedNode.label}</div>
          {quotes.length ? quotes.map((q, i) => <SegmentLine key={i} segments={q} />) : <div className="text-zinc-500">沒有可引用的原文句子（內容太長沒有標點、或句子太短）。</div>}
        </div>
      )}
    </div>
  );
}
