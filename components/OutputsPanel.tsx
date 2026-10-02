"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphDocument, GraphModel } from "../lib/graph/types";
import { DIGEST_NOTE, basisOf, buildDigest, describeBasis } from "../lib/outputs/digest";
import { copyText, downloadText } from "../lib/outputs/export";
import { buildNotionExport, notionToJson } from "../lib/outputs/notion";
import type { Segment } from "../lib/outputs/segments";
import { buildSummary, summaryToMarkdown } from "../lib/outputs/summary";

/**
 * 一鍵七變（右側工廠）。階段 A：核心摘要、Notion JSON。其餘分頁顯示為尚未實作（不假裝存在）。
 * 全部是本地、決定性的「抽取＋模板」輸出，不是 AI；使用者原文只以 React 文字節點顯示
 * （本檔不得使用 innerHTML / dangerouslySetInnerHTML，也不引入 markdown→HTML 套件）。
 * 資料基礎：與畫布同一份 docs 與 graph（同一次 render 傳入、useMemo 以它們為 key），所以不會顯示過期內容。
 */
type TabId = "summary" | "mindmap" | "threads" | "slides" | "notion" | "socratic" | "quotecard";

const TABS: Array<{ id: TabId; label: string; ready: boolean; stage?: string }> = [
  { id: "summary", label: "核心摘要", ready: true },
  { id: "mindmap", label: "心智圖", ready: false, stage: "階段 B" },
  { id: "threads", label: "Threads", ready: false, stage: "階段 B" },
  { id: "slides", label: "簡報大綱", ready: false, stage: "階段 B" },
  { id: "notion", label: "Notion", ready: true },
  { id: "socratic", label: "反問提示", ready: false, stage: "階段 C" },
  { id: "quotecard", label: "金句卡", ready: false, stage: "階段 C" },
];

const PREVIEW_CHARS = 4000;

export interface OutputsPanelProps {
  docs: GraphDocument[];
  graph: GraphModel;
}

/** 片段 → React 節點。全部是文字節點；quote 與 term 只是不同樣式的 span。 */
export function SegmentLine({ segments }: { segments: Segment[] }) {
  return (
    <div className="whitespace-pre-wrap break-words">
      {segments.map((s, i) => {
        if (s.kind === "term") return <span key={i} className="text-violet-200">{s.text}</span>;
        if (s.kind === "ref") return <span key={i} className="text-zinc-500">{s.text}</span>;
        if (s.kind === "frame" && /^[（）]$/.test(s.text)) return <span key={i} className="text-zinc-500">{s.text}</span>;
        if (s.kind === "frame" && s.text === "（人名 heuristic）") return <span key={i} className="text-amber-300/80">{s.text}</span>;
        return <span key={i}>{s.text}</span>;
      })}
    </div>
  );
}

