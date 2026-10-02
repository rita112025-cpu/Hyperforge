import { ALCHEMY_BADGE } from "../lib/graph/alchemy";
import { EXTRACT_METHOD_NOTE, PERSON_METHOD_NOTE } from "../lib/graph/extract";
import { buildSnippets } from "../lib/graph/snippets";
import type { GraphDocument, GraphNode, NodeEvidence } from "../lib/graph/types";

/**
 * 來源面板。顯示的全部是「使用者任意檔案的內容」，所以：
 * 只用 React text node 輸出（React 會跳脫 < > & " '），本檔不得使用 innerHTML / dangerouslySetInnerHTML。
 * （lib/graph/security.test.ts 會掃描原始碼並以 hostile fixture 實際渲染驗證。）
 */
export interface SourcePanelProps {
  node: GraphNode | null;
  evidence?: NodeEvidence;
  docs: ReadonlyMap<string, GraphDocument>;
  selectedCount: number;
  /** 暫存節點的來源節點名稱 */
  parentLabels?: string[];
}

function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-[10px] uppercase tracking-wider text-zinc-500">{name}</dt>
      <dd className="break-words text-xs text-zinc-200">{children}</dd>
    </div>
  );
}

function typeLabel(n: GraphNode): string {
  if (n.kind === "person") return "人名 · heuristic";
  if (n.kind === "temp") return `${ALCHEMY_BADGE}（本機煉成）`;
  return "概念";
}

export default function SourcePanel({ node, evidence, docs, selectedCount, parentLabels }: SourcePanelProps) {
  if (!node) {
    return (
      <aside aria-label="來源面板" className="rounded-xl border border-white/10 bg-white/5 p-4 text-xs text-zinc-500" data-testid="source-panel">
        點選畫布上的節點，查看它的來源。
        <div className="mt-2 text-[10px] text-zinc-600">Shift+點擊可多選；空白處拖曳平移；Shift+拖曳框選；滾輪縮放。</div>
      </aside>
    );
  }

  const snippets = buildSnippets(evidence, docs);
  return (
    <aside aria-label="來源面板" className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4" data-testid="source-panel">
      {selectedCount > 1 && <div className="text-[10px] text-zinc-500">已選取 {selectedCount} 個節點，以下為最後點選的節點。</div>}
      <dl className="space-y-2.5">
        <Row name="Concept">
          <span data-testid="source-concept" className="text-sm text-violet-200">
            {node.label}
          </span>
        </Row>
        <Row name="Type">
          <span data-testid="source-type">{typeLabel(node)}</span>
          {node.kind === "person" && <div className="mt-0.5 text-[10px] text-amber-300/80">{PERSON_METHOD_NOTE}</div>}
          {node.kind === "concept" && /\p{Script=Han}/u.test(node.label) && (
            <div className="mt-0.5 text-[10px] text-zinc-500">中文概念：{EXTRACT_METHOD_NOTE}</div>
          )}
        </Row>

        {node.kind === "temp" ? (
          <>
            <Row name="Documents">無（暫存節點不對應任何文件）</Row>
            <Row name="Source concepts">{parentLabels?.length ? parentLabels.join("、") : "—"}</Row>
            <Row name="Original text">
              <span className="text-zinc-500">無。此節點只存在於記憶體，未寫入 IndexedDB，重新整理後消失。</span>
            </Row>
          </>
        ) : (
          <>
            <Row name="Frequency">
              <span data-testid="source-frequency">{node.freq}</span> 次（score {node.score.toFixed(2)}）
            </Row>
            <Row name="Documents">
              {evidence?.docs.length ? (
                <ul className="space-y-0.5" data-testid="source-documents">
                  {evidence.docs.map((d) => (
                    <li key={d.docId}>
                      {d.docName} <span className="text-zinc-500">· {d.occurrences} 次</span>
                    </li>
                  ))}
                </ul>
              ) : (
                "—"
              )}
            </Row>
            <Row name="Chunks">
              {evidence?.docs.length ? (
                <ul className="space-y-0.5" data-testid="source-chunks">
                  {evidence.docs.map((d) => (
                    <li key={d.docId}>
                      {d.docName} <span className="text-zinc-500">· {d.chunkIndexes.map((i) => `#${i}`).join(" ")}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                "—"
              )}
            </Row>
            <Row name="Original text">
              {snippets.length ? (
                <ol className="space-y-2" data-testid="source-snippets">
                  {snippets.map((s, i) => (
                    <li key={i} className="rounded border border-white/5 bg-black/30 p-2">
                      <div className="mb-1 text-[10px] text-zinc-500">
                        {s.docName} · {s.chunkIndexes.length ? s.chunkIndexes.map((c) => `chunk #${c}`).join(", ") : "—"}
                      </div>
                      <p className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-300">
                        {s.cutBefore ? "…" : ""}
                        {s.before}
                        <mark className="rounded bg-violet-500/30 px-0.5 text-violet-100">{s.match}</mark>
                        {s.after}
                        {s.cutAfter ? "…" : ""}
                      </p>
                    </li>
                  ))}
                </ol>
              ) : (
                <span className="text-zinc-500">原文已不在記憶體中。</span>
              )}
              {evidence && snippets.length > 0 && node.freq > snippets.length && (
                <div className="mt-1 text-[10px] text-zinc-600">僅顯示前 {snippets.length} 筆出處（共 {node.freq} 次）。</div>
              )}
            </Row>
          </>
        )}
      </dl>
    </aside>
  );
}
