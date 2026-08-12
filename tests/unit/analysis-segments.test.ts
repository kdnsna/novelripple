import { describe, expect, it } from "vitest";

import { SourceSchema, type Source } from "@/domain/schemas";
import {
  ANALYSIS_CORE_MAX,
  ANALYSIS_CORE_MIN,
  deriveAnalysisSegments,
} from "@/domain/source/analysis-segments";
import { sha256 } from "@/domain/source/normalize-source";

function sourceWithSectionLengths(id: string, lengths: number[]): Source {
  let offset = 0;
  const parts: string[] = [];
  const sections = lengths.map((length, index) => {
    const text = String.fromCharCode(0x7532 + index).repeat(length);
    const start = offset;
    const end = start + text.length;
    offset = end;
    parts.push(text);
    return {
      id: `section_${String(index + 1).padStart(2, "0")}`,
      title: `合成章节 ${index + 1}`,
      start,
      end,
    };
  });
  const normalizedText = parts.join("");

  return SourceSchema.parse({
    id,
    projectId: "project_analysis_segments",
    title: "合成分段测试",
    originalText: normalizedText,
    normalizedText,
    contentHash: sha256(normalizedText),
    sections,
    createdAt: "2026-08-13T00:00:00.000Z",
  });
}

describe("deterministic Analysis Segments", () => {
  it("uses the unified derivation path for a one-segment Source", () => {
    const source = sourceWithSectionLengths("source_short", [2_500, 2_500]);

    expect(deriveAnalysisSegments(source)).toEqual([
      {
        id: "analysis_segment:source_short:0001",
        sourceId: "source_short",
        sectionIds: ["section_01", "section_02"],
        coreStart: 0,
        coreEnd: source.sections[1]!.end,
        contextStart: 0,
        contextEnd: source.sections[1]!.end,
      },
    ]);
  });

  it("cuts only at SourceSection boundaries and carries one preceding Section", () => {
    const source = sourceWithSectionLengths("source_long", [
      4_000,
      4_000,
      4_000,
      4_000,
    ]);

    const segments = deriveAnalysisSegments(source);

    expect(segments.map((segment) => segment.sectionIds)).toEqual([
      ["section_01", "section_02"],
      ["section_03", "section_04"],
    ]);
    expect(segments[1]!.contextStart).toBe(source.sections[1]!.start);
    expect(segments[1]!.coreStart).toBe(source.sections[2]!.start);
    expect(segments[1]!.contextEnd).toBe(segments[1]!.coreEnd);
    expect(segments[0]!.coreEnd - segments[0]!.coreStart).toBeGreaterThanOrEqual(
      ANALYSIS_CORE_MIN,
    );
    expect(segments[0]!.coreEnd - segments[0]!.coreStart).toBeLessThanOrEqual(
      ANALYSIS_CORE_MAX,
    );
  });

  it("merges a short tail when the combined core remains within the maximum", () => {
    const source = sourceWithSectionLengths("source_merge_tail", [
      4_000,
      4_000,
      1_000,
    ]);

    expect(deriveAnalysisSegments(source).map((segment) => segment.sectionIds)).toEqual([
      ["section_01", "section_02", "section_03"],
    ]);
  });

  it("rebalances whole Sections to avoid a short tail when both cores can stay valid", () => {
    const source = sourceWithSectionLengths("source_rebalance_tail", [
      3_000,
      3_000,
      3_000,
      3_000,
    ]);

    expect(deriveAnalysisSegments(source).map((segment) => segment.sectionIds)).toEqual([
      ["section_01", "section_02"],
      ["section_03", "section_04"],
    ]);
  });

  it("keeps an unavoidable short tail instead of creating an oversized core", () => {
    const source = sourceWithSectionLengths("source_short_tail", [
      5_000,
      5_000,
      1_000,
    ]);

    const segments = deriveAnalysisSegments(source);

    expect(segments.map((segment) => segment.sectionIds)).toEqual([
      ["section_01", "section_02"],
      ["section_03"],
    ]);
    expect(segments[0]!.coreEnd - segments[0]!.coreStart).toBe(10_000);
    expect(segments[1]!.coreEnd - segments[1]!.coreStart).toBe(1_000);
  });

  it("never splits a single oversized SourceSection", () => {
    const source = sourceWithSectionLengths("source_oversized", [12_000]);

    const [segment] = deriveAnalysisSegments(source);

    expect(segment?.sectionIds).toEqual(["section_01"]);
    expect((segment?.coreEnd ?? 0) - (segment?.coreStart ?? 0)).toBe(12_000);
  });

  it("preserves the Source UTF-16 offsets including surrogate pairs", () => {
    const first = "甲🌊段。";
    const second = "第二段。";
    const normalizedText = `${first}${second}`;
    const source = SourceSchema.parse({
      id: "source_utf16_segments",
      projectId: "project_analysis_segments",
      title: "UTF-16 分段测试",
      originalText: normalizedText,
      normalizedText,
      contentHash: sha256(normalizedText),
      sections: [
        { id: "section_01", title: "第一节", start: 0, end: first.length },
        {
          id: "section_02",
          title: "第二节",
          start: first.length,
          end: normalizedText.length,
        },
      ],
      createdAt: "2026-08-13T00:00:00.000Z",
    });

    const [segment] = deriveAnalysisSegments(source);

    expect(segment).toMatchObject({
      coreStart: 0,
      coreEnd: normalizedText.length,
      contextStart: 0,
      contextEnd: normalizedText.length,
    });
    expect(source.normalizedText.slice(segment!.coreStart, segment!.coreEnd)).toBe(
      normalizedText,
    );
  });

  it("is stable for an immutable Source", () => {
    const source = sourceWithSectionLengths("source_stable", [4_000, 4_000, 2_000]);

    expect(deriveAnalysisSegments(source)).toEqual(deriveAnalysisSegments(source));
  });

  it("fails closed for overlapping SourceSections", () => {
    const source = sourceWithSectionLengths("source_overlap", [4_000, 4_000]);
    const invalid = {
      ...source,
      sections: [
        source.sections[0]!,
        { ...source.sections[1]!, start: source.sections[0]!.end - 1 },
      ],
    };

    expect(() => deriveAnalysisSegments(invalid)).toThrow("SourceSection");
  });
});
