/** 內容雜湊（SHA-256 hex）。瀏覽器需安全環境（https 或 localhost），Node 20+ 皆有 crypto.subtle。 */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
