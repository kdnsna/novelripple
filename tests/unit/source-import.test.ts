import { describe, expect, it } from "vitest";

import {
  extractMarkdownSections,
  normalizeSourceText,
  prepareSourceImport,
  sha256,
} from "@/domain/source/normalize-source";

describe("Source import preparation", () => {
  it("normalizes BOM, line endings, and Unicode before hashing", () => {
    const original = "\ufeff潮汐\r\nCafe\u0301\r结尾";
    const normalized = "潮汐\nCafé\n结尾";

    expect(normalizeSourceText(original)).toBe(normalized);
    expect(sha256(normalizeSourceText(original))).toBe(sha256(normalized));
  });

  it("computes the standard SHA-256 digest", () => {
    expect(sha256("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("splits plain text paragraphs without changing character offsets", () => {
    const text = "第一段。\n\n第二段。\n\n第三段。";
    const sections = extractMarkdownSections(text);

    expect(sections).toHaveLength(3);
    expect(
      sections.map((section) => text.slice(section.start, section.end)),
    ).toEqual(["第一段。", "第二段。", "第三段。"]);
  });

  it("keeps Markdown content before the first level-two heading addressable", () => {
    const text = "# 潮汐账本\n\n序章中的关键事实。\n\n## 第一章\n第一章正文。\n\n## 第二章\n第二章正文。";
    const sections = extractMarkdownSections(text);

    expect(sections).toHaveLength(2);
    expect(sections[0].start).toBe(0);
    expect(text.slice(sections[0].start, sections[0].end)).toContain(
      "序章中的关键事实。",
    );
  });

  it.each(["story.txt", "story.md"])(
    "accepts strict UTF-8 content from %s",
    (fileName) => {
      const result = prepareSourceImport({
        fileName,
        bytes: new TextEncoder().encode("第一段。\r\n\r\n第二段。"),
      });

      expect(result.title).toBe("story");
      expect(result.originalText).toBe("第一段。\r\n\r\n第二段。");
      expect(result.normalizedText).toBe("第一段。\n\n第二段。");
      expect(result.contentHash).toBe(sha256(result.normalizedText));
      expect(result.sections).toHaveLength(2);
    },
  );

  it("rejects unsupported file extensions", () => {
    expect(() =>
      prepareSourceImport({
        fileName: "story.pdf",
        bytes: new TextEncoder().encode("不是 PDF，只是假扩展名"),
      }),
    ).toThrow("仅支持 .txt 和 .md");
  });

  it("rejects malformed UTF-8 instead of replacing invalid bytes", () => {
    expect(() =>
      prepareSourceImport({
        fileName: "story.txt",
        bytes: Uint8Array.from([0xc3, 0x28]),
      }),
    ).toThrow("UTF-8");
  });

  it("rejects sources without readable content", () => {
    expect(() =>
      prepareSourceImport({
        fileName: "empty.md",
        bytes: new TextEncoder().encode(" \n\n "),
      }),
    ).toThrow("不能为空");
  });

  it("rejects files larger than the M0 upload limit", () => {
    expect(() =>
      prepareSourceImport({
        fileName: "too-large.txt",
        bytes: new Uint8Array(512 * 1024 + 1),
      }),
    ).toThrow("512 KB");
  });
});
