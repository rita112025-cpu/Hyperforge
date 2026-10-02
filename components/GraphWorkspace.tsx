"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ALCHEMY_BADGE, MIN_ALCHEMY_PARENTS, composeModel, defaultAlchemyName, makeAlchemyNode } from "../lib/graph/alchemy";
import { buildGraph, dedupeDocuments } from "../lib/graph/build";
import { GraphController, type SelectionChange } from "../lib/graph/controller";
import { loadCorpus } from "../lib/graph/corpus";
import { EXTRACT_METHOD_NOTE, PERSON_METHOD_NOTE } from "../lib/graph/extract";
import type { GraphDocument, GraphNode } from "../lib/graph/types";
import { useForge } from "../lib/store";
import { getSharedDb } from "../lib/vector/shared-db";
import { probeVectorStatus, type VectorStatus } from "../lib/vector/status";
import GraphCanvas, { type CanvasContextMenuEvent } from "./GraphCanvas";
import SourcePanel from "./SourcePanel";

type DbState = { state: "loading" } | { state: "ok"; count: number } | { state: "error"; message: string };

/**
 * 圖譜工作區。資料來源（兩條路徑都只依賴文件文字，不依賴向量）：
 *   即時：useForge.docs（job 完成時的記憶體結果）
 *   reload：IndexedDB 內已持久化的 docs / chunks（loadCorpus，不初始化 embedder）
 * 向量 / 語意功能狀態只是狀態列上的資訊（probeVectorStatus 只對同源模型檔發 HEAD），畫布不等待它。
 */
