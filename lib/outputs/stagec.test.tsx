import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SocraticView } from "../../components/OutputViews";
import { buildGraph } from "../graph/build";
import type { GraphDocument } from "../graph/types";
import { chunkText } from "../pipeline/chunker";
import { buildDigest } from "./digest";
import { downloadBlob, type DownloadDeps } from "./export";
import { unescapeMarkdown } from "./markdown";
import {
  CARD_FONT_SIZES,
  CARD_MAX_CHARS,
  CARD_SIZE,
  CARD_TEXT_WIDTH,
  CARD_WATERMARK,
  MAX_HANG,
  NO_LINE_END,
  NO_LINE_START,
  buildCards,
  fitCard,
  renderCard,
  wrapText,
  type CardCtx,
  type Measure,
} from "./quotecard";
import { verifySegments, type SourceDoc } from "./segments";
import { SOCRATIC_TITLE, buildSocratic, findCues, questionsFor, socraticLines, socraticToMarkdown } from "./socratic";

const doc = (name: string, text: string): GraphDocument => ({ id: `id-${name}`, name, rawText: text, chunks: chunkText(text).map((c) => ({ index: c.index, start: c.start, end: c.end })) });
const make = (docs: GraphDocument[]) => {
  const g = buildGraph(docs);
  return { docs, d: buildDigest(docs, g), src: new Map<string, SourceDoc>(docs.map((x) => [x.id, { name: x.name, rawText: x.rawText }])) };
};

// ───────────── 反問提示 ─────────────
describe("強斷言線索（findCues）", () => {
  it("中文線索與類別", () => {
    const k = (t: string) => findCues(t).map((c) => `${c.cue}:${c.kind}`);
    expect(k("所有線纜都必須分類")).toEqual(["所有:universal", "必須:necessity"]);
    expect(k("只有一個出口")).toEqual(["只有:exclusive"]);
    expect(k("這是唯一方法")).toEqual(["唯一:exclusive"]);
    expect(k("強電不得混放")).toEqual(["不得:necessity"]);
    expect(k("永遠保持淨距")).toEqual(["永遠:universal"]);
  });
  it("排除非斷言用法：一定程度、不可能、不可靠", () => {
    expect(findCues("在一定程度上可以調整")).toEqual([]);
    expect(findCues("這不可能發生")).toEqual([]);
    expect(findCues("該設備不可靠")).toEqual([]);
  });
  it("英文以 \\b 比對、不分大小寫；allowed / nevertheless / metallic 等不誤判", () => {
    expect(findCues("Cables MUST be labeled").map((c) => c.cue)).toEqual(["must"]);
    expect(findCues("This is always true and never false").map((c) => c.cue).sort()).toEqual(["always", "never"]);
    expect(findCues("Only one entry is allowed").map((c) => c.cue)).toEqual(["only"]);
    for (const t of ["Access is allowed", "Nevertheless it works", "metallic tray", "calls and fallback", "shallow depth"]) expect(findCues(t), t).toEqual([]);
  });
  it("問句（表格寫死）：全稱 → 例外嗎 + 依據；唯一 → 其他情況；必要 → 依據；最多兩個、不拼接", () => {
    expect(questionsFor(findCues("所有線纜"))).toEqual(["這個說法有例外嗎？", "依據是什麼？"]);
    expect(questionsFor(findCues("只有一個"))).toEqual(["有沒有其他情況？"]);
    expect(questionsFor(findCues("必須分類"))).toEqual(["依據是什麼？"]);
    expect(questionsFor(findCues("只有所有線纜必須分類"))).toEqual(["這個說法有例外嗎？", "依據是什麼？"]); // 多類別：取優先序最高者的那一列
    expect(questionsFor([])).toEqual([]);
  });
});

