import { describe, expect, it } from "vitest";

import {
  SourceSchema,
  StoryMapLocalExtractionCandidateSchema,
  StoryMapReconciliationCandidateSchema,
  type Source,
  type StoryMapLocalExtractionCandidate,
} from "@/domain/schemas";
import type { AnalysisSegment } from "@/domain/source/analysis-segments";
import {
  dedupeResolvedSegmentCandidates,
  resolveLocalStoryMapCandidate,
  resolveReconciledStoryMapCandidate,
  temporaryEvidenceReferenceId,
} from "@/domain/source/resolve-story-map-evidence";
import { sha256 } from "@/domain/source/normalize-source";

function createSource(input?: {
  id?: string;
  first?: string;
  second?: string;
}): Source {
  const first = input?.first ?? "前文铺垫。";
  const second = input?.second ?? "甲决定离开。乙目送甲离开。";
  const separator = "\n\n";
  const normalizedText = `${first}${separator}${second}`;
  const secondStart = first.length + separator.length;

  return SourceSchema.parse({
    id: input?.id ?? "source_candidate",
    projectId: "project_candidate",
    title: "合成候选测试",
    originalText: normalizedText,
    normalizedText,
    contentHash: sha256(normalizedText),
    sections: [
      { id: "section_01", title: "前文", start: 0, end: first.length },
      {
        id: "section_02",
        title: "正文",
        start: secondStart,
        end: normalizedText.length,
      },
    ],
    createdAt: "2026-08-13T00:00:00.000Z",
  });
}

function createSegment(
  source: Source,
  overrides: Partial<AnalysisSegment> = {},
): AnalysisSegment {
  return {
    id: `analysis_segment:${source.id}:0002`,
    sourceId: source.id,
    sectionIds: ["section_02"],
    coreStart: source.sections[1]!.start,
    coreEnd: source.sections[1]!.end,
    contextStart: source.sections[0]!.start,
    contextEnd: source.sections[1]!.end,
    ...overrides,
  };
}

function localCandidate(
  overrides: Partial<StoryMapLocalExtractionCandidate> = {},
): StoryMapLocalExtractionCandidate {
  return StoryMapLocalExtractionCandidateSchema.parse({
    characters: [
      {
        localId: "character_local_1",
        name: "甲",
        aliases: [],
        role: "protagonist",
        initialState: "等待出发",
      },
      {
        localId: "character_local_2",
        name: "乙",
        aliases: [],
        role: "supporting",
        initialState: "在场观察",
      },
    ],
    events: [
      {
        localId: "event_local_1",
        title: "甲作出选择",
        summary: "甲决定离开。",
        sequence: 1,
        participants: ["character_local_1"],
        stateChanges: ["甲开始行动"],
        evidenceKind: "fact",
        evidence: [
          { sectionId: "section_02", exactQuote: "甲决定离开。" },
          { sectionId: "section_01", exactQuote: "前文铺垫。" },
        ],
      },
    ],
    edges: [],
    ...overrides,
  });
}

function requireResolvedLocal(
  source: Source,
  segment: AnalysisSegment,
  candidate = localCandidate(),
) {
  const result = resolveLocalStoryMapCandidate({
    local: candidate,
    source,
    segment,
  });
  expect(result.success).toBe(true);
  if (!result.success) throw new Error("Expected local candidate to resolve");
  return result;
}

