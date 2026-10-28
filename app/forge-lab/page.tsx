"use client";

import { useEffect, useState } from "react";
import BenchmarkPanel from "@/components/forge-lab/BenchmarkPanel";
import HnswInspector from "@/components/forge-lab/HnswInspector";
import StageTimeline from "@/components/forge-lab/StageTimeline";
import WorkerInspector from "@/components/forge-lab/WorkerInspector";
import WorkerStatusLight from "@/components/WorkerStatusLight";
import { getVectorStore } from "@/lib/vector/runtime";
import { WorkerEmbedder } from "@/lib/vector/worker-embedder";

export default function ForgeLabPage() {
  const [embedder, setEmbedder] = useState<WorkerEmbedder | null>(null);
  const [embedReason, setEmbedReason] = useState<string | null>(null);
  const [hnswKey, setHnswKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getVectorStore()
      .then(({ store, reason }) => {
        if (cancelled) return;
        if (store?.embedder instanceof WorkerEmbedder) setEmbedder(store.embedder);
        else setEmbedReason(reason ?? "embedder 不是 WorkerEmbedder");
      })
      .catch((e: unknown) => {
        if (!cancelled) setEmbedReason(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#050507] text-zinc-100">
      <div className="flex h-9 items-center gap-4 border-b border-white/[0.08] px-4 font-mono text-[11px]">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-[#00FFD1] shadow-[0_0_8px_#00FFD1]" />
          <span className="tracking-widest">FORGE-LAB · FORGECORE INSPECTOR</span>
        </div>
        <div className="ml-auto">
          <WorkerStatusLight />
        </div>
      </div>

      <main className="mx-auto grid max-w-[1600px] gap-4 p-4 sm:p-6 lg:grid-cols-3">
        <StageTimeline onIngested={() => setHnswKey((k) => k + 1)} />
        <WorkerInspector embedder={embedder} embedReason={embedReason} />
        <HnswInspector refreshKey={hnswKey} />
        <BenchmarkPanel />
      </main>
    </div>
  );
}
