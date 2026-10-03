import { describe, expect, it } from "vitest";
import { classifyUrl, isEditablePasteTarget } from "./DropZone";

describe("DropZone paste safety", () => {
  it("ignores normal form/editable targets so global paste does not create an accidental document", () => {
    expect(isEditablePasteTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isEditablePasteTarget({ tagName: "textarea" } as unknown as EventTarget)).toBe(true);
    expect(isEditablePasteTarget({ tagName: "SELECT" } as unknown as EventTarget)).toBe(true);
    expect(isEditablePasteTarget({ isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(
      isEditablePasteTarget({
        tagName: "SPAN",
        closest: (selector: string) => selector.includes('role="textbox"') ? {} : null,
      } as unknown as EventTarget),
    ).toBe(true);
  });

  it("allows paste on non-editable page targets", () => {
    expect(isEditablePasteTarget(null)).toBe(false);
    expect(isEditablePasteTarget({ tagName: "DIV", closest: () => null } as unknown as EventTarget)).toBe(false);
  });

  it("classifies only http(s) URLs and preserves supported subtype detection", () => {
    const youtube = classifyUrl("https://youtu.be/abc");
    const github = classifyUrl("https://github.com/example/repo");
    const web = classifyUrl("https://example.com/a");

    expect(youtube?.kind).toBe("url");
    expect(youtube?.kind === "url" ? youtube.subtype : null).toBe("youtube");
    expect(github?.kind === "url" ? github.subtype : null).toBe("github");
    expect(web?.kind === "url" ? web.subtype : null).toBe("web");
    expect(classifyUrl("javascript:alert(1)")).toBeNull();
    expect(classifyUrl("not a url")).toBeNull();
  });
});
