import DropZone from "@/components/DropZone";
import GraphWorkspace from "@/components/GraphWorkspace";
import PipelineView from "@/components/PipelineView";

export default function Home() {
  return (
    <main className="mx-auto max-w-6xl space-y-8 px-6 py-12">
      <header className="space-y-3">
        <h1 className="text-2xl text-violet-300">HYPERFORGE</h1>
        <p className="text-xs text-zinc-500">把文字整理成概念圖，並匯出重點內容。資料保存在目前的瀏覽器。</p>
      </header>
      <div aria-label="使用步驟" className="rounded-xl border border-white/10 bg-white/5 p-4">
        <ol className="grid gap-3 text-sm text-zinc-300 sm:grid-cols-3">
          <li><span className="text-violet-300">1. 加入文字</span><p className="mt-1 text-xs text-zinc-400">選擇文字檔，或在頁面空白處貼上文字。</p></li>
          <li><span className="text-violet-300">2. 查看概念</span><p className="mt-1 text-xs text-zinc-400">點選圖上的概念，查看對應的原文。</p></li>
          <li><span className="text-violet-300">3. 匯出內容</span><p className="mt-1 text-xs text-zinc-400">在圖旁的輸出面板選擇格式，再複製或下載。</p></li>
        </ol>
      </div>
      <DropZone />
      <PipelineView />
      <GraphWorkspace />
    </main>
  );
}

