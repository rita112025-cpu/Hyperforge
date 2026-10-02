import { defineConfig } from "vitest/config";

// tsconfig 的 jsx 是 "preserve"（Next 需要）；測試時改用 automatic runtime 轉換 JSX，才能 renderToStaticMarkup。
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": new URL(".", import.meta.url).pathname } },
});
