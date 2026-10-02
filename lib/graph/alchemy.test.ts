import { describe, expect, it } from "vitest";
import { ALCHEMY_BADGE, composeModel, defaultAlchemyName, makeAlchemyNode, normalizeAlchemyName } from "./alchemy";
import { buildGraph } from "./build";
import type { GraphDocument } from "./types";

const text = "alpha bravo charlie. alpha bravo. charlie alpha. delta echo. delta echo.";
const docs: GraphDocument[] = [{ id: "d", name: "d", rawText: text, chunks: [{ index: 0, start: 0, end: text.length }] }];
const base = () => buildGraph(docs);
const pick = (g: ReturnType<typeof base>, ...keys: string[]) => keys.map((k) => g.nodes.find((n) => n.key === k)!);

describe("makeAlchemyNode（本機暫存，不呼叫 LLM）", () => {
  it("預設名稱為 A × B（依 id 排序，決定性）", () => {
    const g = base();
    const n = makeAlchemyNode(pick(g, "bravo", "alpha"))!;
    expect(n.label).toBe("alpha × bravo");
    expect(defaultAlchemyName(pick(g, "bravo", "alpha"))).toBe("alpha × bravo");
  });

  it("標記為暫存：kind=temp、temporary=true、shape=hexagon；badge 文字為「暫存」", () => {
    const n = makeAlchemyNode(pick(base(), "alpha", "bravo"))!;
    expect(n).toMatchObject({ kind: "temp", temporary: true, shape: "hexagon", heuristic: false });
    expect(n.id.startsWith("temp:")).toBe(true);
    expect(ALCHEMY_BADGE).toBe("暫存");
  });

  it("可用使用者輸入的名稱；空白名稱退回預設；名稱被正規化並限長", () => {
    const g = base();
    expect(makeAlchemyNode(pick(g, "alpha", "bravo"), "  我的  新概念 ")!.label).toBe("我的 新概念");
    expect(makeAlchemyNode(pick(g, "alpha", "bravo"), "   ")!.label).toBe("alpha × bravo");
    expect(Array.from(normalizeAlchemyName("x".repeat(100))!).length).toBe(40);
  });

  it("少於 2 個來源節點回傳 null；暫存節點本身不能當來源", () => {
    const g = base();
    expect(makeAlchemyNode(pick(g, "alpha"))).toBeNull();
    expect(makeAlchemyNode([])).toBeNull();
    const t = makeAlchemyNode(pick(g, "alpha", "bravo"))!;
    expect(makeAlchemyNode([t, ...pick(g, "alpha")])).toBeNull();
  });

  it("id 決定性：同來源 + 同名稱得同 id（不重複），不同名稱得不同 id", () => {
    const g = base();
    const a = makeAlchemyNode(pick(g, "alpha", "bravo"))!;
    const b = makeAlchemyNode(pick(g, "bravo", "alpha"))!;
    const c = makeAlchemyNode(pick(g, "alpha", "bravo"), "別名")!;
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
  });

  it("三個以上來源的預設名稱會縮寫", () => {
    const n = makeAlchemyNode(pick(base(), "alpha", "bravo", "charlie", "delta"))!;
    expect(n.label).toBe("alpha × bravo × charlie × …(+1)");
  });
});

describe("composeModel", () => {
  it("併入暫存節點與 alchemy 邊；不修改原圖；不影響 stats 的節點上限計數", () => {
    const g = base();
    const t = makeAlchemyNode(pick(g, "alpha", "bravo"))!;
    const before = JSON.stringify(g);
    const m = composeModel(g, [t]);
    expect(JSON.stringify(g)).toBe(before);
    expect(m.nodes).toHaveLength(g.nodes.length + 1);
    const alchemyEdges = m.edges.filter((e) => e.kind === "alchemy");
    expect(alchemyEdges.map((e) => e.b).sort()).toEqual(t.parents!.slice().sort());
    expect(m.stats).toEqual(g.stats);
  });

  it("來源節點全部消失時，暫存節點被丟棄；部分消失時只連仍存在者", () => {
    const g = base();
    const t = makeAlchemyNode(pick(g, "alpha", "bravo"))!;
    const none = composeModel({ ...g, nodes: g.nodes.filter((n) => n.key !== "alpha" && n.key !== "bravo") }, [t]);
    expect(none.nodes.some((n) => n.temporary)).toBe(false);
    const some = composeModel({ ...g, nodes: g.nodes.filter((n) => n.key !== "alpha") }, [t]);
    expect(some.edges.filter((e) => e.kind === "alchemy")).toHaveLength(1);
  });

  it("暫存節點只存在記憶體：本模組不 import Dexie / IndexedDB", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./alchemy.ts", import.meta.url), "utf8");
    expect([...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1])).toEqual(["./seed", "./types"]);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
    expect(code).not.toMatch(/indexedDB|dexie|localStorage/i);
  });
});
