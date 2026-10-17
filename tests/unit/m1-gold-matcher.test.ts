import { describe, expect, it } from "vitest";

import {
  SourceSchema,
  StoryMapSchema,
  type StoryMap,
} from "@/domain/schemas";
import {
  deriveEvidenceUnits,
  sourceReferenceForUnit,
} from "@/domain/source/evidence-units";
import {
  extractMarkdownSections,
  normalizeSourceText,
  sha256,
} from "@/domain/source/normalize-source";
import { UNIT_WINDOW, matchM1Gold } from "@/evals/m1-gold-matcher";
import type { M1Gold } from "@/evals/m1-gold";

const SOURCE_TEXT = [
  "甲走进钟楼。",
  "乙留在门外。",
  "甲发现了信。",
  "乙追到海边。",
  "甲把信交给乙。",
  "乙读完了信。",
  "甲决定离开。",
  "乙关上了灯。",
].join("\n\n");

function createSource() {
  const originalText = SOURCE_TEXT;
  const normalizedText = normalizeSourceText(originalText);
  return SourceSchema.parse({
    id: "source_test",
    projectId: "project_test",
    title: "仅用于测试的虚构短篇",
    originalText,
    normalizedText,
    contentHash: sha256(normalizedText),
    sections: extractMarkdownSections(normalizedText),
    createdAt: "2026-10-17T00:00:00.000Z",
  });
}

const source = createSource();
const units = deriveEvidenceUnits(source);

function reference(unit: number) {
  return sourceReferenceForUnit(units[unit - 1]!);
}

function goldEvidence(unit: number) {
  return {
    unit,
    unitId: `u${String(unit).padStart(6, "0")}`,
    section: 1,
    quote: "用于测试的虚构引文",
    start: 0,
    end: 4,
  };
}

function createStoryMap(input: {
  characters: Array<{ id: string; name: string; aliases?: string[] }>;
  events: Array<{
    id: string;
    participants: string[];
    evidenceUnits: number[];
  }>;
  edges?: Array<{
    id: string;
    from: string;
    to: string;
    evidenceUnits: number[];
  }>;
  endings: Array<{
    id: string;
    targetEventId: string;
    requirement: string;
    evidenceUnits: number[];
  }>;
}): StoryMap {
  return StoryMapSchema.parse({
    schemaVersion: 1,
    id: "story_map_test_v1",
    sourceId: source.id,
    version: 1,
    status: "draft",
    title: "仅用于测试的虚构故事",
    logline: "甲和乙在虚构的钟楼里完成一次测试。",
    characters: input.characters.map((character) => ({
      id: character.id,
      name: character.name,
      aliases: character.aliases ?? [],
      role: "supporting",
      initialState: "仅用于测试的虚构状态",
    })),
    events: input.events.map((event, index) => ({
      id: event.id,
      title: `测试事件${index + 1}`,
      summary: "仅用于测试的虚构事件。",
      sequence: index + 1,
      participants: event.participants,
      stateChanges: [],
      evidenceKind: "fact",
      evidence: event.evidenceUnits.map(reference),
    })),
    edges: (input.edges ?? []).map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      type: "causes",
      explanation: "仅用于测试的虚构因果。",
      confidence: 1,
      confirmed: true,
      evidence: edge.evidenceUnits.map(reference),
    })),
    endingCandidates: input.endings.map((ending) => ({
      id: ending.id,
      targetEventId: ending.targetEventId,
      requirement: ending.requirement,
      evidence: ending.evidenceUnits.map(reference),
    })),
  });
}

