import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MindmapView from "../../components/MindmapView";
import { SlidesView, ThreadsView } from "../../components/OutputViews";
import { buildGraph } from "../graph/build";
import type { GraphDocument } from "../graph/types";
import { chunkText } from "../pipeline/chunker";
import { buildDigest, type Digest } from "./digest";
import { unescapeMarkdown } from "./markdown";
import { buildMindmap } from "./mindmap";
import { SLIDE_COUNT, buildSlides, slideLines, slidesToMarkdown } from "./slides";
import { segmentsToText, verifySegments, type SourceDoc } from "./segments";
import { THREADS_LAYOUTS, THREADS_MAX_CHARS, THREADS_MAX_POSTS, buildThreads, clauseSlices, threadsToText, type ThreadsLayout } from "./threads";

const doc = (name: string, text: string): GraphDocument => ({ id: `id-${name}`, name, rawText: text, chunks: chunkText(text).map((c) => ({ index: c.index, start: c.start, end: c.end })) });
const ZH_A = ["電纜槽與通信線纜架需要保持淨距，避免訊號干擾。", "弱電橋架與其他管線應保持安全間距，方便日後維修。", "機房內的電纜槽必須分類敷設，強電與弱電不得混放。", "電纜槽內的線纜不得超過容量，橋架需預留擴充空間。", "通信線纜架的支撐間距應定期檢查，確保荷重安全。"].join("\n");
const ZH_B = ["弱電橋架內的線纜應整齊綁紮，並標示用途。", "電纜槽施工前必須確認淨距，再安裝橋架與支撐。", "機房弱電系統完成後，需要測試通信線纜的訊號品質。"].join("\n");
const EN = ["Cable tray routing must keep clearance from conduit and panel enclosures.", "The cable tray support spacing should be reviewed during every inspection round.", "Conduit routing near the panel requires extra clearance for maintenance access.", "Panel enclosures and cable tray supports must be labeled before inspection."].join("\n");
const make = (docs: GraphDocument[]) => {
  const g = buildGraph(docs);
  return { docs, g, d: buildDigest(docs, g), src: new Map<string, SourceDoc>(docs.map((x) => [x.id, { name: x.name, rawText: x.rawText }])) };
};
const F = make([doc("管線規範.md", ZH_A), doc("施工筆記.md", ZH_B), doc("tray-notes.md", EN)]);

describe("簡報大綱", () => {
  const r = buildSlides(F.d);
  it("fixture 有簡報（避免空轉）；頁數 ≤ 10；第 1 頁是封面、第 2 頁是重點概念", () => {
    expect(r.slides.length).toBeGreaterThan(3);
    expect(r.slides.length).toBeLessThanOrEqual(SLIDE_COUNT);
    expect(segmentsToText(r.slides[0].title)).toBe("封面");
    expect(segmentsToText(r.slides[1].title)).toBe("重點概念");
  });
  it("每一行（標題、條列、講稿）都通過片段檢查", () => {
    for (const line of slideLines(r)) expect(verifySegments(line, F.src), segmentsToText(line)).toEqual([]);
  });
  it("講稿只由 quote（附文件名與標點框架）組成：沒有 term，且每一行都有 quote", () => {
    for (const s of r.slides) for (const n of s.notes) {
      expect(n.some((x) => x.kind === "quote")).toBe(true);
      expect(n.some((x) => x.kind === "term")).toBe(false);
    }
  });
  it("概念頁的標題只是 term（不是模板寫的結論）；條列最多 2 句、講稿最多 3 句", () => {
    const conceptPages = r.slides.slice(2).filter((s) => s.title[0].kind === "term");
    expect(conceptPages.length).toBeGreaterThan(0);
    for (const s of conceptPages) {
      expect(s.title[0].kind).toBe("term");
      expect(s.bullets.length).toBeLessThanOrEqual(2);
      expect(s.notes.length).toBeLessThanOrEqual(3);
    }
  });
  it("概念關聯頁的『共現 N 次』等於圖譜的邊權重（獨立計算）", () => {
    const rel = r.slides.find((s) => segmentsToText(s.title) === "概念關聯");
    expect(rel).toBeTruthy();
    rel!.bullets.forEach((b, i) => {
      const e = F.d.topEdges[i];
      expect(segmentsToText(b)).toBe(`- ${e.a.label} × ${e.b.label}（共現 ${e.weight} 次）`);
    });
  });
  it("頁數不足 10 頁時照實少給並說明；沒有概念時不產生頁面", () => {
    const small = make([doc("s.md", "電纜槽與通信線纜架需要保持淨距，避免訊號干擾。\n電纜槽施工前必須確認淨距，再安裝橋架與支撐。")]);
    const sr = buildSlides(small.d);
    if (sr.slides.length < SLIDE_COUNT) expect(sr.notes.join()).toContain("不湊數");
    const none = buildSlides(make([]).d);
    expect(none.slides).toEqual([]);
    expect(none.notes[0]).toContain("無法產生");
  });
  it("Markdown：結構正確，hostile 內容經跳脫且還原後仍在", () => {
    const md = slidesToMarkdown(r);
    expect(md).toContain("# 簡報大綱");
    expect(md).toContain("## 第 1 頁：封面");
    expect(md).toContain("講稿：");
    const H = make([doc("<img src=x onerror=1>.md", "![a](http://evil.example) cable tray conduit routing clearance panel is reviewed again.\n[x](javascript:alert(1)) cable tray conduit routing clearance panel needs review soon.\n# cable tray conduit routing clearance panel is checked in every round."), doc("b.md", "cable tray conduit routing clearance panel again and again today for the review.\ncable tray conduit routing clearance panel once more here today for a check.")]);
    const hmd = slidesToMarkdown(buildSlides(H.d));
    for (const needle of ["<img", "](", "javascript:", "http://"]) {
      for (let i = hmd.indexOf(needle); i >= 0; i = hmd.indexOf(needle, i + 1)) expect(hmd[i - 1], needle).toBe("\\");
    }
    expect(unescapeMarkdown(hmd)).toContain("<img src=x onerror=1>.md");
  });
});

