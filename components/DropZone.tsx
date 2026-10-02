"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForge } from "@/lib/store";
import type { IngestSource } from "@/lib/pipeline/types";

function classifyUrl(text: string): IngestSource | null {
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^www\./, "");
  const subtype = /(^|\.)youtube\.com$|^youtu\.be$/.test(host) ? "youtube" : host === "github.com" ? "github" : "web";
  return { kind: "url", url: u.href, subtype };
}

export default function DropZone() {
  const ingest = useForge((s) => s.ingest);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      Array.from(e.dataTransfer.files).forEach((file) => void ingest({ kind: "file", file }));
    },
    [ingest],
  );

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length) {
        files.forEach((file) => void ingest({ kind: "file", file }));
        return;
      }
      const text = e.clipboardData?.getData("text/plain");
      if (!text?.trim()) return;
      void ingest(classifyUrl(text) ?? { kind: "text", text });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [ingest]);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      onClick={() => input.current?.click()}
      className={`relative cursor-pointer rounded-2xl border border-dashed p-16 text-center font-mono backdrop-blur transition-colors ${
        over ? "border-neon-cyan bg-cyan-400/10" : "border-violet-400/40 bg-white/5 hover:border-violet-300"
      }`}
    >
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          Array.from(e.target.files ?? []).forEach((file) => void ingest({ kind: "file", file }));
          e.target.value = "";
        }}
      />
      <div className="text-lg text-violet-200">拖入任何東西 · DROP ANYTHING</div>
      <div className="mt-2 text-xs text-zinc-500">目前僅支援文字類檔案（.md / .txt / 程式碼）與貼上文字 (Ctrl+V)；PDF / 圖片 / 音訊 / 影片 / zip / 連結 尚未支援，會顯示錯誤</div>
    </div>
  );
}
