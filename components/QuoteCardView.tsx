"use client";
import { useEffect, useRef, useState } from "react";
import { copyImage, downloadBlob, toPngBlob } from "../lib/outputs/export";
import { CARD_MAX_CARDS, CARD_SIZE, CARD_FONT_FAMILY, buildCards, cardAltText, measureWith, renderCard, type CardCtx, type CardsResult } from "../lib/outputs/quotecard";
import type { Digest } from "../lib/outputs/digest";

/**
 * 金句卡：1080×1080 Canvas 預覽，可下載 PNG、複製圖片。
 * 繪製前等待 document.fonts.ready；字型是系統字型堆疊（專案沒有自託管字型，不同 OS 外觀不同）。
 * 使用者原文只用 fillText 畫，不經 HTML。
 */
export default function QuoteCardView({ digest }: { digest: Digest }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<CardsResult | null>(null);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // 版面（含量測）需要 canvas context 與字型；字型就緒後才算，避免用備用字型量出錯的行寬
  useEffect(() => {
    let off = false;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    void (async () => {
      try {
        await document.fonts.ready;
      } catch {
        /* 不支援 document.fonts：直接用目前字型 */
      }
      if (!off) setResult(buildCards(digest, measureWith(ctx as unknown as CardCtx)));
    })();
    return () => {
      off = true;
    };
  }, [digest]);

  const card = result?.cards[Math.min(index, (result?.cards.length ?? 1) - 1)];

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !card) return;
    canvas.width = CARD_SIZE;
    canvas.height = CARD_SIZE;
    renderCard(ctx as unknown as CardCtx, card, CARD_FONT_FAMILY);
  }, [card]);

  const download = async () => {
    const blob = await toPngBlob(canvasRef.current);
    if (!blob) return setFlash({ kind: "err", text: "無法產生 PNG（toBlob 回傳 null：可能是記憶體不足）" });
    const name = downloadBlob(`hyperforge-quote-${index + 1}.png`, blob);
    setFlash({ kind: "ok", text: `已下載 ${name}（${CARD_SIZE}×${CARD_SIZE}，${Math.round(blob.size / 1024)} KB）` });
  };

  const copyAsImage = async () => {
    const blob = await toPngBlob(canvasRef.current);
    if (!blob) return setFlash({ kind: "err", text: "無法產生 PNG（toBlob 回傳 null：可能是記憶體不足）" });
    const r = await copyImage(blob);
    if (r.ok) return setFlash({ kind: "ok", text: "已複製圖片" });
    const name = downloadBlob(`hyperforge-quote-${index + 1}.png`, blob);
    setFlash({ kind: "err", text: `無法複製圖片（${r.error}），已改為下載 ${name}` });
  };

  return (
    <div className="space-y-2" data-testid="output-quotecard">
      <div className="text-[10px] text-zinc-500">
        只用較短的原文句子（不截斷或改寫引文）；卡片只含引文行、來源文件名與固定的 HyperForge 浮水印。字型為系統字型堆疊，不同作業系統外觀會略有不同。
      </div>
      {result && result.cards.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div role="group" aria-label="選擇金句卡" className="flex gap-1">
            {result.cards.map((_, i) => (
              <button
                key={i}
                aria-pressed={i === index}
                onClick={() => setIndex(i)}
                className={`rounded border px-1.5 py-0.5 text-[11px] ${i === index ? "border-neon-cyan text-neon-cyan" : "border-white/15 text-zinc-300 hover:border-violet-300"}`}
                data-testid={`card-${i + 1}`}
              >
                {i + 1}/{result.cards.length}
              </button>
            ))}
          </div>
          <button className="rounded border border-neon-cyan px-2 py-0.5 text-neon-cyan hover:bg-cyan-400/10" onClick={download} data-testid="card-download">
            下載 PNG
          </button>
          <button className="rounded border border-white/15 px-2 py-0.5 text-zinc-200 hover:border-violet-300" onClick={copyAsImage} data-testid="card-copy">
            複製圖片
          </button>
          {flash && (
            <span className={flash.kind === "ok" ? "text-emerald-300" : "text-amber-300"} role="status" data-testid="card-flash">
              {flash.text}
            </span>
          )}
        </div>
      )}
      <canvas
        ref={canvasRef}
        width={CARD_SIZE}
        height={CARD_SIZE}
        role="img"
        aria-label={card ? `金句卡：${cardAltText(card)}` : "金句卡（沒有可用的句子）"}
        className={`w-full max-w-sm rounded border border-white/10 ${card ? "" : "hidden"}`}
        data-testid="card-canvas"
      />
      {card && (
        <p className="whitespace-pre-wrap break-words rounded border border-white/5 bg-black/20 p-2 text-xs text-zinc-300" data-testid="card-text">
          {card.sentence.text}
          <span className="text-zinc-500">（{card.sentence.docName}）</span>
        </p>
      )}
      {result?.notes.map((n, i) => (
        <div key={i} className="text-[10px] text-amber-300/80" data-testid="card-note">
          {n}
        </div>
      ))}
      <div className="sr-only" data-testid="card-max">
        最多 {CARD_MAX_CARDS} 張
      </div>
    </div>
  );
}
