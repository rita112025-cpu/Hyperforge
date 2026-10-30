"use client";

import { useCallback, useEffect, useState } from "react";
import { recallAtK } from "../../lib/bench/forge-bench";
import type { EmbedMeta } from "../../lib/vector/db";
import type { HNSW } from "../../lib/vector/hnsw";
import { loadHNSWIndex, readHNSWIndexInfo, rebuildHNSWIndex, saveHNSWIndex, type HNSWIndexInfo } from "../../lib/vector/hnsw-persist";
import { getSharedDb } from "../../lib/vector/shared-db";
import { LabButton, Panel, Stat, errText, ms } from "./ui";

function isEmbedMeta(v: unknown): v is EmbedMeta {
  return typeof v === "object" && v !== null && typeof (v as EmbedMeta).model === "string" && typeof (v as EmbedMeta).dim === "number";
}

/** 右欄：IndexedDB 內的 HNSW 持久化狀態；Load / Save / recall 都直接操作同一個 Dexie。 */
export default function HnswInspector({ refreshKey }: { refreshKey: number }) {
  const [info, setInfo] = useState<HNSWIndexInfo | null>(null);
  const [embed, setEmbed] = useState<EmbedMeta | null>(null);
  const [vectorCount, setVectorCount] = useState<number | null>(null);
  const [index, setIndex] = useState<HNSW | null>(null);
  const [timing, setTiming] = useState<{ load?: number; save?: number; source?: string }>({});
  const [recall, setRecall] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const db = getSharedDb();
      const [nextInfo, meta, count] = await Promise.all([readHNSWIndexInfo(db), db.meta.get("embed"), db.vectors.count()]);
      setInfo(nextInfo);
      setEmbed(isEmbedMeta(meta?.value) ? meta.value : null);
      setVectorCount(count);
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const guarded = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const load = () => guarded(async () => {
    if (!embed) return;
    const db = getSharedDb();
    const t = performance.now();
    const persisted = await loadHNSWIndex(db, embed);
    const next = persisted ?? (await rebuildHNSWIndex(db, embed.dim));
    setIndex(next);
    setTiming((s) => ({ ...s, load: performance.now() - t, source: persisted ? "序列化快照" : "vectors 表重建（快照不存在或不一致）" }));
  });

  const save = () => guarded(async () => {
    if (!index || !embed) return;
    const t = performance.now();
    const savedAt = await saveHNSWIndex(getSharedDb(), index, embed);
    if (savedAt === null) throw new Error("寫入失敗");
    setTiming((s) => ({ ...s, save: performance.now() - t }));
    await refresh();
  });

  const testRecall = () => guarded(async () => {
    if (!index) return;
    const rows = await getSharedDb().vectors.toArray();
    const t = performance.now();
    const r = recallAtK(index, rows, 10, 20);
    setRecall(`${(r * 100).toFixed(1)}% · ${Math.min(20, rows.length)} 查詢 · ${ms(performance.now() - t)}`);
  });

  return (
    <Panel title="HNSW INSPECTOR" sub="meta.hnswIndex">
      <Stat label="model" value={embed?.model ?? "—"} />
      <Stat label="modelDim" value={embed?.dim ?? "—"} />
      <Stat label="vectors 表" value={vectorCount ?? "—"} />
      <Stat label="快照 size" value={info?.size ?? "無快照"} />
      <Stat label="快照 dim" value={info ? (info.dim === embed?.dim ? info.dim : `${info.dim}（≠ modelDim）`) : "—"} />
      <Stat label="最後 save" value={info ? new Date(info.savedAt).toLocaleString() : "—"} />
      <Stat label="記憶體 index" value={index ? `${index.size} 筆` : "未載入"} />
      <Stat label="load / save" value={`${ms(timing.load)} / ${ms(timing.save)}`} />
      {timing.source && <p className="mt-1 text-[10px] text-zinc-500">來源：{timing.source}</p>}
      <Stat label="recall@10" value={recall ?? "—"} />
      <div className="mt-3 flex flex-wrap gap-2">
        <LabButton onClick={load} disabled={busy || !embed}>Load</LabButton>
        <LabButton tone="ghost" onClick={save} disabled={busy || !index}>Save</LabButton>
        <LabButton tone="ghost" onClick={testRecall} disabled={busy || !index || index.size === 0}>Recall test</LabButton>
        <LabButton tone="ghost" onClick={() => void refresh()} disabled={busy}>重新讀取</LabButton>
      </div>
      {!embed && <p className="mt-2 text-[11px] text-zinc-500">尚未有向量：先用左欄 pipeline 完成一次向量化。</p>}
      {error && <p role="alert" className="mt-2 text-[11px] text-[#00FFD1]">錯誤：{error}</p>}
    </Panel>
  );
}
