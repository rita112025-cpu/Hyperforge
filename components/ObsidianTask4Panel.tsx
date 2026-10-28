"use client";

import { useEffect, useMemo, useState } from "react";
import { GraphController } from "../lib/graph/controller";
import type { GraphDocument, GraphModel } from "../lib/graph/types";
import { buildDigest } from "../lib/outputs/digest";
import { copyText, downloadText } from "../lib/outputs/export";
import GraphCanvas from "./GraphCanvas";
import OutputsPanel, { type OutputsTabId } from "./OutputsPanel";
import SegmentLine from "./SegmentLine";
import { SourceJumpProvider, type SourceJump } from "./SourceJumpContext";

type WorkflowTab = "deconstruct" | "recombine" | "monetize" | "execute";

const WORKFLOWS: ReadonlyArray<{ id: WorkflowTab; label: string; detail: string }> = [
  { id: "deconstruct", label: "解構", detail: "核心摘要" },
  { id: "recombine", label: "重組", detail: "圖譜 · 心智圖" },
  { id: "monetize", label: "變現", detail: "簡報 · Threads" },
  { id: "execute", label: "執行", detail: "Notion · 72H" },
];

const OUTPUT_TABS: Record<WorkflowTab, readonly OutputsTabId[]> = {
  deconstruct: ["summary"],
  recombine: ["mindmap"],
  monetize: ["slides", "threads"],
  execute: ["notion"],
};

const CHECKPOINTS = ["24H · 釐清", "48H · 驗證", "72H · 執行"] as const;

function SourceInspector({ docs, source }: { docs: GraphDocument[]; source: SourceJump | null }) {
  const doc = source ? docs.find((candidate) => candidate.id === source.docId) : undefined;
  if (!source || !doc) {
    return (
      <aside className="rounded-xl border border-white/10 bg-black/30 p-4 text-xs text-zinc-500" aria-label="來源檢視器">
        點擊有底線的引句或文件名，即可在這裡核對原文與位移。
      </aside>
    );
  }
  const start = Math.max(0, Math.min(source.start, doc.rawText.length));
  const end = Math.max(start, Math.min(source.end, doc.rawText.length));
  const contextStart = Math.max(0, start - 90);
  const contextEnd = Math.min(doc.rawText.length, end + 90);
  return (
    <aside className="rounded-xl border border-cyan-300/25 bg-cyan-300/[0.04] p-4 text-xs" aria-label="來源檢視器" data-testid="obsidian-source-inspector">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <strong className="text-cyan-100">{doc.name}</strong>
        <span className="font-mono tabular-nums text-zinc-500">[{start}:{end}]</span>
      </div>
      <p className="mt-3 whitespace-pre-wrap break-words leading-6 text-zinc-400">
        {doc.rawText.slice(contextStart, start)}
        <mark className="rounded bg-cyan-300/20 px-0.5 text-cyan-50">{doc.rawText.slice(start, end)}</mark>
        {doc.rawText.slice(end, contextEnd)}
      </p>
    </aside>
  );
}

