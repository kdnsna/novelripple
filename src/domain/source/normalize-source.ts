import { createHash } from "node:crypto";
import path from "node:path";

import type { SourceSection } from "@/domain/schemas";

export const MAX_SOURCE_FILE_BYTES = 512 * 1024;

export type PreparedSourceImport = {
  title: string;
  originalText: string;
  normalizedText: string;
  contentHash: string;
  sections: SourceSection[];
};

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
    return extractParagraphSections(text);
  }

  return matches.map((match, index) => ({
    id: `section_${String(index + 1).padStart(2, "0")}`,
    title: match[1],
    start: index === 0 ? 0 : match.index,
    end: matches[index + 1]?.index ?? text.length,
  }));
}

export function prepareSourceImport(input: {
  fileName: string;
  bytes: Uint8Array;
}): PreparedSourceImport {
  const extension = path.extname(input.fileName).toLowerCase();
  if (extension !== ".txt" && extension !== ".md") {
    throw new Error("仅支持 .txt 和 .md 文件");
  }

  if (input.bytes.byteLength > MAX_SOURCE_FILE_BYTES) {
    throw new Error("文件不能超过 512 KB");
  }

  let originalText: string;
  try {
    originalText = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(input.bytes);
  } catch {
    throw new Error("文件必须使用有效的 UTF-8 编码");
  }

  const normalizedText = normalizeSourceText(originalText);
  if (normalizedText.trim().length === 0) {
    throw new Error("Source 内容不能为空");
  }

  return {
    title: path.basename(input.fileName, extension),
    originalText,
    normalizedText,
    contentHash: sha256(normalizedText),
    sections: extractMarkdownSections(normalizedText),
  };
}

function extractParagraphSections(text: string): SourceSection[] {
  const boundaries = [...text.matchAll(/\n[ \t]*\n+/g)];
  const sections: SourceSection[] = [];
  let segmentStart = 0;

  for (const boundary of [...boundaries, undefined]) {
    const segmentEnd = boundary?.index ?? text.length;
    const segment = text.slice(segmentStart, segmentEnd);
    const firstContentOffset = segment.search(/\S/);

    if (firstContentOffset >= 0) {
      const start = segmentStart + firstContentOffset;
      const end = segmentStart + segment.trimEnd().length;
      sections.push({
        id: `section_${String(sections.length + 1).padStart(2, "0")}`,
        title: `段落 ${sections.length + 1}`,
        start,
        end,
      });
    }

    if (boundary) segmentStart = boundary.index + boundary[0].length;
  }

  return sections;
}
