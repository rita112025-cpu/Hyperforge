import { describe, expect, it } from "vitest";
import { buildGraph } from "../graph/build";
import type { GraphDocument } from "../graph/types";
import { chunkText } from "../pipeline/chunker";
import { buildDigest, type Digest } from "./digest";
import { SLIDE_COUNT, buildSlides, slideLines, slidesToMarkdown } from "./slides";
import { segmentsToText, verifySegments, type Segment, type SourceDoc } from "./segments";
import { THREADS_LAYOUTS, THREADS_MAX_CHARS, THREADS_MAX_POSTS, buildThreads, clauseSlices, type ThreadsLayout } from "./threads";

const doc = (name: string, text: string): GraphDocument => ({ id: `id-${name}`, name, rawText: text, chunks: chunkText(text).map((c) => ({ index: c.index, start: c.start, end: c.end })) });
const NL = String.fromCharCode(10);
const make = (docs: GraphDocument[]) => {
  const g = buildGraph(docs);
  return { docs, d: buildDigest(docs, g), src: new Map<string, SourceDoc>(docs.map((x) => [x.id, { name: x.name, rawText: x.rawText }])) };
};

// 句子含多個子句（，；、），且概念重複出現（才會進圖譜）
const SENTENCES = [
  "電纜槽與通信線纜架需要保持淨距，避免訊號干擾，並且定期檢查支撐間距。",
  "弱電橋架與其他管線應保持安全間距，方便日後維修，同時標示用途與整齊綁紮。",
  "機房內的電纜槽必須分類敷設，強電與弱電不得混放，線纜不得超過容量。",
  "電纜槽內的線纜不得超過容量，橋架需預留擴充空間，並保持通風與散熱。",
  "通信線纜架的支撐間距應定期檢查，確保荷重安全，並記錄每次檢查結果。",
  "弱電橋架內的線纜應整齊綁紮，並標示用途，施工前確認淨距與支撐。",
  "電纜槽施工前必須確認淨距，再安裝橋架與支撐，完成後測試訊號品質。",
  "機房弱電系統完成後，需要測試通信線纜的訊號品質，並保存測試紀錄。",
];
const bigCorpus = (name: string, name2 = "b.md") => make([doc(name, SENTENCES.join(NL)), doc(name2, SENTENCES.slice(2).join(NL) + NL + SENTENCES.slice(0, 3).join(NL))]);

type Q = Extract<Segment, { kind: "quote" }>;
const quotesOf = (p: Segment[]): Q[] => p.filter((s): s is Q => s.kind === "quote");

/** 不變式：輸出中的每個句子，其所有子句切片都存在且連續；沒有只含部分子句的句子 */
function assertWholeSentences(d: Digest, posts: Segment[][], layout: ThreadsLayout) {
  const used = new Set<string>();
  for (const p of posts) {
    const qs = quotesOf(p);
    if (layout === "dense") {
      let i = 0;
      while (i < qs.length) {
        const first = qs[i];
        const sentence = d.sentences.find((s) => s.docId === first.docId && s.start <= first.start && first.end <= s.end);
        expect(sentence, `找不到包含 ${first.text} 的句子`).toBeTruthy();
        const clauses = clauseSlices(sentence!);
        // 接下來的 clauses.length 個 quote 必須恰好是這一句的全部子句（依序、連續）
        const got = qs.slice(i, i + clauses.length).map((q) => [q.start, q.end]);
        expect(got).toEqual(clauses);
        used.add(`${sentence!.docId}:${sentence!.start}`);
        i += clauses.length;
      }
    } else {
      for (const q of qs) {
        const sentence = d.sentences.find((s) => s.docId === q.docId && s.start === q.start && s.end === q.end);
        expect(sentence, `${layout} 的 quote 必須是完整句子：${q.text}`).toBeTruthy();
        used.add(`${q.docId}:${q.start}`);
      }
    }
  }
  return used;
}

