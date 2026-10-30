"use client";

import { useEffect, useState } from "react";
import { generateBenchText, monitorMainThread, syntheticVectors, yieldToMain } from "../../lib/bench/forge-bench";
import { getGraphClient } from "../../lib/graph/graph-client";
import type { GraphStageTimings } from "../../lib/graph/graph-protocol";
import { HyperforgeDB } from "../../lib/vector/db";
import { HNSW } from "../../lib/vector/hnsw";
import { loadHNSWIndex, saveHNSWIndex } from "../../lib/vector/hnsw-persist";
import { MULTILINGUAL } from "../../lib/vector/model-spec";
import { LabButton, Panel, errText, ms } from "./ui";

const STORAGE_KEY = "hyperforge:forge-lab:benchmarks";
const BENCH_DB = "hyperforge-forge-lab-bench";
const CHARS = 200_000;
const BLOCK_BUDGET_MS = 100;
const HISTORY = 10;

interface BenchResult {
  at: number;
  chars: number;
  chunks: number;
  nodes: number;
  edges: number;
  graphMs: number;
  stageMs: GraphStageTimings;
  vectors: number;
  hnswBuildMs: number;
  saveMs: number;
  loadMs: number;
  maxBlockMs: number;
  longestTaskMs: number | null;
  pass: boolean;
}

function readHistory(): BenchResult[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as BenchResult[]) : [];
  } catch {
    return [];
  }
}

function writeHistory(list: BenchResult[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* 無痕模式 / 已封鎖儲存：只顯示本次結果 */
  }
}

/**
 * 20 萬字合成文件：graph.worker 建圖 + HNSW（合成向量，獨立的 bench DB）save / load，
 * 全程量測主執行緒阻塞。不會碰使用者的語料與向量庫。
 */
async function runBenchmark(onStep: (s: string) => void): Promise<BenchResult> {
  const text = generateBenchText(CHARS);
  const monitor = monitorMainThread();
  const db = new HyperforgeDB(BENCH_DB);
  try {
    onStep("graph.worker：切塊 → 擷取 → 建圖");
    let t = performance.now();
    const built = await getGraphClient().buildFromText("bench-200k.txt", text, { onProgress: (p) => onStep(`graph.worker：${p.stage} ${Math.round(p.progress * 100)}%`) });
    const graphMs = performance.now() - t;

    const chunks = built.doc?.chunks.length ?? 0;
    const count = Math.max(chunks, 100);
    const { dim } = MULTILINGUAL;
    const embed = { model: `${MULTILINGUAL.id}#bench`, dim };
    onStep(`HNSW：插入 ${count} 筆合成向量`);
    const vecs = syntheticVectors(count, dim);
    t = performance.now();
    const index = new HNSW({ dim });
    for (let i = 0; i < count; i += 20) {
      for (let j = i; j < Math.min(i + 20, count); j++) index.add(`bench:${j}`, vecs[j]);
      await yieldToMain();
    }
    const hnswBuildMs = performance.now() - t;
    await db.vectors.bulkPut(vecs.map((vec, i) => ({ id: `bench:${i}`, docId: "bench", vec })));

    onStep("HNSW：save");
    t = performance.now();
    if ((await saveHNSWIndex(db, index, embed)) === null) throw new Error("HNSW save 失敗");
    const saveMs = performance.now() - t;

    onStep("HNSW：load");
    t = performance.now();
    const loaded = await loadHNSWIndex(db, embed);
    const loadMs = performance.now() - t;
    if (!loaded || loaded.size !== count) throw new Error("HNSW load 結果與寫入不符");

    const report = monitor.stop();
    return {
      at: Date.now(),
      chars: text.length,
      chunks,
      nodes: built.graph.nodes.length,
      edges: built.graph.edges.length,
      graphMs,
      stageMs: built.stageMs,
      vectors: count,
      hnswBuildMs,
      saveMs,
      loadMs,
      maxBlockMs: report.maxBlockMs,
      longestTaskMs: report.longestTaskMs,
      pass: report.maxBlockMs < BLOCK_BUDGET_MS,
    };
  } finally {
    monitor.stop();
    db.close();
    await db.delete().catch(() => undefined);
  }
}

