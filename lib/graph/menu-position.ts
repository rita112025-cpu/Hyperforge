/**
 * 右鍵選單定位（純函式）：把選單的左上角放在游標處，但整個選單必須留在舞台（stage）內。
 * 位置依「實際量到的」選單與舞台尺寸夾住，不假設任何固定寬度。
 * 舞台比選單還小時，優先保證左 / 上緣可見（左上角貼齊 margin）。
 */
export interface MenuPlacement {
  left: number;
  top: number;
}

export function clampMenuPosition(
  x: number,
  y: number,
  menuW: number,
  menuH: number,
  stageW: number,
  stageH: number,
  margin = 4,
): MenuPlacement {
  const fin = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);
  const maxLeft = fin(stageW, 0) - fin(menuW, 0) - margin;
  const maxTop = fin(stageH, 0) - fin(menuH, 0) - margin;
  return {
    left: Math.max(margin, Math.min(fin(x, margin), maxLeft)),
    top: Math.max(margin, Math.min(fin(y, margin), maxTop)),
  };
}