function createGold(input: {
  characters: Array<{
    id: string;
    name: string;
    aliases?: string[];
    tier?: "core" | "supporting";
  }>;
  mentionedOnly?: Array<{ name: string }>;
  events: Array<{
    id: string;
    characterIds: string[];
    evidenceUnits: number[];
  }>;
  causalLinks?: Array<{
    id: string;
    from: string;
    to: string;
    strength: "hard" | "soft";
  }>;
  endings: Array<{
    id: string;
    characterIds: string[];
    evidenceUnits: number[];
    interpretive?: boolean;
  }>;
}): M1Gold {
  return {
    schemaVersion: 1,
    storyId: "m1-test",
    characters: input.characters.map((character) => ({
      id: character.id,
      name: character.name,
      aliases: character.aliases ?? [],
      tier: character.tier ?? "core",
      evidence: [goldEvidence(1)],
    })),
    mentionedOnly: (input.mentionedOnly ?? []).map((item) => ({
      name: item.name,
      evidence: [goldEvidence(2)],
    })),
    events: input.events.map((event, index) => ({
      id: event.id,
      label: `测试黄金事件${index + 1}`,
      storyOrder: index + 1,
      narrativeMode: "scene",
      characterIds: event.characterIds,
      narrativeFirstUnit: event.evidenceUnits[0]!,
      evidence: event.evidenceUnits.map(goldEvidence),
    })),
    causalLinks: (input.causalLinks ?? []).map((link, index) => ({
      id: link.id,
      from: link.from,
      to: link.to,
      strength: link.strength,
      label: `测试黄金因果${index + 1}`,
      evidence: [goldEvidence(1)],
    })),
    endings: input.endings.map((ending, index) => ({
      id: ending.id,
      label: `测试黄金结局${index + 1}`,
      interpretive: ending.interpretive ?? false,
      characterIds: ending.characterIds,
      evidence: ending.evidenceUnits.map(goldEvidence),
    })),
  };
}

