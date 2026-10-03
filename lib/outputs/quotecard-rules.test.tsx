import { describe, expect, it, vi } from "vitest";
import { buildGraph } from "../graph/build";
import type { GraphDocument } from "../graph/types";
import { chunkText } from "../pipeline/chunker";
import { buildDigest } from "./digest";
import { copyImage, toPngBlob, type BlobCanvas } from "./export";
import {
  CARD_MAX_CHARS,
  CARD_TEXT_WIDTH,
  CARD_WATERMARK,
  MAX_HANG,
  NO_LINE_END,
  NO_LINE_START,
  buildCards,
  cardFont,
  ellipsize,
  hasBidi,
  measureWith,
  renderCard,
  stripBidi,
  wrapText,
  type CardCtx,
  type Measure,
} from "./quotecard";

const measure: Measure = (t, px) => Array.from(t).reduce((w, ch) => w + (/[⺀-鿿＀-￯　-〿\u{20000}-\u{2fa1f}]/u.test(ch) ? px : px * 0.5), 0);
const doc = (name: string, text: string): GraphDocument => ({ id: `id-${name}`, name, rawText: text, chunks: chunkText(text).map((c) => ({ index: c.index, start: c.start, end: c.end })) });
const NL = String.fromCharCode(10);
const noLoneSurrogate = (s: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

describe("以 code point 為單位", () => {
  it("補充平面漢字與 emoji 不會被切成半個字；位移落在 code point 邊界；串回等於原文", () => {
    const text = "𠮷野家的𠮷字與😀表情符號需要保持淨距😀，避免訊號干擾😀𠮷。";
    for (const px of [72, 56, 40]) {
      for (const w of [300, 420, 600]) {
        const lines = wrapText(text, w, px, measure);
        for (const l of lines) {
          expect(noLoneSurrogate(l.text), `${JSON.stringify(l.text)}`).toBe(true);
          expect(text.slice(l.start, l.end)).toBe(l.text);
        }
        expect(lines.map((l) => l.text).join("")).toBe(text);
      }
    }
  });
  it("引文長度上限以 code point 計：一個補充平面字算 1", () => {
    const s = "𠮷".repeat(CARD_MAX_CHARS);
    expect(Array.from(s).length).toBe(CARD_MAX_CHARS);
    expect(s.length).toBe(CARD_MAX_CHARS * 2);
  });
});

describe("避頭尾的進階情況", () => {
  const check = (text: string, widths: number[], px = 56) => {
    for (const w of widths) {
      const lines = wrapText(text, w, px, measure);
      for (const l of lines.slice(1)) expect(NO_LINE_START.has(Array.from(l.text)[0]), `${JSON.stringify(l.text)} @${w}`).toBe(false);
      for (const l of lines) expect(NO_LINE_END.has(Array.from(l.text).at(-1)!), `${JSON.stringify(l.text)} @${w}`).toBe(false);
      expect(lines.map((l) => l.text).join(""), `@${w}`).toBe(text);
      // 行寬 ≤ 上限；唯一的例外是「標點懸掛」：行尾最多 MAX_HANG 個行首禁則標點可以超出
      for (const l of lines) {
        const chars = Array.from(l.text);
        let hang = 0;
        while (hang < MAX_HANG && chars.length > 1 && NO_LINE_START.has(chars[chars.length - 1 - hang])) hang++;
        const body = chars.slice(0, chars.length - hang).join("");
        expect(measure(body, px) <= w || chars.length === 1, `${l.text} @${w}`).toBe(true);
      }
    }
    return wrapText(text, widths[0], px, measure);
  };
  it("連續標點整串處理（。」）、（。）」", () => {
    check("他說這件事一定要做完。」然後又補充：（請務必確認。）」最後離開。", [240, 260, 300, 340, 400, 460]);
  });
  it("成對不可拆的符號（……、——）不會被斷在中間", () => {
    const text = "電纜槽與通信線纜架需要保持淨距……避免訊號干擾——並且定期檢查支撐間距。";
    for (const w of [220, 260, 300, 340, 400]) {
      const lines = wrapText(text, w, 56, measure);
      for (const l of lines) {
        expect(l.text.endsWith("…") && !l.text.endsWith("……") && text.slice(l.end).startsWith("…"), `……被拆開：${JSON.stringify(l.text)}`).toBe(false);
        expect(l.text.endsWith("—") && !l.text.endsWith("——") && text.slice(l.end).startsWith("—"), `——被拆開：${JSON.stringify(l.text)}`).toBe(false);
      }
      expect(lines.map((l) => l.text).join("")).toBe(text);
    }
  });
  it("搬下去的字讓下一行超寬時，會遞迴重排到穩定（每行寬度都在上限內）", () => {
    check("「電纜槽」與（通信線纜架）、《規範》；【附錄】需要保持淨距。」」", [240, 260, 300, 340]);
  });
  it("英文單字與數字串不被拆開（中英混排）；單字本身比整行還寬才逐字斷", () => {
    const text = "Cable tray 與通信線纜架在 2024 年需要保持 clearance，避免干擾。";
    for (const w of [200, 260, 340, 420, 520]) {
      const lines = wrapText(text, w, 48, measure);
      const words = new Set(["Cable", "tray", "2024", "clearance"]);
      for (const l of lines) for (const m of l.text.match(/[A-Za-z0-9]+/g) ?? []) {
        if (words.has(m)) continue;
        expect(["C", "a", "b", "l", "e", "t", "r", "y", "20", "24", "clear", "ance"].some((x) => m.includes(x) || x.includes(m)) || m.length <= 1, `${m} @${w}`).toBe(true);
      }
      // 完整的單字一定出現在某一行裡（沒有被拆開）
      const joined = lines.map((l) => l.text);
      for (const wd of words) if (measure(wd, 48) <= w) expect(joined.some((t) => t.includes(wd)), `${wd} 被拆開 @${w}`).toBe(true);
      expect(lines.map((l) => l.text).join("").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
    }
    const long = wrapText("Supercalifragilisticexpialidocious", 300, 56, measure);
    expect(long.length).toBeGreaterThan(1);
    expect(long.map((l) => l.text).join("")).toBe("Supercalifragilisticexpialidocious");
  });
});

describe("量測與繪製使用同一個 ctx 與同一個字型", () => {
  const mockCtx = () => {
    const log: Array<{ op: "measure" | "fill"; font: string; text: string }> = [];
    let font = "";
    const ctx: CardCtx = {
      get font() {
        return font;
      },
      set font(v: string) {
        font = v;
      },
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      textAlign: "left",
      textBaseline: "top",
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      fillText: (t) => void log.push({ op: "fill", font, text: t }),
      measureText: (t) => (log.push({ op: "measure", font, text: t }), { width: measure(t, Number(/(\d+)px/.exec(font)?.[1] ?? 40)) }),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
    };
    return { ctx, log };
  };
  const ZH = ["電纜槽與通信線纜架需要保持淨距，避免訊號干擾。", "弱電橋架與其他管線應保持安全間距，方便日後維修。", "機房內的電纜槽必須分類敷設，強電與弱電不得混放。", "電纜槽內的線纜不得超過容量，橋架需預留擴充空間。", "通信線纜架的支撐間距應定期檢查，確保荷重安全。"].join(NL);
  const docs = [doc("管線規範.md", ZH), doc("施工筆記.md", ZH.split(NL).slice(1).join(NL) + NL + "弱電橋架內的線纜應整齊綁紮，並標示用途。")];
  const d = buildDigest(docs, buildGraph(docs));

  it("引文各行：量測時的字型字串 === 繪製時的字型字串（600 Npx family）", () => {
    const { ctx, log } = mockCtx();
    const r = buildCards(d, measureWith(ctx));
    expect(r.cards.length).toBeGreaterThan(0);
    const card = r.cards[0];
    log.length = 0;
    const drawn = renderCard(ctx, card);
    const fills = log.filter((x) => x.op === "fill");
    const lineFills = fills.slice(0, card.lines.length);
    expect(lineFills.map((x) => x.text)).toEqual(card.lines.map((l) => l.text));
    for (const f of lineFills) expect(f.font).toBe(cardFont(card.fontPx));
    // 版面階段量測最終字級時用的也是同一個字型字串
    const { ctx: c2, log: log2 } = mockCtx();
    buildCards(d, measureWith(c2));
    expect(log2.some((x) => x.op === "measure" && x.font === cardFont(card.fontPx))).toBe(true);
    expect(drawn.at(-1)).toBe(CARD_WATERMARK);
  });
  it("畫布固定為 1080×1080、不乘 devicePixelRatio（原始碼層級守門）", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../../components/QuoteCardView.tsx", import.meta.url), "utf8");
    expect(src).toContain("canvas.width = CARD_SIZE");
    expect(src).not.toMatch(/devicePixelRatio/);
  });
});

describe("文件名標籤與雙向控制字元", () => {
  it("ellipsize：過長時以量測結果截斷並加省略號；不超寬；短標籤不動；以 code point 計", () => {
    const w = (t: string) => measure(t, 32);
    expect(ellipsize("短檔名.md", 840, w)).toBe("短檔名.md");
    const long = "非常長的文件名稱".repeat(10) + ".md";
    const out = ellipsize(long, 400, w);
    expect(out.endsWith("…")).toBe(true);
    expect(w(out)).toBeLessThanOrEqual(400);
    expect(out.length).toBeLessThan(long.length);
    const astral = ellipsize("𠮷".repeat(60), 300, w);
    expect(noLoneSurrogate(astral)).toBe(true);
  });
  it("stripBidi / hasBidi：移除 U+202A–202E、U+2066–2069、U+200E/F；hasBidi 無狀態（可重複呼叫）", () => {
    const bad = "a‮b⁦c‏d";
    expect(stripBidi(bad)).toBe("abcd");
    expect(hasBidi(bad)).toBe(true);
    expect(hasBidi(bad)).toBe(true); // 第二次也要是 true（不能被 /g 的 lastIndex 影響）
    expect(hasBidi("正常文字")).toBe(false);
  });
  it("renderCard：文件名中的雙向控制字元被移除後才畫；過長的文件名被截斷（引文行不受影響）", () => {
    const text = ["電纜槽與通信線纜架需要保持淨距，避免訊號干擾。", "弱電橋架與其他管線應保持安全間距，方便日後維修。", "機房內的電纜槽必須分類敷設，強電與弱電不得混放。", "電纜槽內的線纜不得超過容量，橋架需預留擴充空間。"].join(NL);
    const name = "‮" + "很長的檔名".repeat(40) + ".md";
    const docs = [doc(name, text), doc("b.md", text)];
    const dg = buildDigest(docs, buildGraph(docs));
    const r = buildCards(dg, measure);
    const card = r.cards.find((c) => c.sentence.docName === name) ?? r.cards[0];
    const drawnLabel: string[] = [];
    const ctx: CardCtx = {
      font: "", fillStyle: "", strokeStyle: "", lineWidth: 1, textAlign: "left", textBaseline: "top",
      fillRect: vi.fn(), strokeRect: vi.fn(), fillText: (t) => void drawnLabel.push(t),
      measureText: (t) => ({ width: measure(t, 32) }),
      createLinearGradient: () => ({ addColorStop: vi.fn() }),
    };
    const drawn = renderCard(ctx, card);
    const label = drawn[drawn.length - 2];
    expect(hasBidi(label)).toBe(false);
    expect(measure(label, 32)).toBeLessThanOrEqual(CARD_TEXT_WIDTH);
    expect(drawn.slice(0, card.lines.length)).toEqual(card.lines.map((l) => l.text));
  });
  it("含雙向控制字元的引文不選為金句候選，並在說明中計數（不改動引文）", () => {
    const base = ["電纜槽與通信線纜架需要保持淨距，避免訊號干擾。", "弱電橋架與其他管線應保持安全間距，方便日後維修。", "機房內的電纜槽必須分類敷設，強電與弱電不得混放。"];
    const docs = [doc("a.md", base.join(NL) + NL + "電纜槽施工前‮必須確認淨距，再安裝橋架與支撐。"), doc("b.md", base.join(NL) + NL + "電纜槽施工前‮必須確認淨距，再安裝橋架與支撐。")];
    const dg = buildDigest(docs, buildGraph(docs));
    const r = buildCards(dg, measure);
    for (const c of r.cards) expect(hasBidi(c.sentence.text)).toBe(false);
    if (dg.sentences.some((s) => hasBidi(s.text))) expect(r.notes.join()).toContain("雙向控制字元");
  });
  it("沒有夠短的句子：說明含「code point」與英文單字數的提醒", () => {
    const longEn = Array.from({ length: 4 }, (_, i) => `Cable tray number ${i} routing must keep clearance from the conduit panel enclosures during every inspection round.`).join(NL);
    const docs = [doc("e.md", longEn), doc("f.md", longEn + NL + "Cable tray routing must keep clearance from the conduit panel enclosures during every inspection round again.")];
    const dg = buildDigest(docs, buildGraph(docs));
    const r = buildCards(dg, measure);
    if (!r.cards.length) expect(r.notes.join()).toContain("8 個單字");
  });
});

describe("toPngBlob / copyImage（可注入 deps）", () => {
  const blob = new Blob(["x"], { type: "image/png" });
  it("toPngBlob：成功回傳 Blob；toBlob 回傳 null 或丟例外或沒有 canvas → null（錯誤路徑）", async () => {
    const ok: BlobCanvas = { toBlob: (cb) => cb(blob) };
    expect(await toPngBlob(ok)).toBe(blob);
    expect(await toPngBlob({ toBlob: (cb) => cb(null) })).toBeNull();
    expect(await toPngBlob({ toBlob: () => { throw new Error("too big"); } })).toBeNull();
    expect(await toPngBlob(null)).toBeNull();
  });
  it("copyImage：以 Promise<Blob> 傳入 ClipboardItem（Safari 需要）；成功", async () => {
    const seen: Array<Record<string, unknown>> = [];
    class FakeItem { constructor(public items: Record<string, Blob | Promise<Blob>>) { seen.push(items); } }
    const write = vi.fn(async () => undefined);
    expect(await copyImage(blob, { ClipboardItemCtor: FakeItem as never, write })).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(seen[0]["image/png"]).toBeInstanceOf(Promise);
    expect(await (seen[0]["image/png"] as Promise<Blob>)).toBe(blob);
  });
  it("不支援（沒有 ClipboardItem 或 write）→ 回報原因，由呼叫端退回下載", async () => {
    expect(await copyImage(blob, {})).toEqual({ ok: false, error: "此環境不支援複製圖片" });
    expect((await copyImage(blob, { ClipboardItemCtor: class {} as never })).ok).toBe(false);
  });
  it("write 被拒絕（權限、無使用者手勢）→ 回報原因，不丟出", async () => {
    class FakeItem { constructor(_: Record<string, Blob | Promise<Blob>>) {} }
    const r = await copyImage(blob, { ClipboardItemCtor: FakeItem as never, write: async () => { throw new Error("NotAllowedError: Document is not focused."); } });
    expect(r).toEqual({ ok: false, error: "NotAllowedError: Document is not focused" });
  });
});

describe("替代文字與破折號", () => {
  it("cardAltText 用整句原文：英文在空白換行也不會變成 withthe", async () => {
    const { cardAltText } = await import("./quotecard");
    const text = "Cable tray routing must keep clearance with the conduit panel enclosures.";
    const docs = [doc("e.md", text + NL + text.replace("Cable tray", "Wire tray")), doc("f.md", text)];
    const dg = buildDigest(docs, buildGraph(docs));
    const r = buildCards(dg, measure);
    for (const c of r.cards) {
      expect(cardAltText(c)).toBe(`${c.sentence.text}（${c.sentence.docName}）`);
      if (c.lines.length > 1) expect(c.lines.map((l) => l.text).join("")).not.toBe(c.sentence.text); // 串起來會掉空白，所以不能當替代文字
    }
  });
  it("破折號 —— 不會被拆在兩行（成對符號規則）", () => {
    const text = "電纜槽與通信線纜架需要保持淨距——避免訊號干擾——並且定期檢查。";
    for (const w of [200, 240, 280, 320, 360]) {
      const lines = wrapText(text, w, 56, measure);
      for (const l of lines) expect(l.text.endsWith("—") && !l.text.endsWith("——") && text.slice(l.end).startsWith("—"), JSON.stringify(l.text)).toBe(false);
    }
  });
});
