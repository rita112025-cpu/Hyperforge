import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import DropZone from "./DropZone";

it("提供具標籤的文字輸入框，空白時不能開始整理", () => {
  const html = renderToStaticMarkup(<DropZone />);
  expect(html).toContain('for="import-text"');
  expect(html).toContain('<textarea id="import-text"');
  expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  expect(html).toContain("開始整理");
});