describe("M1 gold matcher", () => {
  it("matches events by unit window and character overlap with one-to-one assignment", () => {
    const storyMap = createStoryMap({
      characters: [
        { id: "cand_hero", name: "阿甲" },
        { id: "cand_ally", name: "乙" },
      ],
      events: [
        { id: "event_c1", participants: ["cand_hero"], evidenceUnits: [4] },
        { id: "event_c2", participants: ["cand_ally"], evidenceUnits: [7] },
        { id: "event_c3", participants: ["cand_ally"], evidenceUnits: [8] },
        { id: "event_outside", participants: ["cand_hero"], evidenceUnits: [1] },
      ],
      endings: [
        {
          id: "ending_c1",
          targetEventId: "event_c1",
          requirement: "甲留下。",
          evidenceUnits: [1],
        },
      ],
    });
    const gold = createGold({
      characters: [
        { id: "hero", name: "甲", aliases: ["阿甲"] },
        { id: "ally", name: "乙" },
      ],
      events: [
        { id: "g1", characterIds: ["hero"], evidenceUnits: [4] },
        { id: "g2", characterIds: ["ally"], evidenceUnits: [6] },
        { id: "g3", characterIds: ["hero"], evidenceUnits: [8] },
      ],
      endings: [],
    });

    const result = matchM1Gold({ gold, source, storyMap });

    expect(UNIT_WINDOW).toBe(2);
    expect(result.events.matched).toBe(2);
    expect(result.events.matchedPairs).toEqual([
      { candidateId: "event_c1", goldId: "g1" },
      { candidateId: "event_c2", goldId: "g2" },
    ]);
    expect(result.events.unmatchedGoldIds).toEqual(["g3"]);
    expect(result.events.recall).toBeCloseTo(2 / 3);
    expect(result.events.precision).toBeCloseTo(2 / 4);
    expect(result.events.f1).toBeCloseTo(2 * (2 / 3) * (2 / 4) / (2 / 3 + 2 / 4));
  });

  it("requires edge direction to agree and reports hard-link recall", () => {
    const storyMap = createStoryMap({
      characters: [
        { id: "cand_hero", name: "甲" },
        { id: "cand_ally", name: "乙" },
      ],
      events: [
        { id: "event_c1", participants: ["cand_hero"], evidenceUnits: [4] },
        { id: "event_c2", participants: ["cand_ally"], evidenceUnits: [8] },
      ],
      edges: [
        {
          id: "edge_forward",
          from: "event_c1",
          to: "event_c2",
          evidenceUnits: [4],
        },
        {
          id: "edge_reverse",
          from: "event_c2",
          to: "event_c1",
          evidenceUnits: [8],
        },
      ],
      endings: [
        {
          id: "ending_c1",
          targetEventId: "event_c1",
          requirement: "甲留下。",
          evidenceUnits: [1],
        },
      ],
    });
    const gold = createGold({
      characters: [
        { id: "hero", name: "甲" },
        { id: "ally", name: "乙" },
      ],
      events: [
        { id: "g1", characterIds: ["hero"], evidenceUnits: [4] },
        { id: "g2", characterIds: ["ally"], evidenceUnits: [8] },
      ],
      causalLinks: [
        { id: "link_forward", from: "g1", to: "g2", strength: "hard" },
      ],
      endings: [],
    });

    const result = matchM1Gold({ gold, source, storyMap });

    expect(result.edges.matchedPairs).toEqual([
      { candidateId: "edge_forward", goldId: "link_forward" },
    ]);
    expect(result.edges.recall).toBe(1);
    expect(result.edges.precision).toBe(0.5);
    expect(result.edges.hardRecall).toEqual({
      matched: 1,
      total: 1,
      rate: 1,
    });
  });

  it("matches an ending through its target event and reports non-interpretive recall", () => {
    const storyMap = createStoryMap({
      characters: [{ id: "cand_hero", name: "甲" }],
      events: [
        { id: "event_c1", participants: ["cand_hero"], evidenceUnits: [4] },
        { id: "event_c2", participants: ["cand_hero"], evidenceUnits: [8] },
      ],
      endings: [
        {
          id: "ending_scene",
          targetEventId: "event_c2",
          requirement: "甲留下。",
          evidenceUnits: [1],
        },
        {
          id: "ending_other",
          targetEventId: "event_c1",
          requirement: "甲离开。",
          evidenceUnits: [2],
        },
      ],
    });
    const gold = createGold({
      characters: [
        { id: "hero", name: "甲" },
        { id: "ally", name: "乙" },
      ],
      events: [
        { id: "g1", characterIds: ["hero"], evidenceUnits: [4] },
        { id: "g2", characterIds: ["hero"], evidenceUnits: [8] },
      ],
      endings: [
        {
          id: "end_scene",
          characterIds: ["hero"],
          evidenceUnits: [8],
          interpretive: false,
        },
        {
          id: "end_other",
          characterIds: ["ally"],
          evidenceUnits: [2],
          interpretive: true,
        },
      ],
    });

    const result = matchM1Gold({ gold, source, storyMap });

    expect(result.endings.matchedPairs).toEqual([
      { candidateId: "ending_scene", goldId: "end_scene" },
    ]);
    expect(result.endings.recall).toBe(0.5);
    expect(result.endings.precision).toBe(0.5);
    expect(result.endings.nonInterpretiveRecall).toEqual({
      matched: 1,
      total: 1,
      rate: 1,
    });
  });

  it("uses mapped character names in the ending requirement text", () => {
    const storyMap = createStoryMap({
      characters: [
        { id: "cand_hero", name: "甲" },
        { id: "cand_ally", name: "乙" },
      ],
      events: [
        { id: "event_c1", participants: ["cand_hero"], evidenceUnits: [4] },
      ],
      endings: [
        {
          id: "ending_text",
          targetEventId: "event_c1",
          requirement: "乙回来了。",
          evidenceUnits: [2],
        },
      ],
    });
    const gold = createGold({
      characters: [
        { id: "hero", name: "甲" },
        { id: "ally", name: "乙" },
      ],
      events: [{ id: "g1", characterIds: ["hero"], evidenceUnits: [4] }],
      endings: [
        {
          id: "end_text",
          characterIds: ["ally"],
          evidenceUnits: [2],
          interpretive: false,
        },
      ],
    });

    const result = matchM1Gold({ gold, source, storyMap });

    expect(result.endings.matchedPairs).toEqual([
      { candidateId: "ending_text", goldId: "end_text" },
    ]);
  });

  it("excludes mentioned-only candidates from lenient identity precision", () => {
    const storyMap = createStoryMap({
      characters: [
        { id: "cand_hero", name: "阿甲" },
        { id: "cand_ally", name: "乙" },
        { id: "cand_extra", name: "路人丙" },
      ],
      events: [
        { id: "event_c1", participants: ["cand_hero"], evidenceUnits: [4] },
      ],
      endings: [
        {
          id: "ending_c1",
          targetEventId: "event_c1",
          requirement: "甲留下。",
          evidenceUnits: [1],
        },
      ],
    });
    const gold = createGold({
      characters: [
        { id: "hero", name: "甲", aliases: ["阿甲"] },
        { id: "ally", name: "乙" },
      ],
      mentionedOnly: [{ name: "路人丙" }],
      events: [{ id: "g1", characterIds: ["hero"], evidenceUnits: [4] }],
      endings: [],
    });

    const result = matchM1Gold({ gold, source, storyMap });

    expect(result.lenientIdentity.exactMatches).toBe(2);
    expect(result.lenientIdentity.candidateTotal).toBe(2);
    expect(result.lenientIdentity.precision).toBe(1);
    expect(result.lenientIdentity.recall).toBe(1);
    expect(result.lenientIdentity.f1).toBe(1);
    expect(result.lenientIdentity.excludedCandidateIds).toEqual([
      "cand_extra",
    ]);
  });
});