describe("section-first Story Map candidates", () => {
  it("resolves an exact local claim into a server-owned SourceReference", () => {
    const source = createSource();
    const segment = createSegment(source);

    const resolved = requireResolvedLocal(source, segment);

    expect(resolved.candidate.events[0]?.evidenceReferenceIds).toHaveLength(2);
    expect(resolved.candidate.events[0]?.localId).toContain(segment.id);
    expect(resolved.candidate.events[0]?.participants[0]).toContain(segment.id);
    expect(resolved.references[0]?.reference).toEqual({
      sourceId: source.id,
      sectionId: "section_02",
      start: source.sections[1]!.start,
      end: source.sections[1]!.start + "甲决定离开。".length,
      excerptHash: sha256("甲决定离开。"),
    });
    expect(JSON.stringify(resolved.candidate)).not.toContain("exactQuote");
  });

  it("allows preceding context only as supplemental boundary Evidence", () => {
    const source = createSource();
    const segment = createSegment(source);

    const result = resolveLocalStoryMapCandidate({
      local: localCandidate(),
      source,
      segment,
    });

    expect(result.success).toBe(true);
  });

  it("fails closed when the primary Event Evidence belongs only to context", () => {
    const source = createSource();
    const segment = createSegment(source);
    const candidate = localCandidate();
    candidate.events[0]!.evidence.reverse();

    const result = resolveLocalStoryMapCandidate({
      local: candidate,
      source,
      segment,
    });

    expect(result).toEqual({
      success: false,
      issues: [
        expect.objectContaining({
          path: "events.0.evidence.0",
          message: expect.stringContaining("core"),
        }),
      ],
    });
  });

  it.each([
    {
      label: "unknown Section",
      claim: { sectionId: "section_missing", exactQuote: "甲决定离开。" },
      message: "Section",
    },
    {
      label: "missing quote",
      claim: { sectionId: "section_02", exactQuote: "不存在的摘录" },
      message: "未在",
    },
  ])("rejects $label", ({ claim, message }) => {
    const source = createSource();
    const candidate = localCandidate();
    candidate.events[0]!.evidence = [claim];

    const result = resolveLocalStoryMapCandidate({
      local: candidate,
      source,
      segment: createSegment(source),
    });

    expect(result).toEqual({
      success: false,
      issues: [expect.objectContaining({ message: expect.stringContaining(message) })],
    });
  });

  it("rejects an exact quote that is not unique inside its Section", () => {
    const source = createSource({ second: "重复。重复。" });
    const candidate = localCandidate();
    candidate.events[0]!.evidence = [
      { sectionId: "section_02", exactQuote: "重复。" },
    ];

    const result = resolveLocalStoryMapCandidate({
      local: candidate,
      source,
      segment: createSegment(source),
    });

    expect(result).toEqual({
      success: false,
      issues: [expect.objectContaining({ message: expect.stringContaining("不唯一") })],
    });
  });

  it("rejects duplicate Evidence instead of silently deduplicating it", () => {
    const source = createSource();
    const candidate = localCandidate();
    const claim = { sectionId: "section_02", exactQuote: "甲决定离开。" };
    candidate.events[0]!.evidence = [claim, claim];

    const result = resolveLocalStoryMapCandidate({
      local: candidate,
      source,
      segment: createSegment(source),
    });

    expect(result).toEqual({
      success: false,
      issues: [expect.objectContaining({ message: expect.stringContaining("重复") })],
    });
  });

  it("rejects dangling local participants and Edge endpoints", () => {
    const source = createSource();
    const participantCandidate = localCandidate();
    participantCandidate.events[0]!.participants = ["character_missing"];
    const edgeCandidate = localCandidate({
      edges: [
        {
          localId: "edge_local_1",
          from: "event_local_1",
          to: "event_missing",
          type: "causes",
          explanation: "测试悬空 Edge",
          confidence: 0.9,
          confirmed: false,
          evidence: [{ sectionId: "section_02", exactQuote: "甲决定离开。" }],
        },
      ],
    });

    expect(
      resolveLocalStoryMapCandidate({
        local: participantCandidate,
        source,
        segment: createSegment(source),
      }),
    ).toEqual({
      success: false,
      issues: [expect.objectContaining({ message: expect.stringContaining("participant") })],
    });
    expect(
      resolveLocalStoryMapCandidate({
        local: edgeCandidate,
        source,
        segment: createSegment(source),
      }),
    ).toEqual({
      success: false,
      issues: [expect.objectContaining({ message: expect.stringContaining("悬空") })],
    });
  });

  it("rejects duplicate local IDs before global reconciliation", () => {
    const source = createSource();
    const candidate = localCandidate();
    candidate.characters.push({ ...candidate.characters[0]! });

    const result = resolveLocalStoryMapCandidate({
      local: candidate,
      source,
      segment: createSegment(source),
    });

    expect(result).toEqual({
      success: false,
      issues: [expect.objectContaining({ message: expect.stringContaining("ID 重复") })],
    });
  });

  it("rejects scalar arrays without local coercion", () => {
    const valid = localCandidate();
    const event = valid.events[0]!;

    expect(() =>
      StoryMapLocalExtractionCandidateSchema.parse({
        ...valid,
        events: [{ ...event, stateChanges: "changed" }],
      }),
    ).toThrow();
    expect(() =>
      StoryMapLocalExtractionCandidateSchema.parse({
        ...valid,
        events: [{ ...event, participants: event.participants[0] }],
      }),
    ).toThrow();
  });

  it("deduplicates overlapping Event positions before reconciliation", () => {
    const source = createSource();
    const first = requireResolvedLocal(
      source,
      createSegment(source, {
        id: `analysis_segment:${source.id}:0001`,
      }),
    );
    const second = requireResolvedLocal(
      source,
      createSegment(source, {
        id: `analysis_segment:${source.id}:0002`,
      }),
    );

    const deduplicated = dedupeResolvedSegmentCandidates([
      first.candidate,
      second.candidate,
    ]);

    expect(deduplicated.flatMap((item) => item.events)).toHaveLength(1);
  });

  it("maps reconciled temporary references into the unchanged final Evidence", () => {
    const source = createSource();
    const local = requireResolvedLocal(source, createSegment(source));
    const evidenceReferenceIds = local.candidate.events[0]!.evidenceReferenceIds;
    const candidate = StoryMapReconciliationCandidateSchema.parse({
      title: "合成故事",
      logline: "甲决定离开。",
      characters: [
        {
          id: "character_1",
          name: "甲",
          aliases: [],
          role: "protagonist",
          initialState: "等待出发",
        },
      ],
      events: [
        {
          id: "event_1",
          title: "甲作出选择",
          summary: "甲决定离开。",
          sequence: 1,
          participants: ["character_1"],
          stateChanges: ["甲开始行动"],
          evidenceKind: "fact",
          evidenceReferenceIds,
        },
      ],
      edges: [],
      endingCandidates: [
        {
          id: "ending_1",
          targetEventId: "event_1",
          requirement: "甲已经离开",
          evidenceReferenceIds,
        },
      ],
    });

    const resolved = resolveReconciledStoryMapCandidate({
      candidate,
      source,
      references: local.references,
    });

    expect(resolved.success).toBe(true);
    if (!resolved.success) return;
    const reference = resolved.content.events[0]!.evidence[0]!;
    expect(reference).toEqual(
      local.references.find((item) => item.id === evidenceReferenceIds[0])
        ?.reference,
    );
    expect(source.normalizedText.slice(reference.start, reference.end)).toBe(
      "甲决定离开。",
    );
  });

  it("fails closed for unknown, duplicate, and cross-Source temporary references", () => {
    const source = createSource();
    const local = requireResolvedLocal(source, createSegment(source));
    const reference = local.references[0]!;

    expect(temporaryEvidenceReferenceId(reference.reference)).toBe(reference.id);

    for (const evidenceReferenceIds of [
      ["evidence_ref:unknown"],
      [reference.id, reference.id],
    ]) {
      const candidate = minimalReconciledCandidate(evidenceReferenceIds);
      const result = resolveReconciledStoryMapCandidate({
        candidate,
        source,
        references: local.references,
      });
      expect(result.success).toBe(false);
    }

    const otherSource = createSource({ id: "source_other" });
    const otherLocal = requireResolvedLocal(otherSource, createSegment(otherSource));
    const crossSource = resolveReconciledStoryMapCandidate({
      candidate: minimalReconciledCandidate([
        otherLocal.references[0]!.id,
      ]),
      source,
      references: otherLocal.references,
    });
    expect(crossSource.success).toBe(false);
  });
});

function minimalReconciledCandidate(evidenceReferenceIds: string[]) {
  return StoryMapReconciliationCandidateSchema.parse({
    title: "合成故事",
    logline: "测试临时证据引用。",
    characters: [
      {
        id: "character_1",
        name: "甲",
        aliases: [],
        role: "protagonist",
        initialState: "等待出发",
      },
    ],
    events: [
      {
        id: "event_1",
        title: "测试事件",
        summary: "测试临时证据引用。",
        sequence: 1,
        participants: ["character_1"],
        stateChanges: [],
        evidenceKind: "fact",
        evidenceReferenceIds,
      },
    ],
    edges: [],
    endingCandidates: [
      {
        id: "ending_1",
        targetEventId: "event_1",
        requirement: "测试事件完成",
        evidenceReferenceIds,
      },
    ],
  });
}
