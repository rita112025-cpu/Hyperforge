import { describe, expect, it } from "vitest";
import { MAX_EMBED_CHUNKS, embedLimitNote, exceedsEmbedLimit } from "./limits";

describe("embedding 上限", () => {
  it("上限是 20 個 chunk；剛好等於上限不算超過，多 1 個才算", () => {
    expect(MAX_EMBED_CHUNKS).toBe(20);
    expect(exceedsEmbedLimit(0)).toBe(false);
    expect(exceedsEmbedLimit(20)).toBe(false);
    expect(exceedsEmbedLimit(21)).toBe(true);
  });
  it("可指定其他上限", () => {
    expect(exceedsEmbedLimit(5, 4)).toBe(true);
    expect(exceedsEmbedLimit(4, 4)).toBe(false);
  });
  it("說明文字含實際 chunk 數、上限，以及「文字已保留」", () => {
    const note = embedLimitNote(33);
    expect(note).toContain("33");
    expect(note).toContain("20");
    expect(note).toContain("文字已保留");
  });
});
