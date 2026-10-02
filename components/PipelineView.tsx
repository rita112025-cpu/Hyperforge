"use client";
import { motion } from "framer-motion";
import { useForge } from "@/lib/store";
import { STAGE_LABEL_ZH } from "@/lib/pipeline/types";

const JOB_LABEL = { running: "FORGING…", done: "DONE", partial: "PARTIAL（部分階段未接入）", error: "ERROR", cancelled: "CANCELLED" } as const;

export default function PipelineView() {
  const jobs = useForge((s) => s.jobs);
  const cancel = useForge((s) => s.cancel);
  if (!jobs.length) return null;
  return (
    <div className="space-y-4">
      {jobs.map((job) => (
        <div key={job.id} className="scanlines relative overflow-hidden rounded-xl border border-white/10 bg-white/5 p-4 font-mono backdrop-blur">
          <div className="mb-3 flex items-center justify-between gap-3 text-sm">
            <span
              className={`min-w-0 truncate ${job.status === "running" ? "glitch text-neon-cyan" : "text-zinc-200"}`}
              data-text={job.name}
              title={job.name}
            >
              {job.name}
            </span>
            <span className="flex shrink-0 items-center gap-2 text-xs text-zinc-500">
              {JOB_LABEL[job.status]}
              {job.status === "running" && (
                <button className="rounded border border-white/10 px-1.5 hover:border-red-400 hover:text-red-300" onClick={() => cancel(job.id)}>
                  取消
                </button>
              )}
            </span>
          </div>
          <ol className="space-y-2">
            {job.stages.map((st) => (
              <li key={st.id} className="text-xs">
                <div className="mb-1 flex justify-between text-zinc-400">
                  <span>
                    [{st.id} {STAGE_LABEL_ZH[st.id]}]
                    {st.status === "skipped" && <span className="ml-2 text-zinc-500">未接入</span>}
                  </span>
                  <span>{st.status === "skipped" ? "—" : `${Math.round(st.progress * 100)}%`}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded bg-zinc-800">
                  <motion.div
                    className={`h-full ${st.status === "error" ? "bg-red-500" : "bg-gradient-to-r from-violet-400 to-cyan-400"}`}
                    animate={{ width: `${st.progress * 100}%` }}
                    transition={{ duration: 0.1 }}
                  />
                </div>
                {st.note && <div className="mt-0.5 break-all text-[10px] text-zinc-600">{st.note}</div>}
              </li>
            ))}
          </ol>
          {job.error && <div className="mt-3 text-xs text-red-400">{job.error}</div>}
          {job.context && (
            <div className="mt-3 text-[11px] text-zinc-500">
              {job.context.chunks.length} chunks · 關鍵字：{job.context.keywords.slice(0, 8).join("、") || "—（中文關鍵字待 embedding 輪次）"}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
