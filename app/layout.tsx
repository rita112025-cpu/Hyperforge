import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HyperForge · 混沌煉金工廠",
  description: "Local-first 知識煉金工廠：拖入任何東西，自動煉成知識。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body className="min-h-screen font-mono antialiased">{children}</body>
    </html>
  );
}
