import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import baseline from "./baselines/zh-semantic.json";
import { MULTILINGUAL } from "./model-spec";

/** revision 寫在多處（fetch 腳本、model-spec、baseline），換版時漏改任何一處都要失敗 */
describe("模型 revision / SHA 一致性", () => {
  const script = readFileSync(join(process.cwd(), "scripts", "fetch-model.mjs"), "utf8");
  const multilingualBlock = script.slice(script.indexOf("multilingual: {"), script.indexOf('"minilm-l6"'));

  it("fetch-model.mjs 的 multilingual 區塊含 model-spec 的 repo 與 revision", () => {
    expect(multilingualBlock).toContain(MULTILINGUAL.repo);
    expect(multilingualBlock).toContain(MULTILINGUAL.revision);
  });

  it("fetch-model.mjs 的 onnx 雜湊與 baseline 記錄的 onnxSha256 一致", () => {
    expect(multilingualBlock).toContain(baseline.model.onnxSha256);
  });

  it("baseline 的 repo / revision 與 model-spec 一致", () => {
    expect(baseline.model.repo).toBe(MULTILINGUAL.repo);
    expect(baseline.model.revision).toBe(MULTILINGUAL.revision);
  });

  it("model-spec 的 id 含 revision 前 7 碼", () => {
    expect(MULTILINGUAL.id).toContain(MULTILINGUAL.revision.slice(0, 7));
  });
});
