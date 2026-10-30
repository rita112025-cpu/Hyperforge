"use client";

import type { Segment } from "../lib/outputs/segments";
import { useSourceJump } from "./SourceJumpContext";

/** 片段 → React 節點。全部是文字節點（React 會跳脫），quote 與 term 只是不同樣式的 span；本檔不得使用 innerHTML。 */
export default function SegmentLine({ segments }: { segments: Segment[] }) {
  const jump = useSourceJump();
  return (
    <div className="whitespace-pre-wrap break-words">
      {segments.map((s, i) => {
        if (s.kind === "term") return <span key={i} className="text-violet-200">{s.text}</span>;
        const nearestQuote = [...segments.slice(0, i)].reverse().find(
          (candidate): candidate is Extract<Segment, { kind: "quote" }> => candidate.kind === "quote",
        );
        if (s.kind === "ref" && jump && nearestQuote) {
          return (
            <button
              key={i}
              type="button"
              onClick={() => jump({ docId: s.docId, start: nearestQuote.start, end: nearestQuote.end })}
              className="rounded-sm text-zinc-400 underline decoration-zinc-600 underline-offset-2 transition-colors hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
              title={`查看 ${s.text} 的原文位置`}
            >
              {s.text}
            </button>
          );
        }
        if (s.kind === "ref") return <span key={i} className="text-zinc-500">{s.text}</span>;
        if (s.kind === "quote" && jump) {
          return (
            <button
              key={i}
              type="button"
              onClick={() => jump({ docId: s.docId, start: s.start, end: s.end })}
              className="rounded-sm text-left underline decoration-white/20 underline-offset-2 transition-colors hover:text-cyan-100 hover:decoration-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
              title="查看原文位置"
            >
              {s.text}
            </button>
          );
        }
        if (s.kind === "frame" && /^[（）]$/.test(s.text)) return <span key={i} className="text-zinc-500">{s.text}</span>;
        if (s.kind === "frame" && s.text === "（人名 heuristic）") return <span key={i} className="text-amber-300/80">{s.text}</span>;
        return <span key={i}>{s.text}</span>;
      })}
    </div>
  );
}