export default function OutputsPanel({ docs, graph }: OutputsPanelProps) {
  const [tab, setTab] = useState<TabId>("summary");
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  /** 複製失敗時的退路：顯示可全選的完整文字 */
  const [fallback, setFallback] = useState<string | null>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);

  // 重的部分（digest = 再抽取一次）只在「面板展開、有概念」時才算；摘要 / Notion 只算「目前被選取的分頁」。
  // 資料基礎只讀圖譜統計（很便宜），所以收合或空圖譜時也能顯示。
  const [open, setOpen] = useState(true);
  const basis = useMemo(() => basisOf(graph), [graph]);
  const empty = basis.conceptsShown === 0;
  const digest = useMemo(() => (open && !empty ? buildDigest(docs, graph) : null), [open, empty, docs, graph]);
  const summary = useMemo(() => (digest && tab === "summary" ? buildSummary(digest) : null), [digest, tab]);
  const summaryMd = useMemo(() => (summary ? summaryToMarkdown(summary) : ""), [summary]);
  const notion = useMemo(() => (digest && tab === "notion" ? buildNotionExport(digest) : null), [digest, tab]);
  const notionJson = useMemo(() => (notion ? notionToJson(notion) : ""), [notion]);
  const current = TABS.find((t) => t.id === tab)!;
  const text = tab === "summary" ? summaryMd : tab === "notion" ? notionJson : "";

  // 退路文字區顯示後自動全選（在 commit 之後才有 ref），使用者按 Ctrl+C 即可
  useEffect(() => {
    if (fallback !== null) fallbackRef.current?.select();
  }, [fallback]);

  const doCopy = async () => {
    const r = await copyText(text);
    if (r.ok) {
      setFlash({ kind: "ok", text: "已複製" });
      setFallback(null);
    } else {
      setFlash({ kind: "err", text: r.error });
      setFallback(text);
    }
  };
  const doDownload = () => {
    const isNotion = tab === "notion";
    const name = downloadText(isNotion ? "hyperforge-notion.json" : "hyperforge-summary.md", text, isNotion ? "application/json" : "text/markdown");
    setFlash({ kind: "ok", text: `已下載 ${name}` });
  };

  return (
    <section aria-label="一鍵七變" className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4 font-mono" data-testid="outputs-panel">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">Transmutation · 一鍵七變</div>
          <div className="mt-1 text-[10px] text-zinc-500" data-testid="outputs-basis">
            資料基礎：{describeBasis(basis)}。{DIGEST_NOTE}。
          </div>
        </div>
        <button
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:border-violet-300"
          data-testid="outputs-toggle"
        >
          {open ? "收合" : "展開"}
        </button>
      </div>

      {open && (
        <>
      <div role="tablist" aria-label="輸出種類" className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            disabled={!t.ready}
            title={t.ready ? undefined : `尚未實作（${t.stage}）`}
            onClick={() => {
              setTab(t.id);
              setFlash(null);
              setFallback(null);
            }}
            className={`rounded border px-1.5 py-0.5 text-[11px] ${
              tab === t.id ? "border-neon-cyan text-neon-cyan" : t.ready ? "border-white/15 text-zinc-300 hover:border-violet-300" : "cursor-not-allowed border-white/5 text-zinc-600"
            }`}
            data-testid={`tab-${t.id}`}
          >
            {t.label}
            {!t.ready && <span className="ml-1 text-[9px]">{t.stage}</span>}
          </button>
        ))}
      </div>

      {empty ? (
        <div className="text-xs text-zinc-500" data-testid="outputs-empty">
          目前沒有可用的概念，所以無法產生輸出。拖入較長的文字（詞需至少出現 2 次）後，這裡會出現摘要與 Notion 資料庫。
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button className="rounded border border-neon-cyan px-2 py-0.5 text-neon-cyan hover:bg-cyan-400/10" onClick={doCopy} data-testid="output-copy">
              複製
            </button>
            <button className="rounded border border-white/15 px-2 py-0.5 text-zinc-200 hover:border-violet-300" onClick={doDownload} data-testid="output-download">
              下載 {tab === "notion" ? ".json" : ".md"}
            </button>
            {flash && (
              <span className={flash.kind === "ok" ? "text-emerald-300" : "text-amber-300"} role="status" data-testid="output-flash">
                {flash.text}
              </span>
            )}
          </div>

          {fallback !== null && (
            <textarea
              ref={fallbackRef}
              readOnly
              value={fallback}
              aria-label="完整內容（已全選，可按 Ctrl+C 複製）"
              onFocus={(e) => e.currentTarget.select()}
              className="h-32 w-full resize-y rounded border border-amber-300/40 bg-black/40 p-2 text-[10px] text-zinc-200"
              data-testid="output-fallback"
            />
          )}

          {tab === "summary" && summary && (
            <div className="space-y-3 text-xs text-zinc-200" data-testid="output-summary">
              {summary.lines.length > 0 && (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">三行摘要</div>
                  <div className="space-y-1" data-testid="summary-lines">
                    {summary.lines.map((l, i) => (
                      <SegmentLine key={i} segments={l.segments} />
                    ))}
                  </div>
                </div>
              )}
              {summary.bullets.length > 0 && (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">十個重點</div>
                  <div className="space-y-1" data-testid="summary-bullets">
                    {summary.bullets.map((b, i) => (
                      <SegmentLine key={i} segments={b.segments} />
                    ))}
                  </div>
                </div>
              )}
              {summary.notes.map((n, i) => (
                <div key={i} className="text-[10px] text-amber-300/80" data-testid="summary-note">
                  {n}
                </div>
              ))}
            </div>
          )}

          {tab === "notion" && notion && (
            <div className="space-y-1" data-testid="output-notion">
              <div className="text-[10px] text-amber-300/80">未驗證能被 Notion 實際匯入；parent 需自行填入頁面 ID。</div>
              {notion.warnings.map((w, i) => (
                <div key={i} className="text-[10px] text-amber-300/80" data-testid="notion-warning">
                  {w}
                </div>
              ))}
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded border border-white/5 bg-black/30 p-2 text-[10px] text-zinc-300">
                {notionJson.length > PREVIEW_CHARS ? `${notionJson.slice(0, PREVIEW_CHARS)}\n…（預覽已截斷；複製與下載為完整內容，共 ${notionJson.length} 字元）` : notionJson}
              </pre>
            </div>
          )}

          {!current.ready && <div className="text-xs text-zinc-500">尚未實作（{current.stage}）。</div>}
        </>
      )}
        </>
      )}
    </section>
  );
}
