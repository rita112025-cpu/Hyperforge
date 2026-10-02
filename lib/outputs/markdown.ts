/**
 * Markdown 匯出的跳脫（匯出的 .md 會被帶到別的檢視器，原文與文件名都是不可信的使用者內容）。
 * 目標：下游渲染後「看到的文字」仍然等於原句，但不會被解讀成圖片請求、可點連結、HTML、標題或清單。
 *
 * 做法（CommonMark：反斜線可跳脫任何 ASCII 標點）：
 *  - 一律跳脫  \ ` * _ [ ] ( ) < > ! # | ~ & @ { }
 *  - 行首的清單 / 引用 / 編號：`-` `+` `>` 已在上面或下面處理；`數字.` 跳脫那個點（`1\.`）
 *  - 自動連結（GFM）：ASCII 冒號前面是字母時跳脫（`http\://`、`javascript\:`），`www.` 的點跳脫
 * 跳脫字元在渲染後不可見；但在純文字檢視器裡會看到反斜線，這是刻意的取捨（安全優先）。
 */
const ESCAPE_CHARS = /[\\`*_[\]()<>!#|~&@{}]/g;

export function escapeMarkdown(text: string): string {
  return text
    .replace(ESCAPE_CHARS, "\\$&")
    .replace(/(^|\n)([-+])(?=\s)/g, "$1\\$2") // 行首的 - / + 清單
    .replace(/(^|\n)(\d+)\.(?=\s|$)/g, "$1$2\\.") // 行首的「1.」編號
    .replace(/([A-Za-z]):/g, "$1\\:") // 自動連結的 scheme（http: / javascript: / mailto:）
    .replace(/\bwww\./gi, (m) => `${m.slice(0, -1)}\\.`);
}

/** 模擬 Markdown 渲染對反斜線跳脫的還原（測試用；也是「顯示結果仍是原句」的定義）。 */
export function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}
