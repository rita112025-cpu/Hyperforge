"use client";
import { motion } from "framer-motion";
import { useForge } from "@/lib/store";
import { TEXT_LABEL, VECTOR_LABEL, canRetryIndexing } from "@/lib/pipeline/doc-state";
import { STAGE_LABEL_ZH, type DocVectorState, type IngestJob } from "@/lib/pipeline/types";

// done = 文字已就緒且語意索引完成；partial = 文字可用，但非使用者原因導致語意索引沒完成；cancelled = 使用者取消（文字若已 commit 則保留）
const JOB_LABEL = {
  running: "FORGING…",
  done: "DONE（文字與語意索引完成）",
  partial: "PARTIAL（文字可用，語意索引未完成）",
  error: "ERROR",
  cancelled: "CANCELLED",
} as const;

/** 這份 job 的文字 / 語意索引狀態列。語意索引以「文件目前的狀態」為準（retry 之後會更新），沒有 docId（未 commit）時用 job 自己的結果。 */
function JobTextVector({ job }: { job: IngestJob }) {
  const info = useForge((s) => (job.docId ? s.docInfo[job.docId] : undefined));
  const retry = useForge((s) => s.retryIndexing);
  const vector: DocVectorState = info?.vector ?? (job.status === "running" && job.textStatus === "ready" ? "building" : job.vectorStatus);
  const kept = job.textStatus === "ready" && (vector === "cancelled" || vector === "failed" || vector === "unavailable");
  const unsaved = job.textStatus === "persist_failed";
  return (
    <div className="mt-2 space-y-0.5 text-[11px]" data-testid="job-text-vector">
      <div className={unsaved ? "text-amber-300" : "text-zinc-400"} data-testid="job-text-status">
        文字：{job.status === "cancelled" && job.textStatus === "pending" ? "未就緒（已取消，沒有留下任何資料）" : TEXT_LABEL[job.textStatus]}
        {job.textNote && job.textStatus === "ready" && <span className="ml-1 text-zinc-600">· {job.textNote}</span>}
      </div>
      {(job.textStatus !== "pending" || job.status !== "cancelled") && job.status !== "error" && (
        <div className="flex flex-wrap items-center gap-2 text-zinc-400" data-testid="job-vector-status">
          <span>
            語意索引：{VECTOR_LABEL[vector]}
            {kept && <span className="ml-1 text-zinc-500">（文字已保留）</span>}
            {vector === "building" && info?.progress !== undefined && ` ${Math.round(info.progress * 100)}%`}
          </span>
          {canRetryIndexing(info) && job.docId && (
            <button
              className="rounded border border-neon-cyan px-1.5 py-0.5 text-neon-cyan hover:bg-cyan-400/10"
              onClick={() => void retry(job.docId!)}
              data-testid="retry-indexing"
            >
              重新建立索引
            </button>
          )}
        </div>
      )}
      {unsaved && <div className="text-amber-300/90">尚未儲存，重新整理後可能遺失。{job.textNote ?? ""}</div>}
    </div>
  );
}

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
            <span className="flex shrink-0 items-center gap-2 text-xs text-zinc-500" data-testid="job-status" data-status={job.status}>
              {JOB_LABEL[job.status]}
              {job.status === "running" && (
                <button
                  className="rounded border border-white/10 px-1.5 hover:border-red-400 hover:text-red-300"
                  onClick={() => cancel(job.id)}
                  data-testid="cancel-job"
                >
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
          <JobTextVector job={job} />
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