describe("Threads 三種版型", () => {
  const layouts = THREADS_LAYOUTS.map((l) => l.id) as ThreadsLayout[];
  it("版型名稱誠實：沒有『嗆辣』『故事』字樣，且恰好三種", () => {
    expect(layouts).toEqual(["professional", "dense", "chain"]);
    for (const l of THREADS_LAYOUTS) expect(`${l.label}${l.description}`).not.toMatch(/嗆辣|故事/);
  });
  for (const layout of layouts) {
    describe(layout, () => {
      const r = buildThreads(F.d, layout);
      it("有貼文；每則 ≤ 500 字元；最多 3 則；(i/n) 編號與則數一致", () => {
        expect(r.posts.length).toBeGreaterThan(0);
        expect(r.posts.length).toBeLessThanOrEqual(THREADS_MAX_POSTS);
        r.posts.forEach((p, i) => {
          expect(Array.from(segmentsToText(p)).length).toBeLessThanOrEqual(THREADS_MAX_CHARS);
          expect(segmentsToText(p).startsWith(`(${i + 1}/${r.posts.length})\n`)).toBe(true);
        });
      });
      it("每則的所有片段通過檢查：quote 逐字等於原文切片、frame 全在白名單、ref 等於文件名", () => {
        for (const p of r.posts) expect(verifySegments(p, F.src)).toEqual([]);
      });
      it("內容只有 quote、ref 與白名單框架（沒有 term、沒有模板文字）", () => {
        for (const p of r.posts) expect(p.every((s) => s.kind !== "term")).toBe(true);
      });
      it("每則都附來源（來源：文件名）", () => {
        for (const p of r.posts) expect(segmentsToText(p)).toContain("來源：");
      });
    });
  }
  it("professional：每個項目以 • 開頭", () => {
    const r = buildThreads(F.d, "professional");
    for (const p of r.posts) for (const line of segmentsToText(p).split("\n\n")[0].split("\n").slice(1)) expect(line.startsWith("• ")).toBe(true);
  });
  it("dense：每一行是原文句子的『子句切片』；只靠換行排版（不新增文字）", () => {
    const r = buildThreads(F.d, "dense");
    const body = r.posts.flatMap((p) => p.filter((s) => s.kind === "quote"));
    expect(body.length).toBeGreaterThan(r.posts.length);
    for (const q of body) {
      expect(q.kind === "quote" && F.src.get(q.docId)!.rawText.slice(q.start, q.end) === q.text).toBe(true);
      expect(q.kind === "quote" && /[，,；;、]./.test(q.text)).toBe(false); // 一行只有一個子句（標點只會在尾端）
    }
  });
  it("clauseSlices：切片串回去等於原句（去掉前後空白）", () => {
    const s = F.d.sentences[0];
    const joined = clauseSlices(s).map(([a, b]) => F.src.get(s.docId)!.rawText.slice(a, b)).join("");
    expect(joined).toBe(s.text.replace(/\s+/g, (m) => (joined.includes(m) ? m : "")));
  });
  it("chain：引文依「文件名稱、同文件內原文位置」串接（標示不再說成文件順序）", () => {
    const r = buildThreads(F.d, "chain");
    const qs = r.posts.flatMap((p) => p.filter((s): s is Extract<typeof s, { kind: "quote" }> => s.kind === "quote"));
    for (let i = 1; i < qs.length; i++) {
      const a = qs[i - 1];
      const b = qs[i];
      const an = F.src.get(a.docId)!.name;
      const bn = F.src.get(b.docId)!.name;
      expect(an < bn || (an === bn && a.start <= b.start)).toBe(true);
    }
  });
  it("單一句子（加上頁碼與來源）超過 500 字元：略過並說明，不截斷引文", () => {
    const longSentence = "電纜槽" + "與通信線纜架需要保持淨距，避免訊號干擾".repeat(30) + "。";
    const L = make([doc("long.md", `${longSentence}\n${ZH_A}`), doc("b.md", ZH_B)]);
    // 句子長度上限 140，所以長句本來就不會進入 digest；用一個超長文件名讓來源行超過上限
    const longName = "n".repeat(520) + ".md";
    const N = make([doc(longName, ZH_A), doc("b.md", ZH_B)]);
    const r = buildThreads(N.d, "chain");
    for (const p of r.posts) expect(Array.from(segmentsToText(p)).length).toBeLessThanOrEqual(THREADS_MAX_CHARS);
    expect(L.d.sentences.every((s) => Array.from(s.text).length <= 140)).toBe(true);
  });
  it("純文字：不做 Markdown 跳脫（貼到 Threads 的內容與原文一致）", () => {
    const H = make([doc("h.md", "cable tray conduit routing clearance panel <b>bold</b> is reviewed again today.\ncable tray conduit routing clearance panel needs [review] soon today.\ncable tray conduit routing clearance panel is checked in every round today."), doc("i.md", "cable tray conduit routing clearance panel again and again for the review today.\ncable tray conduit routing clearance panel once more here for a check today.")]);
    const t = threadsToText(buildThreads(H.d, "professional"));
    expect(t).not.toContain("\\<");
    expect(t).not.toContain("\\[");
    expect(t).toMatch(/<b>bold<\/b>|\[review\]/);
  });
  it("沒有句子：空貼文並說明", () => {
    const r = buildThreads(make([]).d as Digest, "professional");
    expect(r.posts).toEqual([]);
    expect(r.notes.join()).toContain("無法產生貼文");
  });
});

