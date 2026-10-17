import { describe, expect, it } from "vitest";

import type {
  StoryMapCandidateEvent,
  StoryMapExtractionCandidate,
} from "@/domain/schemas";
import {
  CHUNK_HARD_MAX_CHARS,
  CHUNK_MAX_CHARS,
  deriveEvidenceUnitChunks,
} from "@/domain/source/evidence-unit-chunks";
import { deriveEvidenceUnits, type EvidenceUnit } from "@/domain/source/evidence-units";
import { deriveNameCandidates } from "@/domain/source/name-candidates";
import {
  applyMerge,
  applyRoster,
  poolChunkCandidates,
  validateChunkExtraction,
  validateChunkGleaning,
  validateRoster,
} from "@/domain/story-map/assemble-story-map-candidate";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";

function syntheticUnits(lengths: number[]): EvidenceUnit[] {
  let offset = 0;
  return lengths.map((length, index) => {
    const unit = {
      id: `evidence_unit:s:${String(index + 1).padStart(6, "0")}`,
      sourceId: "s",
      sectionId: "section_01",
      start: offset,
      end: offset + length,
      text: "字".repeat(length),
    };
    offset += length + 2;
    return unit;
  });
}

describe("Evidence Unit chunking", () => {
  it("covers every paragraph exactly once, in order, without splitting any", () => {
    const units = syntheticUnits(Array.from({ length: 60 }, (_, i) => 200 + ((i * 37) % 400)));
    const chunks = deriveEvidenceUnitChunks(units);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((chunk) => chunk.coreUnitIds)).toEqual(units.map((unit) => unit.id));
    for (const chunk of chunks.slice(0, -1)) {
      const length = chunk.coreUnitIds
        .map((id) => units.find((unit) => unit.id === id)!.text.length)
        .reduce((a, b) => a + b, 0);
      expect(length).toBeGreaterThanOrEqual(3_000);
      expect(length).toBeLessThanOrEqual(9_000);
    }
  });

  it("carries the two preceding paragraphs as read-only context", () => {
    const chunks = deriveEvidenceUnitChunks(syntheticUnits(Array(40).fill(500)));
    expect(chunks[0]!.contextUnitIds).toEqual([]);
    const previousCore = chunks[0]!.coreUnitIds;
    expect(chunks[1]!.contextUnitIds).toEqual(previousCore.slice(-2));
  });

  it("drops the oldest context units so core + context never exceeds the chunk max", () => {
    const units = syntheticUnits([40, 40, 40]);
    const chunks = deriveEvidenceUnitChunks(units, {
      targetChars: 80,
      minChars: 10,
      maxChars: 100,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.contextUnitIds).toEqual(["evidence_unit:s:000002"]);
    for (const chunk of chunks) {
      const length = [...chunk.coreUnitIds, ...chunk.contextUnitIds]
        .map((id) => units.find((unit) => unit.id === id)!.text.length)
        .reduce((total, value) => total + value, 0);
      expect(length).toBeLessThanOrEqual(100);
    }
  });

  it("fails closed when one paragraph exceeds the hard cap instead of splitting it", () => {
    expect(CHUNK_HARD_MAX_CHARS).toBe(2 * CHUNK_MAX_CHARS);
    const units = syntheticUnits([CHUNK_HARD_MAX_CHARS + 1]);

    expect(() => deriveEvidenceUnitChunks(units)).toThrow(/硬上限/);
    expect(() => deriveEvidenceUnitChunks(units)).toThrow(units[0]!.id);
  });

  it("folds a short tail into the previous chunk when it fits", () => {
    const chunks = deriveEvidenceUnitChunks(syntheticUnits([3_000, 3_000, 1_000]));
    expect(chunks).toHaveLength(1);
  });

  it("splits the public fixture into more than one chunk", async () => {
    const fixture = await loadRippleFixture();
    const chunks = deriveEvidenceUnitChunks(deriveEvidenceUnits(fixture.source));
    expect(chunks.length).toBe(2);
  });
});

describe("deterministic name candidates", () => {
  it("finds the fixture's characters, preferring stable three-character names", async () => {
    const fixture = await loadRippleFixture();
    const names = deriveNameCandidates(deriveEvidenceUnits(fixture.source)).map((c) => c.name);
    for (const name of ["许澄", "周岚", "许川", "顾闻舟", "沈砚"]) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain("顾闻");
  });
});

