import { describe, expect, it } from "vitest";

import { SourceSchema } from "@/domain/schemas";
import { deriveEvidenceUnits } from "@/domain/source/evidence-units";
import { sha256 } from "@/domain/source/normalize-source";

describe("deterministic Evidence Units", () => {
  it("derives stable paragraph units with UTF-16 offsets", () => {
    const firstParagraph = "甲🌊段。";
    const secondParagraph = "第二段。";
    const normalizedText = `${firstParagraph}\n\n${secondParagraph}`;
    const secondStart = firstParagraph.length + 2;
    const source = SourceSchema.parse({
      id: "source_alpha",
      projectId: "project_test",
      title: "合成测试",
      originalText: normalizedText,
      normalizedText,
      contentHash: sha256(normalizedText),
      sections: [
        {
          id: "section_01",
          title: "正文",
          start: 0,
          end: normalizedText.length,
        },
      ],
      createdAt: "2026-08-12T00:00:00.000Z",
    });

    expect(deriveEvidenceUnits(source)).toEqual([
      {
        id: "evidence_unit:source_alpha:000001",
        sourceId: "source_alpha",
        sectionId: "section_01",
        start: 0,
        end: firstParagraph.length,
        text: firstParagraph,
      },
      {
        id: "evidence_unit:source_alpha:000002",
        sourceId: "source_alpha",
        sectionId: "section_01",
        start: secondStart,
        end: secondStart + secondParagraph.length,
        text: secondParagraph,
      },
    ]);
    expect(deriveEvidenceUnits(source)).toEqual(deriveEvidenceUnits(source));
  });

  it("continues ordinal order across Sections and trims only block edges", () => {
    const sectionOneText = "  第一段。  \n\n第二段。";
    const sectionGap = "\n\n";
    const sectionTwoText = " \t第三段。  ";
    const normalizedText = sectionOneText + sectionGap + sectionTwoText;
    const sectionTwoStart = sectionOneText.length + sectionGap.length;
    const source = SourceSchema.parse({
      id: "source_sections",
      projectId: "project_test",
      title: "跨节测试",
      originalText: normalizedText,
      normalizedText,
      contentHash: sha256(normalizedText),
      sections: [
        {
          id: "section_01",
          title: "第一节",
          start: 0,
          end: sectionOneText.length,
        },
        {
          id: "section_02",
          title: "第二节",
          start: sectionTwoStart,
          end: normalizedText.length,
        },
      ],
      createdAt: "2026-08-12T00:00:00.000Z",
    });

    const units = deriveEvidenceUnits(source);

    expect(units.map((unit) => unit.id)).toEqual([
      "evidence_unit:source_sections:000001",
      "evidence_unit:source_sections:000002",
      "evidence_unit:source_sections:000003",
    ]);
    expect(units.map((unit) => unit.sectionId)).toEqual([
      "section_01",
      "section_01",
      "section_02",
    ]);
    expect(units.map((unit) => unit.text)).toEqual([
      "第一段。",
      "第二段。",
      "第三段。",
    ]);
    for (const unit of units) {
      expect(source.normalizedText.slice(unit.start, unit.end)).toBe(unit.text);
    }
  });
});
