import type { Segment } from "../lib/outputs/segments";

/** 片段 → React 節點。全部是文字節點（React 會跳脫），quote 與 term 只是不同樣式的 span；本檔不得使用 innerHTML。 */
export default function SegmentLine({ segments }: { segments: Segment[] }) {
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