export default function GraphWorkspace() {
  const live = useForge((s) => s.docs);
  const lastIndexed = useForge((s) => {
    const j = s.jobs.find((x) => x.context);
    return j?.context ? j.context.indexed : undefined;
  });

  const [controller] = useState(() => new GraphController());
  const [persisted, setPersisted] = useState<GraphDocument[]>([]);
  const [db, setDb] = useState<DbState>({ state: "loading" });
  const [vector, setVector] = useState<VectorStatus | null>(null);
  const [temps, setTemps] = useState<GraphNode[]>([]);
  const [sel, setSel] = useState<SelectionChange>({ ids: [], focusId: null });
  const [menu, setMenu] = useState<CanvasContextMenuEvent | null>(null);
  const [naming, setNaming] = useState<{ parents: string[] } | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [boxMode, setBoxMode] = useState(false);
  const [e2e, setE2e] = useState(false);
  const pendingSelect = useRef<string | null>(null);
  const menuEl = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setE2e(new URLSearchParams(window.location.search).has("e2e"));
  }, []);

  // reload 來源：只讀 docs / chunks 兩張表，不建立 embedder、不呼叫 getVectorStore
  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const docs = await loadCorpus(getSharedDb());
        if (off) return;
        setPersisted(docs);
        setDb({ state: "ok", count: docs.length });
      } catch (e) {
        if (!off) setDb({ state: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      off = true;
    };
  }, []);

  useEffect(() => {
    let off = false;
    void probeVectorStatus().then((s) => {
      if (!off) setVector(s);
    });
    return () => {
      off = true;
    };
  }, []);

  const allDocs = useMemo(() => [...persisted, ...live], [persisted, live]);
  const base = useMemo(() => buildGraph(allDocs), [allDocs]);
  const model = useMemo(() => composeModel(base, temps), [base, temps]);
  const docsById = useMemo(() => new Map(dedupeDocuments(allDocs).map((d) => [d.id, d])), [allDocs]);
  const nodeById = useMemo(() => new Map(model.nodes.map((n) => [n.id, n])), [model]);

  useEffect(() => {
    controller.onSelectionChange = setSel;
    return () => {
      controller.onSelectionChange = null;
    };
  }, [controller]);

  useEffect(() => {
    controller.boxMode = boxMode;
    controller.markDirty();
  }, [controller, boxMode]);

  // 暫存節點建立後選取它（子層 GraphCanvas 的 setGraph effect 先於此 effect 執行）
  useEffect(() => {
    const id = pendingSelect.current;
    if (id && controller.indexOfId(id) >= 0) {
      pendingSelect.current = null;
      controller.select([id]);
    }
  }, [controller, model]);

  // Esc：關閉選單 / 命名框；沒有選單時清除選取
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (menu || naming) {
        setMenu(null);
        setNaming(null);
      } else controller.clearSelection();
    };
    // App Router 的 React root 就是 document：這個 listener 與 React 的事件委派在同一個節點，
    // stopPropagation 擋不住它，所以必須自己判斷事件是否發生在選單內，否則選單會在 click 之前被卸載。
    const onDown = (e: PointerEvent) => {
      if (menuEl.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [controller, menu, naming]);

  const focusNode = sel.focusId ? (nodeById.get(sel.focusId) ?? null) : null;
  const realSelected = useMemo(() => sel.ids.flatMap((id) => (nodeById.get(id) && !nodeById.get(id)!.temporary ? [id] : [])), [sel.ids, nodeById]);
  const stats = base.stats;
  const hasDocs = stats.docCount > 0;
  const nothingToShow = model.nodes.length === 0;

  const parentsOfNaming = naming ? naming.parents.flatMap((id) => (nodeById.get(id) ? [nodeById.get(id)!] : [])) : [];
  const submitAlchemy = () => {
    const node = makeAlchemyNode(parentsOfNaming, nameInput);
    if (node) {
      pendingSelect.current = node.id;
      setTemps((prev) => (prev.some((t) => t.id === node.id) ? prev : [...prev, node]));
    }
    setNaming(null);
    setNameInput("");
  };

  return (
    <section className="space-y-3" aria-label="Infinite Alchemy Canvas">
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs" data-testid="graph-toolbar">
        <button
          className="rounded border border-white/15 px-2 py-1 text-zinc-200 hover:border-violet-300"
          onClick={() => controller.fit()}
          data-testid="fit-button"
        >
          適合畫面
        </button>
        <button
          className={`rounded border px-2 py-1 ${boxMode ? "border-neon-cyan text-neon-cyan" : "border-white/15 text-zinc-300 hover:border-violet-300"}`}
          aria-pressed={boxMode}
          onClick={() => setBoxMode((v) => !v)}
          data-testid="boxmode-toggle"
        >
          框選模式：{boxMode ? "開" : "關"}
        </button>
        <span className="text-zinc-500">空白處拖曳＝平移 · Shift+拖曳＝框選 · 滾輪＝縮放 · 拖節點＝移動 · 右鍵＝煉成新概念</span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="relative h-[560px] overflow-hidden rounded-xl border border-white/10 bg-zinc-950" data-testid="graph-stage">
          <GraphCanvas controller={controller} model={model} onContextMenu={setMenu} e2e={e2e} />

          {nothingToShow && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8 text-center text-xs text-zinc-500" data-testid="graph-empty">
              {hasDocs
                ? `已載入 ${stats.docCount} 份文件，但沒有任何詞達到證據門檻（詞至少出現 2 次、文件需有足夠長度；過短文件 ${stats.skippedDocCount} 份），所以沒有概念可顯示。`
                : "尚無內容。拖入文字檔或貼上文字後，概念會浮現在這裡。"}
            </div>
          )}

          {menu && (
            <div
              ref={menuEl}
              role="menu"
              className="absolute z-20 min-w-44 rounded-lg border border-white/15 bg-zinc-900 p-1 font-mono text-xs shadow-xl"
              style={{ left: Math.min(menu.x, 520), top: Math.min(menu.y, 480) }}
              data-testid="canvas-menu"
            >
              <button
                role="menuitem"
                disabled={realSelected.length < MIN_ALCHEMY_PARENTS}
                className="block w-full rounded px-2 py-1 text-left text-zinc-100 hover:bg-white/10 disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent"
                onClick={() => {
                  const parents = realSelected;
                  setMenu(null);
                  setNameInput("");
                  setNaming({ parents });
                }}
                data-testid="menu-alchemy"
              >
                煉成新概念{realSelected.length >= MIN_ALCHEMY_PARENTS ? `（${realSelected.length} 個節點）` : ""}
              </button>
              {realSelected.length < MIN_ALCHEMY_PARENTS && (
                <div className="px-2 pb-1 text-[10px] text-zinc-500">需先選取 2 個以上節點（Shift+點擊或框選）</div>
              )}
            </div>
          )}

          {naming && (
            <form
              className="absolute left-1/2 top-4 z-30 w-80 -translate-x-1/2 space-y-2 rounded-lg border border-white/15 bg-zinc-900 p-3 font-mono text-xs shadow-xl"
              onSubmit={(e) => {
                e.preventDefault();
                submitAlchemy();
              }}
              data-testid="alchemy-form"
            >
              <div className="text-zinc-300">
                煉成新概念（{parentsOfNaming.length} 個來源）
                <span className="ml-1 text-zinc-500">本機暫存 · 不呼叫 AI · 不寫入 IndexedDB</span>
              </div>
              <input
                autoFocus
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder={defaultAlchemyName(parentsOfNaming)}
                className="w-full rounded border border-white/15 bg-black/40 px-2 py-1 text-zinc-100 outline-none focus:border-neon-cyan"
                data-testid="alchemy-name"
              />
              <div className="flex justify-end gap-2">
                <button type="button" className="rounded border border-white/15 px-2 py-1 text-zinc-400" onClick={() => setNaming(null)}>
                  取消
                </button>
                <button type="submit" className="rounded border border-neon-cyan px-2 py-1 text-neon-cyan" data-testid="alchemy-submit">
                  建立（{ALCHEMY_BADGE}）
                </button>
              </div>
            </form>
          )}
        </div>

        <SourcePanel
          node={focusNode}
          evidence={focusNode ? base.evidence[focusNode.id] : undefined}
          docs={docsById}
          selectedCount={sel.ids.length}
          parentLabels={focusNode?.parents?.map((id) => nodeById.get(id)?.label ?? id)}
        />
      </div>

      <div className="space-y-1 font-mono text-[11px] text-zinc-500" data-testid="graph-status">
        <div data-testid="graph-counts">
          文件 {stats.docCount} 份 · 概念 {stats.shownNodes} 個 · 連線 {stats.shownEdges} 條
          {temps.length > 0 && ` · ${ALCHEMY_BADGE}節點 ${model.nodes.filter((n) => n.temporary).length} 個`}
          {stats.skippedDocCount > 0 && ` · ${stats.skippedDocCount} 份文件過短，未納入分析`}
        </div>
        {stats.nodesTruncated && (
          <div className="text-amber-300/90" data-testid="truncation-notice">
            顯示前 {stats.nodeCap} 個概念（共 {stats.totalConcepts} 個，其餘依分數未顯示）
          </div>
        )}
        {stats.edgesTruncated && (
          <div className="text-amber-300/90" data-testid="edge-truncation-notice">
            顯示前 {stats.edgeCap} 條連線（共 {stats.totalEdges} 條，其餘依權重未顯示）
          </div>
        )}
        <div data-testid="graph-source">
          資料來源：本次匯入（記憶體）{live.length} 份 ·{" "}
          {db.state === "loading" && "IndexedDB 載入中…"}
          {db.state === "ok" && `IndexedDB 已載入 ${db.count} 份文字`}
          {db.state === "error" && <span className="text-red-400">IndexedDB 讀取失敗：{db.message}（畫布只顯示本次匯入的內容）</span>}
          {" "}· 圖譜只依賴文件文字，不依賴向量
        </div>
        <div data-testid="vector-status">
          向量／語意功能：
          {vector === null
            ? "檢查中…"
            : vector.state === "AVAILABLE"
              ? `AVAILABLE（${vector.detail}）`
              : `UNAVAILABLE（${vector.detail}）· 不影響畫布`}
          {lastIndexed === false && " · 最近一次匯入：向量化略過（PARTIAL）"}
          {lastIndexed === true && " · 最近一次匯入：已向量化"}
        </div>
        <div>
          中文概念：{EXTRACT_METHOD_NOTE}；人名：{PERSON_METHOD_NOTE}。連線 = 同一句話內共同出現（co-occurrence）。
        </div>
      </div>

      {/* 無障礙：Canvas 內容的文字替代（React 文字節點） */}
      <ul className="sr-only" aria-label="圖譜節點清單">
        {model.nodes.map((n) => (
          <li key={n.id}>{n.label}</li>
        ))}
      </ul>
    </section>
  );
}