describe("Threads：一律以整句為進出單位", () => {
  const layouts = THREADS_LAYOUTS.map((l) => l.id) as ThreadsLayout[];
  const F = bigCorpus("管線規範.md");

  it("fixture 有足夠的多子句句子（避免空轉）", () => {
    expect(F.d.sentences.length).toBeGreaterThanOrEqual(6);
    expect(F.d.sentences.filter((s) => clauseSlices(s).length >= 3).length).toBeGreaterThanOrEqual(4);
  });

  for (const layout of layouts) {
    it(`${layout}：不同來源行長度（逼出各種裝箱邊界）下，每個句子的所有子句都存在且連續`, () => {
      for (const nameLen of [0, 200, 330, 380, 410, 430, 445, 455, 470, 480]) {
        const name = "n".repeat(nameLen) + "管線規範.md";
        const X = bigCorpus(name);
        const r = buildThreads(X.d, layout);
        for (const p of r.posts) {
          expect(Array.from(segmentsToText(p)).length, `${layout} nameLen=${nameLen}`).toBeLessThanOrEqual(THREADS_MAX_CHARS);
          expect(verifySegments(p, X.src)).toEqual([]);
        }
        assertWholeSentences(X.d, r.posts, layout);
      }
    });

    it(`${layout}：來源行太長以致整句放不下 → 整句略過並記入 notes，不是只丟其中某個子句`, () => {
      const X = bigCorpus("n".repeat(520) + ".md", "m".repeat(520) + ".md"); // 兩份文件的名稱都超長 → 任何句子加上來源行都放不下
      const r = buildThreads(X.d, layout);
      assertWholeSentences(X.d, r.posts, layout);
      expect(r.notes.join()).toContain("整句");
      expect(r.notes.join()).toContain("略過");
    });
  }

  it("超過 3 則：只收整句，並說明「另有 N 個整句未收入」；最後一則不停在句子中途", () => {
    const many = Array.from({ length: 40 }, (_, i) => `電纜槽第${i}號與通信線纜架需要保持淨距，避免訊號干擾，並且定期檢查支撐間距與橋架荷重。`);
    const X = make([doc("m.md", many.join(NL)), doc("n.md", many.slice(5).join(NL) + NL + many.slice(0, 7).join(NL))]);
    for (const layout of layouts) {
      const r = buildThreads(X.d, layout);
      expect(r.posts.length).toBeLessThanOrEqual(THREADS_MAX_POSTS);
      assertWholeSentences(X.d, r.posts, layout);
    }
    const dense = buildThreads(X.d, "dense");
    if (dense.notes.length) expect(dense.notes.join()).toContain("整句");
  });

  it("標示誠實：串接版型不再說「依文件順序」，並說明各句原本不一定相鄰、指代可能對不上", () => {
    const chain = THREADS_LAYOUTS.find((l) => l.id === "chain")!;
    expect(chain.label).not.toContain("依文件順序");
    expect(chain.label).toContain("文件與原文位置");
    expect(chain.description).toContain("不是上傳順序");
    expect(chain.description).toContain("不一定相鄰");
    expect(chain.description).toContain("指代");
  });
});

describe("簡報：封面與重點概念的講稿標為「代表性引文」；共現次數的防線", () => {
  const F = bigCorpus("管線規範.md");
  const r = buildSlides(F.d);

  it("封面與重點概念頁的講稿有中性標籤，且標籤進白名單、全頁通過片段檢查", () => {
    expect(segmentsToText(r.slides[0].notesLabel ?? [])).toBe("代表性引文：");
    expect(segmentsToText(r.slides[1].notesLabel ?? [])).toBe("代表性引文：");
    expect(r.slides.slice(2).every((s) => s.notesLabel === undefined)).toBe(true);
    for (const line of slideLines(r)) expect(verifySegments(line, F.src), segmentsToText(line)).toEqual([]);
  });

  it("Markdown 在這兩頁的『講稿：』之後有『代表性引文：』", () => {
    const md = slidesToMarkdown(r);
    expect(md).toMatch(/講稿：\n代表性引文：\n- /);
  });

  it("頁數仍 ≤ 10", () => expect(r.slides.length).toBeLessThanOrEqual(SLIDE_COUNT));

  it("共現權重不是整數（或超出範圍）時：不顯示次數、不丟錯、仍通過片段檢查", () => {
    const bad: Digest = { ...F.d, topEdges: F.d.topEdges.map((e, i) => ({ ...e, weight: i === 0 ? 2.5 : i === 1 ? 123456 : e.weight })) };
    const rr = buildSlides(bad);
    const rel = rr.slides.find((s) => segmentsToText(s.title) === "概念關聯")!;
    expect(segmentsToText(rel.bullets[0])).not.toContain("共現");
    expect(segmentsToText(rel.bullets[1])).not.toContain("共現");
    if (rel.bullets[2]) expect(segmentsToText(rel.bullets[2])).toContain("共現");
    for (const line of slideLines(rr)) expect(verifySegments(line, F.src)).toEqual([]);
  });
});
