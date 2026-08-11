import { createHash } from "node:crypto";

import type { SourceSection } from "@/domain/schemas";

export function normalizeSourceText(input: string): string {
  const withoutBom = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  return withoutBom.replace(/\r\n?/g, "\n").normalize("NFC");
}

export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function extractMarkdownSections(text: string): SourceSection[] {
  const matches = [...text.matchAll(/^##\s+(.+)$/gm)];

  if (matches.length === 0) {
    return [{ id: "section_01", title: "全文", start: 0, end: text.length }];
  }

  return matches.map((match, index) => ({
    id: `section_${String(index + 1).padStart(2, "0")}`,
    title: match[1],
    start: match.index,
    end: matches[index + 1]?.index ?? text.length,
  }));
}