function Checklist72({ docs, graph }: { docs: GraphDocument[]; graph: GraphModel }) {
  const digest = useMemo(() => buildDigest(docs, graph), [docs, graph]);
  const items = digest.sentences.slice(0, CHECKPOINTS.length);
  const [flash, setFlash] = useState<string | null>(null);
  const markdown = useMemo(() => {
    const lines = ["# 72H Checklist", "", "> 由原文引句衍生；不新增事實。", ""];
    CHECKPOINTS.forEach((checkpoint, index) => {
      const item = items[index];
      lines.push(item ? `- [ ] ${checkpoint}：${item.text}（${item.docName} [${item.start}:${item.end}]）` : `- [ ] ${checkpoint}：沒有足夠的可引用原文`);
    });
    return `${lines.join("\n")}\n`;
  }, [items]);

  return (
    <section className="space-y-3 rounded-xl border border-cyan-300/20 bg-cyan-300/[0.04] p-4" aria-label="72 小時執行清單">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-cyan-100">72H Checklist</h3>
          <p className="mt-1 text-[11px] text-cyan-100/55">固定節點搭配原文引句；不足時照實標示。</p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={async () => setFlash((await copyText(markdown)).ok ? "已複製 Markdown" : "複製失敗")}
            className="rounded border border-cyan-200/30 px-2 py-1 text-cyan-100 transition-colors hover:bg-cyan-200/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
          >
            複製
          </button>
          <button
            type="button"
            onClick={() => setFlash(`已下載 ${downloadText("hyperforge-72h.md", markdown, "text/markdown")}`)}
            className="rounded border border-white/15 px-2 py-1 text-zinc-200 transition-colors hover:border-cyan-200/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
          >
            下載 .md
          </button>
          {flash && <span role="status" className="text-cyan-200">{flash}</span>}
        </div>
      </div>
      <ol className="space-y-2">
        {CHECKPOINTS.map((checkpoint, index) => {
          const item = items[index];
          return (
            <li key={checkpoint} className="grid gap-2 rounded-lg bg-black/20 p-3 sm:grid-cols-[7rem_minmax(0,1fr)]">
              <span className="font-mono text-[11px] text-cyan-200">{checkpoint}</span>
              {item ? (
                <SegmentLine segments={[
                  { kind: "quote", docId: item.docId, start: item.start, end: item.end, text: item.text },
                  { kind: "frame", text: "（" },
                  { kind: "ref", docId: item.docId, text: `${item.docName} [${item.start}:${item.end}]` },
                  { kind: "frame", text: "）" },
                ]} />
              ) : <span className="text-xs text-zinc-500">沒有足夠的可引用原文</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default function ObsidianTask4Panel({ docs, graph }: { docs: GraphDocument[]; graph: GraphModel }) {
  const [tab, setTab] = useState<WorkflowTab>("deconstruct");
  const [source, setSource] = useState<SourceJump | null>(null);
  const [controller] = useState(() => new GraphController());
  const [e2e, setE2e] = useState(false);

  useEffect(() => {
    controller.setGraph(graph.nodes, graph.edges);
  }, [controller, graph]);

  useEffect(() => {
    setE2e(new URLSearchParams(window.location.search).has("e2e"));
  }, []);

  return (
    <SourceJumpProvider onJump={setSource}>
      <section className="mt-6 overflow-hidden rounded-2xl border border-white/10 bg-[#09090d]" aria-label="一鍵七變工作流" data-testid="obsidian-task4">
        <div role="tablist" aria-label="輸出工作流" className="grid grid-cols-2 gap-px border-b border-white/10 bg-white/10 lg:grid-cols-4">
          {WORKFLOWS.map((workflow) => (
            <button
              key={workflow.id}
              type="button"
              role="tab"
              aria-selected={tab === workflow.id}
              onClick={() => setTab(workflow.id)}
              className={`min-w-0 bg-[#09090d] px-4 py-3 text-left transition-colors focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-300 ${tab === workflow.id ? "bg-white text-black" : "text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100"}`}
            >
              <span className="block text-sm font-semibold">{workflow.label}</span>
              <span className="mt-0.5 block truncate text-[11px] opacity-60">{workflow.detail}</span>
            </button>
          ))}
        </div>

        <div role="tabpanel" className="grid gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:p-6">
          <div className="min-w-0 space-y-4">
            {tab === "recombine" && (
              <section className="space-y-2" aria-label="概念圖譜">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
                  <span>真實圖譜 · {graph.nodes.length} 節點 · {graph.edges.length} 連線</span>
                  <span>拖曳節點 · 空白處平移 · 滾輪縮放</span>
                </div>
                <div className="h-[360px] overflow-hidden rounded-xl border border-white/10 bg-zinc-950">
                  <GraphCanvas controller={controller} model={graph} onContextMenu={() => undefined} e2e={e2e} />
                </div>
              </section>
            )}

            <OutputsPanel key={tab} docs={docs} graph={graph} tabs={OUTPUT_TABS[tab]} defaultTab={OUTPUT_TABS[tab][0]} />
            {tab === "execute" && <Checklist72 docs={docs} graph={graph} />}
          </div>
          <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">
            <SourceInspector docs={docs} source={source} />
          </div>
        </div>
      </section>
    </SourceJumpProvider>
  );
}
