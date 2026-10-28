"use client";

import { useCallback } from "react";
import { getGraphClient } from "../../lib/graph/graph-client";
import type { WorkerEmbedder } from "../../lib/vector/worker-embedder";
import { useGraphWorkerStats, usePolled } from "../WorkerStatusLight";
import { LabButton, Panel, Stat, ms } from "./ui";

interface EmbedStats {
  queued: number;
  running: boolean;
  alive: boolean;
}

const readEmbed = (e: WorkerEmbedder): EmbedStats => ({ queued: e.queued, running: e.running, alive: e.hasWorker });

function Light({ on }: { on: boolean }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${on ? "animate-pulse bg-[#00FFD1] shadow-[0_0_8px_#00FFD1]" : "bg-zinc-700"}`} />;
}

/** 中欄：graph.worker 與 embed.worker 的佇列 / 執行狀態，可中止。 */
export default function WorkerInspector({ embedder, embedReason }: { embedder: WorkerEmbedder | null; embedReason: string | null }) {
  const graph = useGraphWorkerStats();
  const embed = usePolled(useCallback((): EmbedStats | null => (embedder ? readEmbed(embedder) : null), [embedder]));

  return (
    <Panel title="WORKER INSPECTOR" sub="輪詢 200ms">
      <div className="space-y-4">
        <div className="rounded-xl border border-white/[0.06] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-2 font-mono text-[12px] text-zinc-100"><Light on={graph.running} /> graph.worker</span>
            <LabButton tone="ghost" onClick={() => getGraphClient().abortAll()} disabled={!graph.running && graph.queued === 0}>中止全部</LabButton>
          </div>
          <Stat label="running" value={graph.running ? `是 · ${graph.stage ?? "啟動中"}` : "否"} />
          <Stat label="queue" value={graph.queued} />
          <Stat label="worker" value={graph.fallback ? "主執行緒 fallback" : graph.workerAlive ? "存活" : "未啟動"} />
          <Stat label="完成 / 失敗 / 取消" value={`${graph.completed} / ${graph.failed} / ${graph.aborted}`} />
          <Stat label="上次建圖" value={ms(graph.lastDurationMs)} />
        </div>

        <div className="rounded-xl border border-white/[0.06] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-2 font-mono text-[12px] text-zinc-100"><Light on={!!embed?.running} /> embed.worker</span>
            <LabButton tone="ghost" onClick={() => embedder?.abortAll()} disabled={!embed?.running}>中止全部</LabButton>
          </div>
          {embedder && embed ? (
            <>
              <Stat label="running" value={embed.running ? "是" : "否"} />
              <Stat label="queue" value={Math.max(0, embed.queued - (embed.running ? 1 : 0))} />
              <Stat label="worker" value={embed.alive ? "存活" : "未啟動（第一次 embed 時建立）"} />
              <Stat label="model" value={`${embedder.id} · dim ${embedder.dim}`} />
            </>
          ) : (
            <p className="text-[11px] text-zinc-500">{embedReason ?? "連線向量庫中…"}</p>
          )}
        </div>
      </div>
    </Panel>
  );
}