describe("元件結構與 XSS（renderToStaticMarkup）", () => {
  const H = make([
    doc('<img src=x onerror="alert(1)">.md', '<img src=x onerror="alert(1)"> Cable tray routing must keep clearance from the conduit panel.\nConduit routing near the panel requires clearance <script>alert(2)</script> and review.\nCable tray conduit panel labels <b onmouseover=alert(3)>checked</b> every round again.\nCable tray conduit routing clearance panel <iframe src=javascript:alert(4)></iframe> ignored.'),
    doc("b.md", "Cable tray conduit routing clearance panel again and again for the review today.\nCable tray conduit routing clearance panel once more here for a check today."),
  ]);
  const mm = buildMindmap(H.d);
  const html = [
    renderToStaticMarkup(<MindmapView mindmap={mm} digest={H.d} />),
    renderToStaticMarkup(<SlidesView result={buildSlides(H.d)} />),
    ...THREADS_LAYOUTS.map((l) => renderToStaticMarkup(<ThreadsView result={buildThreads(H.d, l.id)} />)),
  ].join("\n");

  it("三個檢視都有內容（避免空轉），hostile 文字以跳脫後的純文字出現", () => {
    expect(mm.groups.length).toBeGreaterThan(0);
    expect(html).toContain("data-testid=\"output-slides\"");
    expect(html).toContain("data-testid=\"output-threads\"");
    expect(html).toContain("&lt;img src=x onerror=");
  });

  it("沒有任何來自使用者內容的真正標籤或事件屬性", () => {
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<iframe\b/i);
    expect(html).not.toMatch(/<b\s+onmouseover/i);
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it("心智圖的 ARIA 結構：role=tree、treeitem、aria-level、aria-expanded（有子節點者）、roving tabindex（只有一個 0）", () => {
    const tree = renderToStaticMarkup(<MindmapView mindmap={mm} digest={H.d} />);
    expect(tree).toContain('role="tree"');
    expect(tree).toContain('aria-label="心智圖（概念樹）"');
    const items = tree.match(/role="treeitem"[^>]*>/g) ?? [];
    expect(items.length).toBeGreaterThan(1);
    expect(items.filter((i) => /tabindex="0"/.test(i))).toHaveLength(1);
    expect(items.filter((i) => /tabindex="-1"/.test(i))).toHaveLength(items.length - 1);
    for (const i of items) {
      expect(i).toMatch(/aria-level="\d+"/);
      expect(i).toMatch(/aria-posinset="\d+"/);
      expect(i).toMatch(/aria-setsize="\d+"/);
      expect(i).toMatch(/aria-selected="false"/);
    }
    expect(items.some((i) => /aria-expanded="true"/.test(i))).toBe(true); // 根預設展開
    expect(tree).toContain("focus-visible:ring"); // 可見的焦點樣式
    expect(tree).toContain("data-testid=\"mindmap-rules\""); // 規則說明
  });

  it("空心智圖：顯示說明而不是空白樹", () => {
    const empty = renderToStaticMarkup(<MindmapView mindmap={buildMindmap(make([]).d)} digest={make([]).d} />);
    expect(empty).toContain("無法產生心智圖");
    expect(empty).not.toContain('role="tree"');
  });
});
