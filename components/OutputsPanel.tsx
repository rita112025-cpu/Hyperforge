"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphDocument, GraphModel } from "../lib/graph/types";
import { DIGEST_NOTE, basisOf, buildDigest, describeBasis } from "../lib/outputs/digest";
import { copyText, downloadText } from "../lib/outputs/export";
import { buildMindmap, mindmapToMarkdown } from "../lib/outputs/mindmap";
import { buildNotionExport, notionToJson } from "../lib/outputs/notion";
import { buildSlides, slidesToMarkdown } from "../lib/outputs/slides";
import { THREADS_LAYOUTS, buildThreads, threadsToText, type ThreadsLayout } from "../lib/outputs/threads";
import { buildSummary, summaryToMarkdown } from "../lib/outputs/summary";
import MindmapView from "./MindmapView";
import { SlidesView, ThreadsView } from "./OutputViews";
import SegmentLine from "./SegmentLine";

/**
 * 一鍵七變（右側工廠）。已實作：核心摘要、心智圖、Threads、簡報大綱、Notion JSON。其餘分頁顯示為尚未實作（不假裝存在）。
 * 全部是本地、決定性的「抽取＋模板」輸出，不是 AI；使用者原文只以 React 文字節點顯示
 * （本檔不得使用 innerHTML / dangerouslySetInnerHTML，也不引入 markdown→HTML 套件）。
 * 資料基礎：與畫布同一份 docs 與 graph（同一次 render 傳入、useMemo 以它們為 key），所以不會顯示過期內容。
 */
type TabId = "summary" | "mindmap" | "threads" | "slides" | "notion" | "socratic" | "quotecard";

const TABS: Array<{ id: TabId; label: string; ready: boolean; stage?: string }> = [
  { id: "summary", label: "核心摘要", ready: true },
  { id: "mindmap", label: "心智圖", ready: true },
  { id: "threads", label: "Threads", ready: true },
  { id: "slides", label: "簡報大綱", ready: true },
  { id: "notion", label: "Notion", ready: true },
  { id: "socratic", label: "反問提示", ready: false, stage: "階段 C" },
  { id: "quotecard", label: "金句卡", ready: false, stage: "階段 C" },
];

const PREVIEW_CHARS = 4000;

export interface OutputsPanelProps {
  docs: GraphDocument[];
  graph: GraphModel;
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
  // 每個分頁只在被選取時才算（B 階段新增的三個也一樣）
  const mindmap = useMemo(() => (digest && tab === "mindmap" ? buildMindmap(digest) : null), [digest, tab]);
  const mindmapMd = useMemo(() => (mindmap ? mindmapToMarkdown(mindmap) : ""), [mindmap]);
  const slides = useMemo(() => (digest && tab === "slides" ? buildSlides(digest) : null), [digest, tab]);
  const slidesMd = useMemo(() => (slides ? slidesToMarkdown(slides) : ""), [slides]);
  const [layout, setLayout] = useState<ThreadsLayout>("professional");
  const threads = useMemo(() => (digest && tab === "threads" ? buildThreads(digest, layout) : null), [digest, tab, layout]);
  const threadsText = useMemo(() => (threads ? threadsToText(threads) : ""), [threads]);
  const current = TABS.find((t) => t.id === tab)!;
  // 複製與下載：Markdown 輸出（摘要、簡報）是跳脫後的 Markdown；Notion 是 JSON；Threads 是「純文字」（貼到 Threads，不跳脫）
  const text = tab === "summary" ? summaryMd : tab === "notion" ? notionJson : tab === "slides" ? slidesMd : tab === "threads" ? threadsText : tab === "mindmap" ? mindmapMd : "";
  const fileInfo: { name: string; mime: string; ext: string } | null =
    tab === "notion"
      ? { name: "hyperforge-notion.json", mime: "application/json", ext: ".json" }
      : tab === "summary"
        ? { name: "hyperforge-summary.md", mime: "text/markdown", ext: ".md" }
        : tab === "slides"
          ? { name: "hyperforge-slides.md", mime: "text/markdown", ext: ".md" }
          : tab === "threads"
            ? { name: "hyperforge-threads.txt", mime: "text/plain", ext: ".txt" }
            : tab === "mindmap"
              ? { name: "hyperforge-mindmap.md", mime: "text/markdown", ext: ".md" }
              : null;

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
    if (!fileInfo) return;
    const name = downloadText(fileInfo.name, text, fileInfo.mime);
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
              下載 {fileInfo?.ext ?? ""}
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

          {tab === "mindmap" && mindmap && digest && <MindmapView mindmap={mindmap} digest={digest} />}

          {tab === "slides" && slides && <SlidesView result={slides} />}

          {tab === "threads" && threads && (
            <div className="space-y-2">
              <div role="radiogroup" aria-label="Threads 版型" className="flex flex-wrap gap-1" data-testid="threads-layouts">
                {THREADS_LAYOUTS.map((l) => (
                  <button
                    key={l.id}
                    role="radio"
                    aria-checked={layout === l.id}
                    title={l.description}
                    onClick={() => {
                      setLayout(l.id);
                      setFlash(null);
                      setFallback(null);
                    }}
                    className={`rounded border px-1.5 py-0.5 text-[11px] ${layout === l.id ? "border-neon-cyan text-neon-cyan" : "border-white/15 text-zinc-300 hover:border-violet-300"}`}
                    data-testid={`layout-${l.id}`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
              <div className="text-[10px] text-zinc-500" data-testid="threads-explain">
                {THREADS_LAYOUTS.find((l) => l.id === layout)!.description}。沒有 AI，所以這是「版型」而不是語氣：規格的「嗆辣 / 故事」需要新增斷言或捏造情節，做不到，改為三種誠實版型。複製與下載是純文字（不做 Markdown 跳脫）。
              </div>
              <ThreadsView result={threads} />
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
