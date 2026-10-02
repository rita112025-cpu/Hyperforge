import { describe, expect, it } from "vitest";
import { chunkCount, chunkText, tokenize } from "./chunker";

const words = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`).join(" ");

describe("chunkText", () => {
  it("空字串 → 0 塊", () => expect(chunkText("")).toEqual([]));
  it("只有空白 → 0 塊", () => expect(chunkText("  \n\t ")).toEqual([]));
  it("短於 500 → 1 塊", () => expect(chunkText(words(10))).toHaveLength(1));
  it("恰好 500 → 1 塊", () => expect(chunkText(words(500))).toHaveLength(1));
  it("501 → 2 塊，第二塊 51 token", () => {
    expect(chunkText(words(501)).map((x) => x.tokenCount)).toEqual([500, 51]);
  });
  it("950 → 2 塊；951 → 3 塊", () => {
    expect(chunkText(words(950))).toHaveLength(2);
    expect(chunkText(words(951))).toHaveLength(3);
  });
  it("第二塊前 50 token 等於第一塊最後 50 token", () => {
    const [a, b] = chunkText(words(1000));
    expect(tokenize(a.text).slice(-50)).toEqual(tokenize(b.text).slice(0, 50));
  });
  it("index 連續且最後一塊包含最後一個 token", () => {
    const c = chunkText(words(1234));
    expect(c.map((x) => x.index)).toEqual(c.map((_, i) => i));
    expect(c.at(-1)!.text.endsWith("t1233")).toBe(true);
  });
  it("chunkCount 與實際塊數一致", () => {
    for (const n of [0, 1, 499, 500, 501, 950, 951, 1000, 5000]) expect(chunkText(words(n))).toHaveLength(chunkCount(n));
  });
  it("text 等於 rawText.slice(start,end)，保留原始換行與標點", () => {
    const raw = "Hello,\n\nworld!  你好，世界。\tEnd";
    for (const c of chunkText(raw)) expect(raw.slice(c.start, c.end)).toBe(c.text);
    expect(chunkText(raw)[0].text).toBe(raw);
  });
  it("純中文無空白逐字計，且不插入空白", () => {
    const raw = "你".repeat(501);
    const c = chunkText(raw);
    expect(c).toHaveLength(2);
    expect(c[0].text).toBe("你".repeat(500));
  });
  it("tokenize 中英混排", () => expect(tokenize("Hi 你好 world")).toEqual(["Hi", "你", "好", "world"]));
  it("非法參數丟錯", () => expect(() => chunkText("a", 10, 10)).toThrow());
});
