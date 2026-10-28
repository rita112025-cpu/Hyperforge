'use client'

import { useEffect, useState, useRef } from 'react'
import ObsidianTask4Panel from '@/components/ObsidianTask4Panel'
import WorkerStatusLight from '@/components/WorkerStatusLight'
import { getDeconstructClient } from '@/lib/pipeline/deconstruct-client'
import { getGraphClient } from '@/lib/graph/graph-client'
import { contentIdOf, docFromJobResult, loadCorpus, saveDocument } from '@/lib/graph/corpus'
import type { GraphDocument, GraphModel } from '@/lib/graph/types'
import { runPipeline } from '@/lib/pipeline/runner'
import type { StageId, TextStatus, VectorStatus } from '@/lib/pipeline/types'
import { getVectorStore } from '@/lib/vector/runtime'
import { getSharedDb } from '@/lib/vector/shared-db'

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

type Phase = 'idle' | 'atom' | 'commit' | 'link' | 'canvas' | 'done'
const PHASES = [
  { id: 'atom', label: 'ATOM_DECOMPOSE', zh: '原子解構', desc: 'PARSE / DECONSTRUCT' },
  { id: 'commit', label: 'TEXT_COMMIT', zh: '文字提交', desc: 'Dexie docs+chunks 原子寫入' },
  { id: 'link', label: 'VECTOR_LINK', zh: '暗流連結', desc: 'HNSW + embedding' },
  { id: 'canvas', label: 'CANVAS_FORGE', zh: '畫布煉成', desc: 'graph.worker 建圖' },
] as const

