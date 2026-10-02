import { describe, expect, it, vi } from "vitest";
import { checkModelFiles } from "./model-files";
import { MULTILINGUAL, requiredFiles } from "./model-spec";
import { probeVectorStatus } from "./status";

const FILES = requiredFiles(MULTILINGUAL);
const res = (ok: boolean, type = "application/octet-stream") => ({ ok, headers: new Headers({ "content-type": type }) }) as unknown as Response;
const fetcher = (impl: (u: string) => Response | Promise<Response>) => vi.fn(async (u: RequestInfo | URL) => impl(String(u))) as unknown as typeof fetch;

describe("checkModelFiles / probeVectorStatus", () => {
  it("全部存在 → available；只發 HEAD、no-store", async () => {
    const f = fetcher(() => res(true));
    const r = await checkModelFiles(MULTILINGUAL, f);
    expect(r).toEqual({ available: true, missing: [] });
    expect(f).toHaveBeenCalledTimes(FILES.length);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ method: "HEAD", cache: "no-store" });
  });

  it("缺檔 / HTML 404 頁 → unavailable，列出缺哪些檔", async () => {
    const r = await checkModelFiles(MULTILINGUAL, fetcher((u) => (u === FILES[0] ? res(false) : u === FILES[1] ? res(true, "text/html") : res(true))));
    expect(r.available).toBe(false);
    expect(r.missing).toEqual([FILES[0], FILES[1]]);
  });

  it("stopAtFirstMissing：依序檢查，缺第一個檔就停止（只發 1 個請求）；全部存在時照樣回 available", async () => {
    const f = fetcher(() => res(false));
    const r = await checkModelFiles(MULTILINGUAL, f, { stopAtFirstMissing: true });
    expect(r).toEqual({ available: false, missing: [FILES[0]] });
    expect(f).toHaveBeenCalledTimes(1);

    const g = fetcher((u) => res(u !== FILES[2]));
    const r2 = await checkModelFiles(MULTILINGUAL, g, { stopAtFirstMissing: true });
    expect(r2.missing).toEqual([FILES[2]]);
    expect(g).toHaveBeenCalledTimes(3); // 前兩個存在、第三個缺 → 停止，不檢查第四個

    const h = fetcher(() => res(true));
    expect(await checkModelFiles(MULTILINGUAL, h, { stopAtFirstMissing: true })).toEqual({ available: true, missing: [] });
    expect(h).toHaveBeenCalledTimes(FILES.length);
  });

  it("probeVectorStatus 缺模型時只發 1 個 HEAD", async () => {
    const f = fetcher(() => res(false));
    await probeVectorStatus(f);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("fetch 丟錯 → unavailable，帶 error，不丟例外", async () => {
    const r = await checkModelFiles(MULTILINGUAL, fetcher(() => Promise.reject(new Error("offline"))));
    expect(r).toMatchObject({ available: false, error: "offline" });
  });

  it("probeVectorStatus：AVAILABLE / UNAVAILABLE 與說明文字", async () => {
    expect(await probeVectorStatus(fetcher(() => res(true)))).toEqual({ state: "AVAILABLE", detail: "模型檔存在" });
    const miss = await probeVectorStatus(fetcher(() => res(false)));
    expect(miss.state).toBe("UNAVAILABLE");
    expect(miss.detail).toMatch(/fetch-model/);
    const err = await probeVectorStatus(fetcher(() => Promise.reject(new Error("boom"))));
    expect(err.state).toBe("UNAVAILABLE");
    expect(err.detail).toMatch(/boom/);
  });
});
