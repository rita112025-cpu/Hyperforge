import { INITIAL_LAYOUT_RADIUS } from "./constants";

/** cyrb53：決定性、同步的 53-bit 字串雜湊（非密碼學用途，只用於 seeded 位置與暫存節點 id）。 */
export function hash53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** 由字串與 salt 決定的 [0, 1) 浮點數。 */
export function hashUnit(str: string, salt: number): number {
  return (hash53(str, salt) % 1_000_003) / 1_000_003;
}

/**
 * 節點初始位置：只取決於節點 id（不取決於節點總數或加入順序），
 * 因此同一批資料重建、或新增文件後，既有節點的起始位置不變。
 * 均勻分布在圓盤內。
 */
export function seededPosition(id: string): { x: number; y: number } {
  const angle = hashUnit(id, 1) * Math.PI * 2;
  const radius = INITIAL_LAYOUT_RADIUS * Math.sqrt(hashUnit(id, 2));
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}