describe("buildSocratic", () => {
  const ZH = [
    "電纜槽與通信線纜架必須保持淨距，避免訊號干擾。",
    "所有弱電橋架與其他管線應保持安全間距，方便日後維修，並且確認現場標示、綁紮與維修通道都符合使用需求。",
    "機房內只有強電線纜可以進入電纜槽，弱電不得混放。",
    "電纜槽內的線纜不得超過容量，橋架需預留擴充空間。",
    "通信線纜架的支撐間距應定期檢查，確保荷重安全。",
  ].join("\n");
  const ZH2 = ["弱電橋架內的線纜必須整齊綁紮，並標示用途。", "電纜槽施工前必須確認淨距，再安裝橋架與支撐。", "機房弱電系統完成後，需要測試通信線纜的訊號品質。"].join("\n");
  const F = make([doc("管線規範.md", ZH), doc("施工筆記.md", ZH2)]);
  const r = buildSocratic(F.d);

  it("fixture 有候選；最多 3 個；每個都含強斷言線索（避免空轉）", () => {
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.length).toBeLessThanOrEqual(3);
    for (const it of r.items) expect(findCues(it.sentence.text).length).toBeGreaterThan(0);
  });
  it("每一行通過片段檢查：quote 逐字等於原文、問句在白名單內", () => {
    for (const line of socraticLines(r)) expect(verifySegments(line, F.src)).toEqual([]);
  });
  it("每個項目 = 一行引文 + 固定問句，沒有任何模板寫的斷言", () => {
    for (const it of r.items) {
      expect(it.lines[0].some((s) => s.kind === "quote")).toBe(true);
      for (const l of it.lines.slice(1)) expect(l.map((s) => s.text).join("")).toMatch(/^ {2}- (這個說法有例外嗎？|依據是什麼？|有沒有其他情況？)$/);
    }
  });
  it("不足 3 個：照實少給並註明；0 個：說沒有偵測到強斷言，不退而求其次造句", () => {
    const one = make([doc("a.md", "電纜槽與通信線纜架必須保持淨距，避免訊號干擾。\n電纜槽施工前確認淨距，再安裝橋架與支撐，避免訊號干擾。\n弱電橋架應整齊綁紮並標示用途，方便日後維修與檢查。")]);
    const r1 = buildSocratic(one.d);
    expect(r1.items.length).toBeLessThan(3);
    if (r1.items.length) expect(r1.notes.join()).toContain("不湊數");
    const none = make([doc("n.md", "電纜槽與通信線纜架保持淨距，避免訊號干擾。\n電纜槽施工前確認淨距，再安裝橋架與支撐，方便維修。\n弱電橋架整齊綁紮並標示用途，方便日後維修與檢查。")]);
    const r0 = buildSocratic(none.d);
    expect(r0.items).toEqual([]);
    expect(r0.notes[0]).toContain("沒有偵測到強斷言");
    expect(socraticToMarkdown(r0)).toContain("沒有偵測到強斷言");
  });
  it("決定性；標題用「反問提示（規則式，非論證）」，全程不出現「最強反駁」", () => {
    expect(JSON.stringify(buildSocratic(F.d))).toBe(JSON.stringify(buildSocratic(F.d)));
    const md = socraticToMarkdown(r);
    expect(md).toContain(`# ${SOCRATIC_TITLE}`);
    expect(md).not.toContain("最強反駁");
    expect(renderToStaticMarkup(<SocraticView result={r} />)).not.toContain("最強反駁");
  });
  it("Markdown 對 hostile 原文跳脫，還原後等於原句", () => {
    const H = make([doc("h.md", "![x](http://evil.example) cable trays must be labeled before the inspection round today.\n[y](javascript:alert(1)) all cable trays must keep clearance from conduit panels today.\n# only the panel enclosures may stay near the cable tray supports every round."), doc("b.md", "cable trays must be labeled before inspection and again after every review round today.")]);
    const rr = buildSocratic(H.d);
    expect(rr.items.length).toBeGreaterThan(0);
    const md = socraticToMarkdown(rr);
    for (const needle of ["![", "](", "javascript:", "http://"]) for (let i = md.indexOf(needle); i >= 0; i = md.indexOf(needle, i + 1)) expect(md[i - 1], needle).toBe("\\");
    expect(unescapeMarkdown(md)).toContain(rr.items[0].sentence.text);
  });
  it("UI：hostile 內容為純文字，沒有真正標籤；顯示說明「規則式、非論證、會有誤判」", () => {
    const H = make([doc("<img src=x onerror=1>.md", "<img src=x onerror=1> cable trays must be labeled before the inspection round today.\n<script>alert(1)</script> all cable trays must keep clearance from panels today."), doc("b.md", "cable trays must be labeled before inspection and again after every review round today.")]);
    const html = renderToStaticMarkup(<SocraticView result={buildSocratic(H.d)} />);
    expect(html).toContain("&lt;img");
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);
    expect(html).toContain("會有誤判");
  });
});

// ───────────── 金句卡 ─────────────
/** CJK 每字佔 1 個字級寬、其餘半寬 */
const measure: Measure = (t, px) => Array.from(t).reduce((w, ch) => w + (/[⺀-鿿＀-￯　-〿]/.test(ch) ? px : px * 0.5), 0);
const strip = (s: string) => s.replace(/\s+/g, "");

