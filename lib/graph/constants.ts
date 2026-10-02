/** 圖譜上限與調校常數集中在此，不要在其他檔案出現 magic number。 */

/** 畫布最多顯示的節點數（概念 + 人名）。超過時依 concept score 取前 N，UI 必須明示。 */
export const MAX_GRAPH_NODES = 150;

/** 畫布最多顯示的邊數（避免 150 節點全連通時 physics / 繪製爆量）。超過時依權重取前 N，UI 必須明示。 */
export const MAX_GRAPH_EDGES = 600;

/** 每個節點最多保留的出處位置（freq 仍為精確計數，只有「可回放的出處」有上限）。 */
export const MAX_EVIDENCE_OCCURRENCES = 40;

/** Source panel 一次最多顯示的原文片段數。 */
export const MAX_SNIPPETS = 6;

/** 原文片段在命中詞前後各保留的字元數。 */
export const SNIPPET_CONTEXT_CHARS = 60;

/** 初始 seeded 位置所在圓盤半徑（world 單位）。與節點總數無關，才能讓既有節點位置不因新增文件而改變。 */
export const INITIAL_LAYOUT_RADIUS = 360;
