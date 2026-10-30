import type { ReactNode } from "react";

/** forge-lab 共用外框：黑曜石底、cyan 單色。 */
export function Panel({ title, sub, children, className = "" }: { title: string; sub?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-[20px] border border-white/[0.08] bg-white/[0.02] p-1 ${className}`} aria-label={title}>
      <div className="h-full rounded-[16px] bg-[#0A0A0F] p-4">
        <header className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="font-mono text-[11px] tracking-[0.2em] text-[#00FFD1]">{title}</h2>
          {sub && <span className="font-mono text-[10px] text-zinc-500">{sub}</span>}
        </header>
        {children}
      </div>
    </section>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.04] py-1 font-mono text-[11px]">
      <span className="text-zinc-500">{label}</span>
      <span className="tabular-nums text-zinc-100">{value}</span>
    </div>
  );
}

export function LabButton({ children, onClick, disabled, tone = "solid" }: { children: ReactNode; onClick: () => void; disabled?: boolean; tone?: "solid" | "ghost" }) {
  const look = tone === "solid"
    ? "bg-[#00FFD1] text-black hover:bg-[#00FFD1]/85"
    : "border border-[#00FFD1]/30 text-[#00FFD1] hover:bg-[#00FFD1]/10";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full px-3 py-1 font-mono text-[11px] tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00FFD1] disabled:opacity-30 ${look}`}
    >
      {children}
    </button>
  );
}

export const ms = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
