import { VECTOR_LABEL, TEXT_LABEL, canRetryIndexing, summarize } from "../lib/pipeline/doc-state";
import type { DocInfo } from "../lib/pipeline/types";

/**
 * 文件清單：每份文件的「文字」與「語意索引」狀態，以及明確的「重新建立索引」。
 * 文件名稱是使用者任意檔名 → 只用 React text node，本檔不得使用 innerHTML / dangerouslySetInnerHTML。
 * 這是純展示元件（不含 hook），可直接用 renderToStaticMarkup 測試。
 */
export interface DocumentListProps {
  docs: ReadonlyArray<{ id: string; name: string }>;
  docInfo: Readonly<Record<string, DocInfo>>;
  onRetry: (docId: string) => void;
}

export default function DocumentList({ docs, docInfo, onRetry }: DocumentListProps) {
  if (!docs.length) return null;
  return (
    <section aria-label="文件清單" className="rounded-xl border border-white/10 bg-white/5 p-3 font-mono" data-testid="document-list">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500">Documents · 文字與語意索引</div>
      <ul className="space-y-1.5">
        {docs.map((d) => {
          const info = docInfo[d.id];
          const retry = canRetryIndexing(info);
          const unsaved = info?.text === "persist_failed";
          return (
            <li key={d.id} className="text-xs" data-testid="doc-row">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 truncate text-zinc-200" title={d.name} data-testid="doc-name">
                  {d.name}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {info ? (
                    <span className={unsaved ? "text-amber-300" : "text-zinc-500"} data-testid="doc-summary">
                      {summarize(info)}
                      {info.vector === "building" && info.progress !== undefined ? ` ${Math.round(info.progress * 100)}%` : ""}
                    </span>
                  ) : (
                    <span className="text-zinc-600">{`文字：${TEXT_LABEL.pending} · 語意索引：${VECTOR_LABEL.pending}`}</span>
                  )}
                  {retry && (
                    <button
                      className="rounded border border-neon-cyan px-1.5 py-0.5 text-neon-cyan hover:bg-cyan-400/10"
                      onClick={() => onRetry(d.id)}
                      data-testid="retry-indexing"
                    >
                      重新建立索引
                    </button>
                  )}
                </span>
              </div>
              {unsaved && (
                <div className="mt-0.5 text-[10px] text-amber-300/90" data-testid="doc-unsaved">
                  尚未儲存，重新整理後可能遺失。{info.textNote ?? ""}
                </div>
              )}
              {info?.vectorNote && info.vector !== "indexed" && info.vector !== "building" && (
                <div className="mt-0.5 break-words text-[10px] text-zinc-600">{info.vectorNote}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
