import type { SlidesResult } from "../lib/outputs/slides";
import type { ThreadsResult } from "../lib/outputs/threads";
import { THREADS_MAX_CHARS } from "../lib/outputs/threads";
import { segmentsToText } from "../lib/outputs/segments";
import SegmentLine from "./SegmentLine";

/** 簡報大綱與 Threads 的展示（純展示元件，只輸出 React 文字節點，可直接 renderToStaticMarkup 測試）。 */
export function SlidesView({ result }: { result: SlidesResult }) {
  if (!result.slides.length) return <div className="text-xs text-zinc-500">{result.notes[0] ?? "沒有概念可用，無法產生簡報大綱。"}</div>;
  return (
    <div className="space-y-3 text-xs text-zinc-200" data-testid="output-slides">
      {result.slides.map((s, i) => (
        <section key={i} className="space-y-1 rounded border border-white/10 bg-black/20 p-2" data-testid="slide">
          <div className="flex gap-1 text-sm text-violet-200">
            <span className="text-zinc-500">第 {i + 1} 頁：</span>
            <SegmentLine segments={s.title} />
          </div>
          {s.bullets.map((b, j) => (
            <SegmentLine key={j} segments={b} />
          ))}
          {s.notes.length > 0 && (
            <div className="mt-1 border-t border-white/5 pt-1" data-testid="slide-notes">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">講稿</div>
              {s.notes.map((n, j) => (
                <SegmentLine key={j} segments={n} />
              ))}
            </div>
          )}
        </section>
      ))}
      {result.notes.map((n, i) => (
        <div key={i} className="text-[10px] text-amber-300/80" data-testid="slides-note">
          {n}
        </div>
      ))}
    </div>
  );
}

export function ThreadsView({ result }: { result: ThreadsResult }) {
  return (
    <div className="space-y-2 text-xs text-zinc-200" data-testid="output-threads">
      {result.posts.map((p, i) => {
        const text = segmentsToText(p);
        return (
          <section key={i} className="space-y-1 rounded border border-white/10 bg-black/20 p-2" data-testid="threads-post">
            <SegmentLine segments={p} />
            <div className="text-[10px] text-zinc-500" data-testid="threads-count">
              {Array.from(text).length} / {THREADS_MAX_CHARS} 字元
            </div>
          </section>
        );
      })}
      {result.notes.map((n, i) => (
        <div key={i} className="text-[10px] text-amber-300/80" data-testid="threads-note">
          {n}
        </div>
      ))}
    </div>
  );
}
