import { hash53, seededPosition } from "./seed";
import type { GraphEdge, GraphModel, GraphNode } from "./types";

/**
 * 本輪「煉成新概念」只是本機暫存操作：決定性規則命名（或使用者輸入名稱），不呼叫 AI / LLM，
 * 不寫入 IndexedDB，重新整理即消失。
 */

export const ALCHEMY_BADGE = "暫存";
export const MIN_ALCHEMY_PARENTS = 2;
const MAX_NAME_CHARS = 40;
const MAX_LABEL_PARENTS = 3;

export function defaultAlchemyName(parents: GraphNode[]): string {
  const labels = [...parents].sort((a, b) => (a.id < b.id ? -1 : 1)).map((p) => p.label);
  const head = labels.slice(0, MAX_LABEL_PARENTS).join(" × ");
  return labels.length > MAX_LABEL_PARENTS ? `${head} × …(+${labels.length - MAX_LABEL_PARENTS})` : head;
}

export function normalizeAlchemyName(name: string | undefined): string | undefined {
  const t = (name ?? "").replace(/\s+/g, " ").trim();
  return t ? Array.from(t).slice(0, MAX_NAME_CHARS).join("") : undefined;
}

/** 少於 2 個節點、或選到暫存節點本身時回傳 null。id 決定性：同一組來源 + 同名稱 → 同一個 id（重複煉成不會產生重複節點）。 */
export function makeAlchemyNode(parents: GraphNode[], name?: string): GraphNode | null {
  const real = parents.filter((p) => !p.temporary);
  if (real.length < MIN_ALCHEMY_PARENTS) return null;
  const sorted = [...real].sort((a, b) => (a.id < b.id ? -1 : 1));
  const label = normalizeAlchemyName(name) ?? defaultAlchemyName(sorted);
  const id = `temp:${hash53(`${sorted.map((p) => p.id).join("|")}#${label}`).toString(36)}`;
  const pos = seededPosition(id);
  const r = sorted.reduce((s, p) => s + p.r, 0) / sorted.length;
  return {
    id,
    key: label,
    label,
    kind: "temp",
    shape: "hexagon",
    heuristic: false,
    temporary: true,
    score: sorted.reduce((s, p) => s + p.score, 0) / sorted.length,
    freq: 0,
    docFreq: 0,
    chunkFreq: 0,
    x: pos.x,
    y: pos.y,
    r: Math.max(r, 12),
    parents: sorted.map((p) => p.id),
  };
}

/** 把暫存節點併入圖譜：只保留至少還有一個來源節點存在者；以 alchemy 邊連回來源。 */
export function composeModel(base: GraphModel, temps: GraphNode[]): GraphModel {
  if (!temps.length) return base;
  const present = new Set(base.nodes.map((n) => n.id));
  const nodes = [...base.nodes];
  const edges: GraphEdge[] = [...base.edges];
  for (const t of temps) {
    const live = (t.parents ?? []).filter((p) => present.has(p));
    if (!live.length || present.has(t.id)) continue;
    nodes.push(t);
    present.add(t.id);
    for (const p of live) edges.push({ id: `alchemy:${t.id}>${p}`, a: t.id, b: p, weight: 1, kind: "alchemy" });
  }
  return { ...base, nodes, edges };
}
