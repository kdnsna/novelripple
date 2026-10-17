import { describe, expect, it } from "vitest";

import { SourceSchema } from "@/domain/schemas";
import {
  rankEvidenceForEdge,
  rankEvidenceForEvent,
  type EvidenceRankingCandidate,
} from "@/domain/review/rank-evidence-units";
import {
  deriveEvidenceUnits,
  sourceReferenceForUnit,
} from "@/domain/source/evidence-units";
import { sha256 } from "@/domain/source/normalize-source";

const paragraphs = [
  "天刚亮。",
  "她把钥匙放在桌上。",
  "窗外下起小雨。",
  "门外传来脚步。",
  "她翻开旧信。",
  "阿澄推开门。",
  "屋里安静下来。",
  "灯芯忽然灭了。",
  "远处有人在等。",
  "故事在这里停住。",
];

function createCandidates(): {
  candidates: EvidenceRankingCandidate[];
  references: ReturnType<typeof sourceReferenceForUnit>[];
} {
  const normalizedText = paragraphs.join("\n\n");
  const source = SourceSchema.parse({
    id: "source_rank_test",
    projectId: "project_rank_test",
    title: "排序测试",
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
  const units = deriveEvidenceUnits(source);
  const references = units.map(sourceReferenceForUnit);
  return {
    candidates: units.map((unit, index) => ({
      id: unit.id,
      reference: references[index]!,
      text: unit.text,
    })),
    references,
  };
}

describe("deterministic evidence ranking", () => {
  it("ranks Edge candidates by minimum distance to both endpoint Events, then unit order", () => {
    const { candidates, references } = createCandidates();
    const ranked = rankEvidenceForEdge({
      candidates,
      events: [
        { id: "event_from", evidence: [references[1]!, references[7]!] },
        { id: "event_to", evidence: [references[3]!] },
      ],
      fromEventId: "event_from",
      toEventId: "event_to",
    });

    expect(ranked.map((item) => item.sourceIndex)).toEqual([
      1, 3, 7, 0, 2, 4, 6, 8, 5, 9,
    ]);
    expect(ranked.map((item) => item.distance)).toEqual([
      0, 0, 0, 1, 1, 1, 1, 1, 2, 2,
    ]);
    expect(ranked.every((item) => item.nameMatches === 0)).toBe(true);
    expect(
      rankEvidenceForEdge({
        candidates,
        events: [
          { id: "event_from", evidence: [references[1]!, references[7]!] },
          { id: "event_to", evidence: [references[3]!] },
        ],
        fromEventId: "event_from",
        toEventId: "event_to",
      }),
    ).toEqual(ranked);
  });

  it("uses shared participant names as the Event tie-breaker after distance", () => {
    const { candidates, references } = createCandidates();
    const ranked = rankEvidenceForEvent({
      candidates,
      event: {
        id: "event_target",
        evidence: [references[4]!],
        participants: ["char_acheng", "char_missing"],
      },
      characters: [
        { id: "char_acheng", name: "阿澄", aliases: ["小澄"] },
        { id: "char_other", name: "周岚", aliases: [] },
      ],
    });

    expect(ranked.slice(0, 4).map((item) => item.sourceIndex)).toEqual([
      4, 5, 3, 2,
    ]);
    expect(ranked[0]).toMatchObject({ distance: 0 });
    expect(ranked[1]).toMatchObject({ distance: 1, nameMatches: 1 });
    expect(ranked[2]).toMatchObject({ distance: 1, nameMatches: 0 });
    expect(ranked[3]?.sourceIndex).toBe(2);
  });

  it("falls back to unit order without anchors and handles an unknown Event", () => {
    const { candidates } = createCandidates();
    const ranked = rankEvidenceForEvent({
      candidates,
      event: null,
      characters: [],
    });

    expect(ranked.map((item) => item.sourceIndex)).toEqual(
      candidates.map((_, index) => index),
    );
    expect(ranked.every((item) => item.distance === null)).toBe(true);
  });
});
