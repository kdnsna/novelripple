import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@xyflow/react/dist/style.css";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "NovelRipple · 故事涟漪",
    template: "%s · NovelRipple",
  },
  description: "改变一个选择，先看见它如何荡开一整个故事世界。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html data-scroll-behavior="smooth" lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