export default function Obsidian9PageV6() {
  const [input, setInput] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [activeIdx, setActiveIdx] = useState(0)
  const [logs, setLogs] = useState<string[]>([])
  const [textStatus, setTextStatus] = useState<TextStatus>('pending')
  const [vectorStatus, setVectorStatus] = useState<VectorStatus>('pending')
  const [docs, setDocs] = useState<GraphDocument[]>([])
  const [graph, setGraph] = useState<GraphModel | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const textStatusRef = useRef<TextStatus>('pending')

  const isRunning = phase !== 'idle' && phase !== 'done'

  const log = (msg: string) => setLogs(l => [...l.slice(-100), `[${new Date().toLocaleTimeString()}] ${msg}`])

  /** 在 graph.worker 建圖；取消或失敗只記 log，不影響文字 commit 結果。 */
  const rebuildGraph = async (corpus: GraphDocument[], signal: AbortSignal): Promise<GraphModel | null> => {
    try {
      const nextGraph = await getGraphClient().build(corpus, { signal })
      setDocs(corpus)
      setGraph(nextGraph)
      return nextGraph
    } catch (error) {
      log(isAbort(error) ? 'buildGraph 已取消 (Worker)' : `buildGraph 失敗: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    void loadCorpus(getSharedDb()).then((stored) => {
      if (cancelled || stored.length === 0) return
      setDocs(stored)
      void getGraphClient().build(stored, { signal: controller.signal }).then((g) => { if (!cancelled) setGraph(g) }).catch(() => undefined)
      setTextStatus('ready')
      textStatusRef.current = 'ready'
      setPhase('done')
      setActiveIdx(4)
      setLogs(l => [...l, `[${new Date().toLocaleTimeString()}] 從 IndexedDB 還原 ${stored.length} 份文件`])
    }).catch((error: unknown) => {
      if (!cancelled) setLogs(l => [...l, `[${new Date().toLocaleTimeString()}] 還原文件失敗: ${error instanceof Error ? error.message : String(error)}`])
    })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])

  const handleCancel = () => {
    if (abortRef.current) {
      abortRef.current.abort()
      log('使用者取消 - 檢查 Text commit point')
    }
  }

  const handleRun = async () => {
    if (!input.trim() || isRunning) return
    
    const controller = new AbortController()
    abortRef.current = controller
    setPhase('atom')
    setActiveIdx(0)
    setLogs([])
    setTextStatus('pending')
    textStatusRef.current = 'pending'
    setVectorStatus('pending')
    setGraph(null)
    log(`投料 ${input.length} chars`)

    try {
      log('PARSE / DECONSTRUCT 開始...')
      const pipelineResult = await runPipeline({ kind: 'text', text: input }, {
        signal: controller.signal,
        getStore: getVectorStore,
        chunker: (text, signal) => getDeconstructClient().deconstruct(text, signal),
        onStage: (stageId: StageId, patch) => {
          const detail = patch.note ? ` - ${patch.note}` : ''
          log(`${stageId} ${patch.status ?? ''} ${patch.progress !== undefined ? `${Math.round(patch.progress * 100)}%` : ''}${detail}`.trim())
          if (stageId === 'PARSE' || stageId === 'DECONSTRUCT') {
            setPhase('atom')
            setActiveIdx(0)
          } else if (stageId === 'LINK') {
            setPhase('link')
            setActiveIdx(2)
          }
        },
        onTextReady: async (payload) => {
          setPhase('commit')
          setActiveIdx(1)
          const db = getSharedDb()
          const saved = await saveDocument(db, payload)
          const fallbackIdentity = await contentIdOf(payload.rawText)
          const identity = saved ?? { docId: fallbackIdentity.id, created: false }
          const status: TextStatus = saved ? 'ready' : 'persist_failed'
          const note = saved
            ? (saved.created ? '文字已存入 IndexedDB' : '文字已存在於 IndexedDB')
            : '環境不支援持久化；本次工作階段仍保留文字'
          textStatusRef.current = status
          setTextStatus(status)
          log(`TEXT COMMIT POINT - ${note} docId=${identity.docId.slice(0, 8)} chunks=${payload.chunks.length}`)

          const corpus = saved
            ? await loadCorpus(db)
            : [docFromJobResult(payload, identity.docId)]
          setPhase('canvas')
          setActiveIdx(3)
          const nextGraph = await rebuildGraph(corpus, controller.signal)
          if (nextGraph) log(`buildGraph 完成 nodes=${nextGraph.nodes.length} edges=${nextGraph.edges.length} (Worker)`)
          return { status, docId: identity.docId, note }
        },
      })

      textStatusRef.current = pipelineResult.textStatus
      setTextStatus(pipelineResult.textStatus)
      setVectorStatus(pipelineResult.vectorStatus)

      // 最後再從 DB 重建一次，確保重新整理後也能顯示（text-first persistence）；仍可取消
      try {
        const corpus = await loadCorpus(getSharedDb())
        if (await rebuildGraph(corpus, controller.signal)) log(`重新整理後可重建 corpus docs=${corpus.length}`)
      } catch (error) {
        log(`重新載入 corpus 失敗: ${error instanceof Error ? error.message : String(error)}`)
      }

      setPhase('done')
      setActiveIdx(4)
      log(`DONE text=${pipelineResult.textStatus} vector=${pipelineResult.vectorStatus}`)

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      if (isAbort(err) || message.toLowerCase().includes('aborted')) {
        log(`CANCELLED - ${message} 文字已保留=${textStatusRef.current === 'ready' ? '是' : '否'}`)
        setPhase('done') // 取消後也是 done，但顯示文字已保留
        setVectorStatus('cancelled')
      } else {
        log(`ERROR: ${message}`)
        console.error(err)
        setPhase('idle')
      }
    } finally {
      abortRef.current = null
    }
  }

  return (
    <div className="min-h-screen bg-[#050507] text-zinc-100">
      <div className="h-9 border-b border-white/[0.08] flex items-center px-4 gap-4 text-[11px] font-mono">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[#00FFD1] shadow-[0_0_8px_#00FFD1]" />
          <span className="tracking-widest">OBSIDIAN-9 v6 · TASK 4 ONLINE</span>
        </div>
        <div className="ml-auto flex gap-2">
          <WorkerStatusLight />
          <span className={`px-2 py-0.5 rounded border ${textStatus==='ready' ? 'bg-emerald-500/20 border-emerald-500/30' : 'bg-white/5 border-white/10'}`}>文字:{textStatus}</span>
          <span className={`px-2 py-0.5 rounded border ${vectorStatus==='indexed' ? 'bg-emerald-500/20 border-emerald-500/30' : vectorStatus==='cancelled' ? 'bg-amber-500/20 border-amber-500/30' : 'bg-white/5 border-white/10'}`}>向量:{vectorStatus}</span>
        </div>
      </div>

      <div className="max-w-[1600px] mx-auto grid grid-cols-12">
        <div className="col-span-12 lg:col-span-8 p-6">
          <div className="rounded-[20px] border border-white/[0.08] bg-white/[0.02] p-1">
            <div className="rounded-[16px] bg-[#0A0A0F] p-6">
              <div className="flex justify-between mb-4">
                <h1 className="text-[11px] tracking-[0.2em] opacity-60 font-mono">投料口 - 已接真 pipeline (v6 Task1)</h1>
                {isRunning && <button onClick={handleCancel} className="text-[11px] px-3 py-1 rounded-full bg-red-500/20 border border-red-500/30 hover:bg-red-500/30">取消（含 Worker 建圖）</button>}
              </div>
              <textarea
                value={input}
                onChange={e=>setInput(e.target.value)}
                onKeyDown={e=>{ if((e.metaKey||e.ctrlKey) && e.key==='Enter') handleRun() }}
                placeholder="貼文字... 會走真實的 lib/pipeline/runner.ts → saveDocument (同一個 Dexie transaction) → 文字先提交 → 再向量化"
                className="w-full h-[140px] bg-transparent outline-none resize-none text-[14px] leading-6 placeholder:text-zinc-600"
              />
              <button
                onClick={handleRun}
                disabled={isRunning || !input.trim()}
                className="mt-4 h-11 px-8 rounded-full bg-[#00FFD1] text-black font-bold text-[13px] tracking-widest disabled:opacity-30">
                {isRunning ? `煉金中... ${PHASES[activeIdx]?.zh || ''}` : '執行真煉金 [⌘+Enter]'}
              </button>

              <div className="mt-6 grid grid-cols-4 gap-2">
                {PHASES.map((p, idx)=>{
                  const active = idx===activeIdx && isRunning
                  const done = idx < activeIdx || phase==='done' || phase===p.id
                  return (
                    <div key={p.id} className={`rounded-xl border p-3 ${active ? 'border-[#00FFD1]/50 bg-[#00FFD1]/10' : done ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-white/5 bg-white/[0.02]'}`}>
                      <div className="text-[10px] font-mono opacity-50">{p.label}</div>
                      <div className="text-[13px] font-bold">{p.zh}</div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {phase==='done' && (
            <div className="mt-6 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-[12px] font-mono">
              <div>Task1 完成檢查：</div>
              <div className="mt-1 opacity-80">- 文字是否 ready: {textStatus}</div>
              <div className="opacity-80">- 向量是否 indexed/failed/cancelled: {vectorStatus}</div>
              <div className="opacity-80">- 圖譜: {graph ? `${graph.nodes.length} nodes / ${graph.edges.length} edges` : '尚未建立'}</div>
              <div className="opacity-80">- 重新整理後文件是否還在 (text-first persistence)</div>
            </div>
          )}
        </div>

        <div className="col-span-12 lg:col-span-4 border-l border-white/[0.06] bg-[#08080B] p-4">
          <div className="text-[11px] font-mono opacity-50 mb-2">SYSTEM LOG - 接真實 onProgress</div>
          <div className="rounded-xl bg-black border border-white/10 p-3 h-[500px] overflow-auto font-mono text-[11px] leading-5">
            {logs.length===0 ? <span className="opacity-30">等待... 會顯示真實的 PARSE/DECONSTRUCT/TEXT_COMMIT/LINK 事件</span> : logs.map((l,i)=><div key={i} className="opacity-70">{l}</div>)}
          </div>
        </div>
      </div>
      {graph && docs.length > 0 && (
        <div className="mx-auto max-w-[1600px] px-4 pb-8 sm:px-6">
          <ObsidianTask4Panel docs={docs} graph={graph} />
        </div>
      )}
    </div>
  )
}
