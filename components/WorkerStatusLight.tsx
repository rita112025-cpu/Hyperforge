"use client";

import { useEffect, useState } from "react";
import { getGraphClient, type GraphClientStats } from "../lib/graph/graph-client";

const STAGE_ZH = { chunk: "切塊", extract: "擷取", build: "建圖" } as const;

/** 定時讀取一個純讀取的狀態（不做任何重試；read 必須便宜且無副作用）。read 變更時重新開始。 */
export function usePolled<T>(read: () => T, intervalMs = 200): T {
  const [value, setValue] = useState<T>(read);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setValue(read());
      timer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => clearTimeout(timer);
  }, [read, intervalMs]);
  return value;
}

const readGraphStats = (): GraphClientStats => getGraphClient().getStats();

/** graph Worker 狀態（getStats 是純讀取）。 */
export function useGraphWorkerStats(intervalMs = 200): GraphClientStats {
  return usePolled(readGraphStats, intervalMs);
}

export default function WorkerStatusLight() {
  const s = useGraphWorkerStats();
  const label = s.running
    ? `建圖中${s.stage ? ` · ${STAGE_ZH[s.stage]}` : ""}${s.queued ? ` · 排隊 ${s.queued}` : ""}`
    : s.fallback
      ? "主執行緒 fallback"
      : s.workerAlive
        ? "待命"
        : "未啟動";
  const dot = s.running
    ? "bg-[#00FFD1] shadow-[0_0_8px_#00FFD1] animate-pulse"
    : s.fallback
      ? "bg-amber-400"
      : s.workerAlive
        ? "bg-[#00FFD1]/60"
        : "bg-zinc-600";
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="graph-worker-status"
      className="flex items-center gap-2 rounded border border-white/10 bg-white/5 px-2 py-0.5"
      title={s.lastDurationMs !== null ? `上次建圖 ${Math.round(s.lastDurationMs)} ms` : undefined}
    >
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      graph.worker:{label}
    </span>
  );
}
