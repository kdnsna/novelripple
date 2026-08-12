import { describe, expect, it } from "vitest";

import {
  StoryMapContentCandidateSchema,
  StoryMapExtractionCandidateSchema,
  type SourceReference,
  type StoryMap,
  type StoryMapContent,
} from "@/domain/schemas";
import {
  deriveEvidenceUnits,
  sourceReferenceForUnit,
  type EvidenceUnit,
} from "@/domain/source/evidence-units";
import {
  resolveEvidenceUnitIds,
  resolveStoryMapContentCandidate,
} from "@/domain/source/resolve-story-map-evidence";
import { sha256 } from "@/domain/source/normalize-source";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";

function unitIdsForReference(
  reference: SourceReference,
  units: EvidenceUnit[],
): string[] {
  return units
    .filter(
      (unit) =>
        unit.sectionId === reference.sectionId &&
        unit.start <= reference.start &&
        unit.end >= reference.end,
    )
    .map((unit) => unit.id);
}

function candidateFromStoryMap(storyMap: StoryMap, units: EvidenceUnit[]) {
  const withUnits = <T extends { evidence: SourceReference[] }>(value: T) => {
    const { evidence, ...rest } = value;
    return {
      ...rest,
      evidenceUnitIds: evidence.flatMap((reference) =>
        unitIdsForReference(reference, units),
      ),
    };
  };

  return StoryMapContentCandidateSchema.parse({
    title: storyMap.title,
    logline: storyMap.logline,
    characters: storyMap.characters,
    events: storyMap.events.map(withUnits),
    edges: storyMap.edges.map(withUnits),
    endingCandidates: storyMap.endingCandidates.map(withUnits),
  });
}

function collectReferences(content: StoryMapContent): SourceReference[] {
  return [
    ...content.events.flatMap((event) => event.evidence),
    ...content.edges.flatMap((edge) => edge.evidence),
    ...content.endingCandidates.flatMap((ending) => ending.evidence),
  ];
}

describe("Story Map model candidates", () => {
  it("resolves Unit IDs into server-owned SourceReferences", async () => {
    const { source, storyMap } = await loadRippleFixture();
    const units = deriveEvidenceUnits(source);
    const candidate = candidateFromStoryMap(storyMap, units);

    const resolved = resolveStoryMapContentCandidate(candidate, source, units);

    expect(resolved.success).toBe(true);
    if (!resolved.success) return;
    expect(resolved.content.events).toHaveLength(storyMap.events.length);
    for (const reference of collectReferences(resolved.content)) {
      expect(reference.sourceId).toBe(source.id);
      expect(reference.excerptHash).toBe(
        sha256(source.normalizedText.slice(reference.start, reference.end)),
      );
    }
  });

  it("computes UTF-16 offsets and hashes from the Unit instead of model text", () => {
    const unit = {
      id: "evidence_unit:source_utf16:000001",
      sourceId: "source_utf16",
      sectionId: "section_01",
      start: 4,
      end: 8,
      text: "证据片段",
    };

    expect(sourceReferenceForUnit(unit)).toEqual({
      sourceId: "source_utf16",
      sectionId: "section_01",
      start: 4,
      end: 8,
      excerptHash: sha256("证据片段"),
    });
  });

  it("fails closed for unknown, duplicate and other-Source Unit IDs", async () => {
    const { source } = await loadRippleFixture();
    const sourceUnits = deriveEvidenceUnits(source);
    const otherUnits = deriveEvidenceUnits({ ...source, id: "source_other" });
    const path = "events.0.evidenceUnitIds";

    expect(resolveEvidenceUnitIds(["unknown"], sourceUnits, path)).toEqual({
      success: false,
      issues: [
        {
          path: `${path}.0`,
          message: "Evidence 引用了未知 Unit",
        },
      ],
    });
    expect(
      resolveEvidenceUnitIds(
        [sourceUnits[0]!.id, sourceUnits[0]!.id],
        sourceUnits,
        path,
      ),
    ).toEqual({
      success: false,
      issues: [
        {
          path: `${path}.1`,
          message: "Evidence Unit ID 重复",
        },
      ],
    });
    expect(
      resolveEvidenceUnitIds([otherUnits[0]!.id], sourceUnits, path),
    ).toEqual({
      success: false,
      issues: [
        {
          path: `${path}.0`,
          message: "Evidence 引用了未知 Unit",
        },
      ],
    });
  });

  it("rejects quote claims because model candidates only accept Unit IDs", async () => {
    const { storyMap } = await loadRippleFixture();
    const event = storyMap.events[0]!;

    expect(() =>
      StoryMapExtractionCandidateSchema.parse({
        title: storyMap.title,
        logline: storyMap.logline,
        characters: storyMap.characters,
        events: [
          {
            ...event,
            evidence: [
              { sectionId: "section_01", exactQuote: "模型不应重抄原文" },
            ],
          },
        ],
        edges: [],
      }),
    ).toThrow();
  });

  it("rejects scalar stateChanges and participants without coercion", async () => {
    const { source, storyMap } = await loadRippleFixture();
    const units = deriveEvidenceUnits(source);
    const content = candidateFromStoryMap(storyMap, units);
    const validExtraction = StoryMapExtractionCandidateSchema.parse({
      title: content.title,
      logline: content.logline,
      characters: content.characters,
      events: content.events,
      edges: content.edges,
    });
    const firstEvent = validExtraction.events[0]!;

    expect(() =>
      StoryMapExtractionCandidateSchema.parse({
        ...validExtraction,
        events: [
          { ...firstEvent, stateChanges: "changed" },
          ...validExtraction.events.slice(1),
        ],
      }),
    ).toThrow();
    expect(() =>
      StoryMapExtractionCandidateSchema.parse({
        ...validExtraction,
        events: [
          { ...firstEvent, participants: firstEvent.participants[0] },
          ...validExtraction.events.slice(1),
        ],
      }),
    ).toThrow();
  });
});