describe("wrapText：換行、避頭尾、不改寫引文", () => {
  const text = "電纜槽與通信線纜架需要保持淨距，避免訊號干擾，並且「定期檢查」支撐間距。";
  for (const px of [72, 56, 40]) {
    it(`字級 ${px}：每行是原文逐字切片、串回等於原文、寬度不超過上限`, () => {
      const lines = wrapText(text, CARD_TEXT_WIDTH, px, measure);
      expect(lines.length).toBeGreaterThan(1);
      for (const l of lines) {
        expect(text.slice(l.start, l.end)).toBe(l.text);
        // 唯一的例外是「標點懸掛」：行尾最多 MAX_HANG 個行首禁則標點可以超出行寬
        const cs = Array.from(l.text);
        const hang = cs.length > 1 && NO_LINE_START.has(cs[cs.length - 1]) ? MAX_HANG : 0;
        expect(measure(cs.slice(0, cs.length - hang).join(""), px)).toBeLessThanOrEqual(CARD_TEXT_WIDTH);
      }
      expect(lines.map((l) => l.text).join("")).toBe(text);
    });
  }
  it("避頭：行首不會出現 ，。、；：？！）」 等；避尾：行尾不會出現 （「 等", () => {
    const samples = ["他說：「你好嗎？」然後離開，並且（沒有回頭），一路向前。", "電纜槽、橋架、支撐；線纜，訊號。保持（淨距）與「間距」。", "A，B。C、D；E：F？G！H）I」J"];
    for (const t of samples) for (const px of [72, 64, 56, 48]) {
      const lines = wrapText(t, 400, px, measure);
      for (const l of lines.slice(1)) expect(NO_LINE_START.has(Array.from(l.text)[0]), `${JSON.stringify(l.text)} @${px}`).toBe(false);
      for (const l of lines) expect(NO_LINE_END.has(Array.from(l.text).at(-1)!), `${JSON.stringify(l.text)} @${px}`).toBe(false);
      expect(lines.map((l) => l.text).join("")).toBe(t);
    }
  });
  it("英文依空白斷行、單字不被拆開（除非單字比整行還寬）；串回去（忽略空白）等於原文", () => {
    const t = "Cable tray routing must keep clearance from conduit and panel enclosures during inspection.";
    const lines = wrapText(t, 500, 56, measure);
    expect(lines.length).toBeGreaterThan(1);
    const words = new Set(t.split(" "));
    for (const l of lines) for (const w of l.text.split(" ")) expect(words.has(w), w).toBe(true);
    expect(strip(lines.map((l) => l.text).join(""))).toBe(strip(t));
  });
  it("超長單字：逐字強制斷行，仍不遺失任何字元", () => {
    const t = "Supercalifragilisticexpialidocious";
    const lines = wrapText(t, 300, 56, measure);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map((l) => l.text).join("")).toBe(t);
  });
  it("中英混排與空字串", () => {
    const t = "使用 cable tray 保持 clearance 並檢查 panel。";
    expect(wrapText(t, 420, 56, measure).map((l) => l.text).join(" ").replace(/\s+/g, "")).toBe(strip(t));
    expect(wrapText("", 400, 56, measure)).toEqual([]);
  });
});

describe("fitCard：字級單調、放不下時不截斷", () => {
  it("較長的引文不會得到比較短引文更大的字級", () => {
    const base = "電纜槽與通信線纜架需要保持淨距，避免訊號干擾。";
    let prev = Infinity;
    for (let n = 1; n <= 3; n++) {
      const r = fitCard(base.repeat(n), measure);
      if (!r.ok) break;
      expect(r.fit.fontPx).toBeLessThanOrEqual(prev);
      prev = r.fit.fontPx;
      expect(CARD_FONT_SIZES).toContain(r.fit.fontPx);
    }
    expect(prev).toBeLessThan(Infinity);
  });
  it("放不下：回傳明確原因，且不產生任何截斷後的版面", () => {
    const r = fitCard("電纜槽與通信線纜架需要保持淨距，避免訊號干擾。".repeat(40), measure);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("不截斷引文");
  });
});

