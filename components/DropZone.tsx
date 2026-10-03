"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForge } from "@/lib/store";
import type { IngestSource } from "@/lib/pipeline/types";

export function classifyUrl(text: string): IngestSource | null {
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

/**
 * 全域 paste 只應處理「頁面空白處」的貼上。
 * 使用者正在 input / textarea / contenteditable / textbox 中編輯時，不可同時把文字匯入成新文件。
 * 這裡刻意避免依賴 DOM instanceof，讓 SSR / Node 測試也能安全載入。
 */
export function isEditablePasteTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as EventTarget & {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => unknown;
  };
  const tag = el.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  return Boolean(el.closest?.('[contenteditable="true"], [contenteditable=""], [role="textbox"]'));
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
      if (isEditablePasteTarget(e.target)) return;
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
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          input.current?.click();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label="匯入文件：可點擊選檔、拖放檔案，或在非輸入欄位貼上文字"
      className={`relative cursor-pointer rounded-2xl border border-dashed p-16 text-center font-mono backdrop-blur transition-colors focus:outline-none focus:ring-2 focus:ring-violet-300 ${
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
