import DropZone from "@/components/DropZone";
import PipelineView from "@/components/PipelineView";

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl space-y-8 px-6 py-16">
      <header>
        <h1 className="text-2xl text-violet-300">HYPERFORGE</h1>
        <p className="text-xs text-zinc-500">混沌煉金工廠 · Local-First Knowledge Forge</p>
      </header>
      <DropZone />
      <PipelineView />
    </main>
  );
}