describe("buildCards / renderCard", () => {
  const ZH = ["電纜槽與通信線纜架需要保持淨距，避免訊號干擾。", "弱電橋架與其他管線應保持安全間距，方便日後維修。", "機房內的電纜槽必須分類敷設，強電與弱電不得混放。", "電纜槽內的線纜不得超過容量，橋架需預留擴充空間。", "通信線纜架的支撐間距應定期檢查，確保荷重安全。"].join("\n");
  const ZH2 = ["弱電橋架內的線纜應整齊綁紮，並標示用途。", "電纜槽施工前必須確認淨距，再安裝橋架與支撐。", "機房弱電系統完成後，需要測試通信線纜的訊號品質。"].join("\n");
  const F = make([doc("管線規範.md", ZH), doc("施工筆記.md", ZH2)]);
  const r = buildCards(F.d, measure);

  it("fixture 有卡片（避免空轉）；最多 3 張；只選 ≤48 字元的句子（不截斷）", () => {
    expect(r.cards.length).toBeGreaterThan(0);
    expect(r.cards.length).toBeLessThanOrEqual(3);
    for (const c of r.cards) expect(Array.from(c.sentence.text).length).toBeLessThanOrEqual(CARD_MAX_CHARS);
  });
  it("卡片內容片段通過檢查；各行串回去等於整句引文（沒有截斷或改寫）", () => {
    for (const c of r.cards) {
      expect(verifySegments(c.segments, F.src)).toEqual([]);
      expect(c.lines.map((l) => l.text).join("")).toBe(c.sentence.text);
    }
  });
  it("renderCard：實際 fillText 畫出的字 = 版面各行 + 來源文件名 + 固定浮水印，沒有其他文字", () => {
    for (const c of r.cards) {
      const calls: string[] = [];
      const ctx: CardCtx = {
        font: "",
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 1,
        textAlign: "left",
        textBaseline: "top",
        fillRect: vi.fn(),
        strokeRect: vi.fn(),
        fillText: (t) => void calls.push(t),
        measureText: (t) => ({ width: measure(t, 40) }),
        createLinearGradient: () => ({ addColorStop: vi.fn() }),
      };
      const drawn = renderCard(ctx, c);
      expect(drawn).toEqual(calls);
      expect(drawn).toEqual([...c.lines.map((l) => l.text), c.sentence.docName, CARD_WATERMARK]);
      expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, CARD_SIZE, CARD_SIZE);
    }
  });
  it("沒有長度適中的句子：不產生卡片並說明（不截斷較長的句子）", () => {
    const tail = "，並且定期檢查支撐間距與荷重安全狀況，同時確認現場標示、綁紮與維修通道都符合使用需求。";
    const lines = ["電纜槽與通信線纜架需要保持淨距，避免訊號干擾", "弱電橋架與其他管線應保持安全間距，方便日後維修", "機房內的電纜槽必須分類敷設，強電與弱電不得混放", "電纜槽內的線纜不得超過容量，橋架需預留擴充空間"].map((x) => x + tail);
    const NL = String.fromCharCode(10);
    const L = make([doc("l.md", lines.join(NL)), doc("m.md", lines.join(NL) + NL + "電纜槽施工前必須確認淨距，再安裝橋架與支撐" + tail)]);
    expect(L.d.sentences.length).toBeGreaterThan(0); // 前提：有句子，但全都超過 48 字元
    expect(L.d.sentences.every((s) => Array.from(s.text).length > CARD_MAX_CHARS)).toBe(true);
    const rr = buildCards(L.d, measure);
    expect(rr.cards).toEqual([]);
    expect(rr.notes.join()).toContain("不截斷");
  });
  it("放不下的句子被略過並註明（不截斷）", () => {
    const wide: Measure = (t, px) => Array.from(t).length * px * 30; // 每個字都比整行還寬 → 每字一行，任何字級都放不下
    const rr = buildCards(F.d, wide);
    expect(rr.cards).toEqual([]);
    expect(rr.notes.join()).toContain("不截斷引文");
  });
});

describe("downloadBlob", () => {
  it("檔名經過淨化、副檔名保留、Blob URL 一定 revoke", () => {
    const calls: string[] = [];
    const deps: DownloadDeps = { createObjectURL: () => (calls.push("create"), "blob:x"), revokeObjectURL: () => void calls.push("revoke"), click: (_u, n) => void calls.push(`click:${n}`) };
    expect(downloadBlob("a/b:c.png", new Blob(["x"], { type: "image/png" }), deps)).toBe("a_b_c.png");
    expect(calls).toEqual(["create", "click:a_b_c.png", "revoke"]);
    expect(downloadBlob("CON.png", new Blob(["x"]), { ...deps, createObjectURL: () => "blob:y" })).toBe("_CON.png");
  });
});
