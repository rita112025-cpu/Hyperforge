import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("產品路徑不得 import 測試用 fake", () => {
  it("非 *.test.* / *.test-util.* 的檔案不含 fake-embedder", () => {
    const root = process.cwd();
    const files = ["app", "components", "lib"]
      .flatMap((d) => walk(join(root, d)))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test(-util)?\.tsx?$/.test(f));
    const offenders = files.filter((f) => readFileSync(f, "utf8").includes("fake-embedder"));
    expect(offenders).toEqual([]);
  });
});