function event(id: string, unit: string, participants = ["a"], sequence = 1): StoryMapCandidateEvent {
  return {
    id,
    title: id,
    summary: id,
    sequence,
    participants,
    stateChanges: [],
    evidenceKind: "fact",
    evidenceUnitIds: [unit],
  };
}

function extraction(partial: Partial<StoryMapExtractionCandidate>): StoryMapExtractionCandidate {
  return {
    title: "t",
    logline: "l",
    characters: [{ id: "a", name: "甲", aliases: [], role: "protagonist", initialState: "s", kind: "individual" }],
    events: [event("e1", "u1")],
    edges: [],
    ...partial,
  };
}

describe("chunk candidate assembly", () => {
  it("rejects evidence outside the chunk and characters that join no event", () => {
    const issues = validateChunkExtraction(
      extraction({
        characters: [
          { id: "a", name: "甲", aliases: [], role: "protagonist", initialState: "s", kind: "individual" as const },
          { id: "b", name: "乙", aliases: [], role: "supporting", initialState: "s", kind: "individual" as const },
        ],
        events: [event("e1", "u9")],
      }),
      new Set(["u1"]),
    );
    expect(issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("本阶段未提供的 Unit"),
        expect.stringContaining("人物必须至少参与"),
      ]),
    );
  });

  it("rejects gleaning that repeats existing IDs instead of adding new content", () => {
    const base = extraction({});
    const issues = validateChunkGleaning(
      { characters: [], events: [event("e1", "u1")], edges: [] },
      base,
      new Set(["u1"]),
    );
    expect(issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("ID 已存在")]),
    );
  });

  it("renames colliding IDs per chunk, then lets the roster merge them back", () => {
    const order = new Map([["u1", 0], ["u2", 1], ["u3", 2]]);
    const pool = poolChunkCandidates(
      [
        { chunkIndex: 0, extraction: extraction({}), gleaning: { characters: [], events: [], edges: [] } },
        {
          chunkIndex: 1,
          extraction: extraction({ events: [event("e1", "u3")] }),
          gleaning: { characters: [], events: [], edges: [] },
        },
      ],
      order,
    );
    expect(pool.characters.map((c) => c.id)).toEqual(["a", "a__c2"]);
    expect(pool.events.map((e) => [e.id, e.participants])).toEqual([
      ["e1", ["a"]],
      ["e1__c2", ["a__c2"]],
    ]);

    const incomplete = { characters: [{ id: "a", name: "甲", aliases: [], role: "protagonist" as const, initialState: "s", mergedFrom: ["a"] }] };
    expect(validateRoster(incomplete, pool).map((issue) => issue.message)).toEqual([
      "人物候选没有归入任何人物：a__c2",
    ]);
    const roster = { characters: [{ ...incomplete.characters[0]!, mergedFrom: ["a", "a__c2"] }] };
    expect(validateRoster(roster, pool)).toEqual([]);
    const merged = applyRoster(pool, roster);
    expect(merged.events.map((e) => e.participants)).toEqual([["a"], ["a"]]);
  });

  it("merges duplicate events without losing evidence and drops self-loop edges", () => {
    const pool = {
      characters: [{ id: "a", name: "甲", aliases: [], role: "protagonist" as const, initialState: "s" }],
      events: [
        { ...event("e1", "u1"), chunkIndex: 0 },
        { ...event("e2", "u2"), chunkIndex: 0 },
        { ...event("e2_dup", "u5"), chunkIndex: 1 },
      ],
      edges: [
        { id: "x", from: "e2", to: "e2_dup", type: "causes" as const, explanation: "x", confidence: 1, confirmed: false, evidenceUnitIds: ["u2"] },
      ],
    };
    const result = applyMerge(
      pool,
      [{ id: "end", targetEventId: "e2_dup", requirement: "r", evidenceUnitIds: ["u5"] }],
      {
        title: "T",
        logline: "L",
        duplicateEventGroups: [{ keepEventId: "e2", duplicateEventIds: ["e2_dup"] }],
        duplicateEndingGroups: [],
        edges: [{ id: "y", from: "e1", to: "e2_dup", type: "enables", explanation: "y", confidence: 0.8, confirmed: false, evidenceUnitIds: ["u1"] }],
      },
    );
    if (!result.success) throw new Error(JSON.stringify(result.issues));
    expect(result.candidate.events.map((e) => [e.id, e.sequence, e.evidenceUnitIds])).toEqual([
      ["e1", 1, ["u1"]],
      ["e2", 2, ["u2", "u5"]],
    ]);
    expect(result.candidate.edges.map((e) => [e.id, e.from, e.to])).toEqual([["y", "e1", "e2"]]);
    expect(result.candidate.endingCandidates[0]!.targetEventId).toBe("e2");
  });

  it("merges duplicate edge and ending evidence after event merge resolution", () => {
    const pool = {
      characters: [{ id: "a", name: "甲", aliases: [], role: "protagonist" as const, initialState: "s" }],
      events: [
        { ...event("e1", "u1"), chunkIndex: 0 },
        { ...event("e2", "u2"), chunkIndex: 0 },
        { ...event("e2_dup", "u3"), chunkIndex: 1 },
      ],
      edges: [
        { id: "edge_a", from: "e1", to: "e2", type: "causes" as const, explanation: "x", confidence: 1, confirmed: false, evidenceUnitIds: ["u1", "u2"] },
        { id: "edge_b", from: "e1", to: "e2_dup", type: "causes" as const, explanation: "x", confidence: 1, confirmed: false, evidenceUnitIds: ["u3", "u2"] },
      ],
    };
    const result = applyMerge(
      pool,
      [
        { id: "end_a", targetEventId: "e2_dup", requirement: "同一个结局", evidenceUnitIds: ["u1"] },
        { id: "end_b", targetEventId: "e2", requirement: "同一个结局", evidenceUnitIds: ["u3", "u1"] },
      ],
      {
        title: "T",
        logline: "L",
        duplicateEventGroups: [{ keepEventId: "e2", duplicateEventIds: ["e2_dup"] }],
        duplicateEndingGroups: [],
        edges: [
          { id: "edge_c", from: "e1", to: "e2", type: "causes", explanation: "x", confidence: 1, confirmed: false, evidenceUnitIds: ["u1"] },
        ],
      },
    );
    if (!result.success) throw new Error(JSON.stringify(result.issues));

    expect(result.candidate.edges.map((edge) => [edge.id, edge.evidenceUnitIds])).toEqual([
      ["edge_a", ["u1", "u2", "u3"]],
    ]);
    expect(result.candidate.endingCandidates.map((ending) => [ending.id, ending.evidenceUnitIds])).toEqual([
      ["end_a", ["u1", "u3"]],
    ]);
  });

  it("limits merge-pass edge evidence to the events, edges and endings shown to it", () => {
    const pool = {
      characters: [{ id: "a", name: "甲", aliases: [], role: "protagonist" as const, initialState: "s" }],
      events: [{ ...event("e1", "u1"), chunkIndex: 0 }, { ...event("e2", "u2"), chunkIndex: 0 }],
      edges: [
        { id: "edge_existing", from: "e1", to: "e2", type: "foreshadows" as const, explanation: "x", confidence: 1, confirmed: false, evidenceUnitIds: ["u3"] },
      ],
    };
    const endings = [{ id: "end", targetEventId: "e2" as const, requirement: "r", evidenceUnitIds: ["u5"] }];
    const baseMerge = {
      title: "T",
      logline: "L",
      duplicateEventGroups: [],
      duplicateEndingGroups: [],
      edges: [
        { id: "edge_ok", from: "e1", to: "e2", type: "causes" as const, explanation: "x", confidence: 1, confirmed: false, evidenceUnitIds: ["u3", "u5"] },
      ],
    };

    const allowed = applyMerge(pool, endings, baseMerge);
    expect(allowed.success).toBe(true);

    const rejected = applyMerge(pool, endings, {
      ...baseMerge,
      edges: [
        { ...baseMerge.edges[0]!, evidenceUnitIds: ["u9"] },
      ],
    });
    expect(rejected.success).toBe(false);
    if (rejected.success) return;
    expect(rejected.issues).toEqual([
      {
        path: "edges.0.evidenceUnitIds.0",
        message: "Evidence 引用了本阶段未提供的 Unit：u9",
      },
    ]);
  });

  it("rejects merge groups that reference unknown events or reuse an event", () => {
    const pool = {
      characters: [],
      events: [{ ...event("e1", "u1"), chunkIndex: 0 }, { ...event("e2", "u2"), chunkIndex: 0 }],
      edges: [],
    };
    const result = applyMerge(pool, [], {
      title: "T",
      logline: "L",
      duplicateEventGroups: [
        { keepEventId: "e1", duplicateEventIds: ["e2"] },
        { keepEventId: "e2", duplicateEventIds: ["e9"] },
      ],
      duplicateEndingGroups: [],
      edges: [],
    });
    expect(result.success).toBe(false);
  });
});