export default function BenchmarkPanel() {
  const [history, setHistory] = useState<BenchResult[]>([]);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = step !== null;

  useEffect(() => setHistory(readHistory()), []);

  const run = async () => {
    setError(null);
    setStep("準備 200,000 字合成文件");
    await yieldToMain();
    try {
      const result = await runBenchmark(setStep);
      const next = [result, ...readHistory()].slice(0, HISTORY);
      writeHistory(next);
      setHistory(next);
    } catch (e) {
      setError(errText(e));
    } finally {
      setStep(null);
    }
  };

  const latest = history[0];

  return (
    <Panel className="lg:col-span-3" title="BENCHMARK · 200K CHARS" sub={`主執行緒阻塞門檻 < ${BLOCK_BUDGET_MS} ms · localStorage`}>
      <div className="flex flex-wrap items-center gap-3">
        <LabButton onClick={run} disabled={running}>{running ? "量測中…" : "Benchmark"}</LabButton>
        <span role="status" className="font-mono text-[11px] text-zinc-400">{step ?? (latest ? `上次：${new Date(latest.at).toLocaleString()}` : "尚未量測")}</span>
        {history.length > 0 && !running && (
          <LabButton tone="ghost" onClick={() => { writeHistory([]); setHistory([]); }}>清除紀錄</LabButton>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-[11px] text-[#00FFD1]">錯誤：{error}</p>}
      {latest && (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6" data-testid="bench-latest">
          {[
            ["主執行緒最大阻塞", ms(latest.maxBlockMs), latest.pass ? "PASS" : "FAIL"],
            ["最長 long task", ms(latest.longestTaskMs), latest.longestTaskMs === null ? "不支援" : ""],
            ["buildGraph (worker)", ms(latest.graphMs), `切 ${ms(latest.stageMs.chunk)} · 擷 ${ms(latest.stageMs.extract)} · 建 ${ms(latest.stageMs.build)}`],
            ["HNSW save", ms(latest.saveMs), `${latest.vectors} 向量`],
            ["HNSW load", ms(latest.loadMs), `插入 ${ms(latest.hnswBuildMs)}`],
            ["圖譜", `${latest.nodes} / ${latest.edges}`, `${latest.chunks} chunks`],
          ].map(([label, value, sub]) => (
            <div key={label} className={`rounded-xl border p-3 ${label === "主執行緒最大阻塞" && latest.pass ? "border-[#00FFD1]/40 bg-[#00FFD1]/[0.06]" : "border-white/[0.06]"}`}>
              <div className="font-mono text-[10px] text-zinc-500">{label}</div>
              <div className="mt-1 font-mono text-[16px] tabular-nums text-zinc-100">{value}</div>
              {sub && <div className="mt-0.5 truncate font-mono text-[10px] text-zinc-500">{sub}</div>}
            </div>
          ))}
        </div>
      )}
      {history.length > 1 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[560px] font-mono text-[10px] tabular-nums text-zinc-400">
            <thead className="text-left text-zinc-500">
              <tr><th className="py-1">時間</th><th>阻塞</th><th>buildGraph</th><th>save</th><th>load</th><th>結果</th></tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.at} className="border-t border-white/[0.04]">
                  <td className="py-1">{new Date(r.at).toLocaleString()}</td>
                  <td>{ms(r.maxBlockMs)}</td>
                  <td>{ms(r.graphMs)}</td>
                  <td>{ms(r.saveMs)}</td>
                  <td>{ms(r.loadMs)}</td>
                  <td className={r.pass ? "text-[#00FFD1]" : ""}>{r.pass ? "PASS" : "FAIL"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-[10px] text-zinc-600">分頁在背景時瀏覽器會節流計時器，阻塞值會失真；請保持此分頁在前景。</p>
    </Panel>
  );
}
