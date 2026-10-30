"use client";

import { useRef, useState } from "react";
import { getGraphClient } from "../../lib/graph/graph-client";
import { contentIdOf, docFromJobResult, loadCorpus, saveDocument } from "../../lib/graph/corpus";
import { getDeconstructClient } from "../../lib/pipeline/deconstruct-client";
import { runPipeline } from "../../lib/pipeline/runner";
import { STAGE_LABEL_ZH, STAGE_ORDER, type StageId, type StageState, type TextStatus } from "../../lib/pipeline/types";
import { getVectorStore } from "../../lib/vector/runtime";
import { getSharedDb } from "../../lib/vector/shared-db";
import { LabButton, Panel, errText, ms } from "./ui";

interface StageEvent {
  stage: StageId | "CANVAS";
  status: string;
  progress?: number;
  note?: string;
  at: number;
}

type Row = { status: string; progress?: number; startAt?: number; endAt?: number; note?: string };

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** 左欄：真實 runPipeline 的 onStage 回調，依時間軸呈現。 */
export default function StageTimeline({ onIngested }: { onIngested: () => void }) {
  const [input, setInput] = useState("");
  const [events, setEvents] = useState<StageEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const t0Ref = useRef(0);

  const push = (stage: StageEvent["stage"], patch: Partial<StageState>) =>
    setEvents((list) => [...list, { stage, status: patch.status ?? "update", progress: patch.progress, note: patch.note, at: performance.now() - t0Ref.current }]);

  const run = async () => {
    if (!input.trim() || running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    t0Ref.current = performance.now();
    setEvents([]);
    setSummary(null);
    setRunning(true);
    const text: { status: TextStatus } = { status: "pending" };
    try {
      const result = await runPipeline({ kind: "text", text: input }, {
        signal: controller.signal,
        getStore: getVectorStore,
        chunker: (text, signal) => getDeconstructClient().deconstruct(text, signal),
        onStage: (id, patch) => push(id, patch),
        onTextReady: async (payload) => {
          const db = getSharedDb();
          const saved = await saveDocument(db, payload);
          const docId = saved?.docId ?? (await contentIdOf(payload.rawText)).id;
          text.status = saved ? "ready" : "persist_failed";
          push("CANVAS", { status: "running", note: "graph.worker 建圖" });
          try {
            const corpus = saved ? await loadCorpus(db) : [docFromJobResult(payload, docId)];
            const graph = await getGraphClient().build(corpus, {
              signal: controller.signal,
              onProgress: (p) => push("CANVAS", { status: "running", progress: p.progress, note: p.stage }),
            });
            push("CANVAS", { status: "done", note: `${graph.nodes.length} nodes / ${graph.edges.length} edges` });
          } catch (e) {
            push("CANVAS", { status: isAbort(e) ? "cancelled" : "error", note: errText(e) });
          }
          return { status: text.status, docId, note: saved ? "文字已存入 IndexedDB" : "未持久化" };
        },
      });
      setSummary(`text=${result.textStatus} · vector=${result.vectorStatus}`);
      if (result.vectorStatus === "indexed") onIngested();
    } catch (e) {
      setSummary(isAbort(e) ? `已取消 · 文字已保留=${text.status === "ready" ? "是" : "否"}` : `錯誤：${errText(e)}`);
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  };

  const rows = new Map<StageEvent["stage"], Row>();
  for (const e of events) {
    const r = rows.get(e.stage) ?? { status: "idle" };
    r.status = e.status;
    r.progress = e.progress ?? r.progress;
    r.note = e.note ?? r.note;
    r.startAt ??= e.at;
    if (e.status !== "running" && e.status !== "update") r.endAt = e.at;
    rows.set(e.stage, r);
  }
  const order: Array<StageEvent["stage"]> = [...STAGE_ORDER.slice(0, 2), "CANVAS", ...STAGE_ORDER.slice(2)];

  return (
    <Panel title="PIPELINE · STAGE TIMELINE" sub="runPipeline.onStage">
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="貼一段文字，走真實 pipeline（會寫入 IndexedDB）"
        aria-label="pipeline 輸入"
        className="h-24 w-full resize-none rounded-lg border border-white/[0.06] bg-black/40 p-2 text-[12px] leading-5 outline-none placeholder:text-zinc-600 focus-visible:border-[#00FFD1]/40"
      />
      <div className="mt-2 flex items-center gap-2">
        <LabButton onClick={run} disabled={running || !input.trim()}>{running ? "執行中…" : "執行 pipeline"}</LabButton>
        {running && <LabButton tone="ghost" onClick={() => abortRef.current?.abort()}>取消</LabButton>}
        <span className="truncate font-mono text-[10px] text-zinc-500" role="status">{summary}</span>
      </div>
      <ol className="mt-4 space-y-1.5">
        {order.map((stage) => {
          const r = rows.get(stage);
          const status = r?.status ?? "idle";
          const active = status === "running";
          const done = status === "done";
          return (
            <li key={stage} className={`rounded-lg border px-3 py-2 ${active ? "border-[#00FFD1]/50 bg-[#00FFD1]/10" : done ? "border-[#00FFD1]/20" : "border-white/[0.05]"}`}>
              <div className="flex items-center justify-between font-mono text-[11px]">
                <span className={done || active ? "text-[#00FFD1]" : "text-zinc-500"}>
                  {stage} <span className="text-zinc-500">{stage === "CANVAS" ? "畫布建圖" : STAGE_LABEL_ZH[stage]}</span>
                </span>
                <span className="tabular-nums text-zinc-400">
                  {status}
                  {r?.progress !== undefined && active ? ` ${Math.round(r.progress * 100)}%` : ""}
                  {r?.startAt !== undefined && r.endAt !== undefined ? ` · ${ms(r.endAt - r.startAt)}` : ""}
                </span>
              </div>
              {r?.note && <div className="mt-0.5 truncate text-[10px] text-zinc-500">{r.note}</div>}
            </li>
          );
        })}
      </ol>
      <details className="mt-3 font-mono text-[10px] text-zinc-500">
        <summary className="cursor-pointer">原始事件 {events.length}</summary>
        <div className="mt-1 max-h-40 overflow-auto">
          {events.map((e, i) => (
            <div key={i}>+{ms(e.at)} {e.stage} {e.status}{e.progress !== undefined ? ` ${Math.round(e.progress * 100)}%` : ""}{e.note ? ` · ${e.note}` : ""}</div>
          ))}
        </div>
      </details>
    </Panel>
  );
}
