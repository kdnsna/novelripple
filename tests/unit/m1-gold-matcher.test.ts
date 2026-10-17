import { describe, expect, it } from "vitest";

import {
  SourceSchema,
  StoryMapSchema,
  type Source,
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
import {
  STRICT_CONTENT_PRECISION_FLOOR,
  STRICT_CONTENT_RECALL,
  UNIT_WINDOW,
  buildM1ChanceBaselines,
  contentOverlap,
  matchM1Gold,
} from "@/evals/m1-gold-matcher";
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

function createSource(
  originalText: string = SOURCE_TEXT,
  id: string = "source_test",
) {
  const normalizedText = normalizeSourceText(originalText);
  return SourceSchema.parse({
    id,
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

function createStoryMap(
  input: {
    characters: Array<{ id: string; name: string; aliases?: string[] }>;
    events: Array<{
      id: string;
      participants: string[];
      evidenceUnits: number[];
      title?: string;
      summary?: string;
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
  },
  storySource: Source = source,
): StoryMap {
  const storyUnits = deriveEvidenceUnits(storySource);
  const unitReference = (unit: number) =>
    sourceReferenceForUnit(storyUnits[unit - 1]!);
  return StoryMapSchema.parse({
    schemaVersion: 1,
    id: "story_map_test_v1",
    sourceId: storySource.id,
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
      title: event.title ?? `测试事件${index + 1}`,
      summary: event.summary ?? "仅用于测试的虚构事件。",
      sequence: index + 1,
      participants: event.participants,
      stateChanges: [],
      evidenceKind: "fact",
      evidence: event.evidenceUnits.map(unitReference),
    })),
    edges: (input.edges ?? []).map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      type: "causes",
      explanation: "仅用于测试的虚构因果。",
      confidence: 1,
      confirmed: true,
      evidence: edge.evidenceUnits.map(unitReference),
    })),
    endingCandidates: input.endings.map((ending) => ({
      id: ending.id,
      targetEventId: ending.targetEventId,
      requirement: ending.requirement,
      evidence: ending.evidenceUnits.map(unitReference),
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
    label?: string;
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
    label?: string;
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
      label: event.label ?? `测试黄金事件${index + 1}`,
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
      label: ending.label ?? `测试黄金结局${index + 1}`,
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
    // strict 不再接受“目标事件 Unit”作为结局位置依据。
    expect(result.strict.endings.matchedPairs).toEqual([]);
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

  it("gives a dense content-free map low strict event F1 while loose stays higher", () => {
    const gold = createGold({
      characters: [
        { id: "hero", name: "甲" },
        { id: "ally", name: "乙" },
      ],
      events: [
        { id: "g1", characterIds: ["hero", "ally"], evidenceUnits: [1], label: "甲走进钟楼" },
        { id: "g2", characterIds: ["hero", "ally"], evidenceUnits: [3], label: "乙留在门外" },
        { id: "g3", characterIds: ["hero", "ally"], evidenceUnits: [5], label: "甲发现一封信" },
        { id: "g4", characterIds: ["hero", "ally"], evidenceUnits: [7], label: "乙关上灯" },
      ],
      endings: [],
    });
    const storyMap = createStoryMap({
      characters: [
        { id: "cand_hero", name: "甲" },
        { id: "cand_ally", name: "乙" },
      ],
      events: [1, 4, 7].map((unit, index) => ({
        id: `event_dummy_${index + 1}`,
        participants: ["cand_hero", "cand_ally"],
        evidenceUnits: [unit],
        title: `事件 ${index + 1}`,
        summary: "...",
      })),
      endings: [
        {
          id: "ending_dummy",
          targetEventId: "event_dummy_1",
          requirement: "结局。",
          evidenceUnits: [1],
        },
      ],
    });

    const result = matchM1Gold({ gold, source, storyMap });

    expect(result.events.f1).toBeGreaterThan(result.strict.events.f1);
    expect(result.strict.events.f1).toBeLessThanOrEqual(0.1);
    expect(result.chanceBaseline.dense.strict.events.f1).toBeLessThanOrEqual(0.1);
  });

  it("strictly matches a short gold label against a long paraphrase under recall + precision floor", () => {
    const goldLabel = "甲在钟楼发现一封信藏在梁上";
    const paraphrase =
      "甲后来回到钟楼，在钟楼西侧发现一封信藏在梁上，信封已经发黄，字迹也很淡。" +
      "他把信收好，又去问守门人，守门人只说不清楚，只记得很多年前有人来过这里。" +
      "夜里风很大，甲坐在窗边等乙回来，想着信里提到的旧约定到底是什么意思，" +
      "也不知道明天应该把这件事告诉谁。";
    const overlap = contentOverlap(goldLabel, paraphrase, ["甲"]);

    expect(STRICT_CONTENT_RECALL).toBe(0.2);
    expect(STRICT_CONTENT_PRECISION_FLOOR).toBe(0.08);
    expect(overlap.recall).toBeGreaterThanOrEqual(STRICT_CONTENT_RECALL);
    expect(overlap.precision).toBeGreaterThanOrEqual(
      STRICT_CONTENT_PRECISION_FLOOR,
    );

    const gold = createGold({
      characters: [{ id: "hero", name: "甲" }],
      events: [
        {
          id: "g1",
          characterIds: ["hero"],
          evidenceUnits: [3],
          label: goldLabel,
        },
      ],
      endings: [],
    });
    const storyMap = createStoryMap({
      characters: [{ id: "cand_hero", name: "甲" }],
      events: [
        {
          id: "event_discover",
          participants: ["cand_hero"],
          evidenceUnits: [3],
          title: "钟楼旧信",
          summary: paraphrase,
        },
      ],
      endings: [
        {
          id: "ending_dummy",
          targetEventId: "event_discover",
          requirement: "结局。",
          evidenceUnits: [3],
        },
      ],
    });

    const result = matchM1Gold({ gold, source, storyMap });

    expect(result.strict.events.matchedPairs).toEqual([
      { candidateId: "event_discover", goldId: "g1" },
    ]);
    expect(result.strict.events.f1).toBe(1);
  });

  it("rejects a long raw paragraph copied at the right unit on precision", () => {
    const goldLabel = "甲在钟楼发现一封信藏在梁上";
    const longParagraph =
      "甲后来回到钟楼，在钟楼西侧发现一封信藏在梁上。那天傍晚风从海边吹来，" +
      "守门人坐在台阶上修补旧伞，院子里的树叶被吹得四处乱滚。他先去看厨房的炉火，" +
      "又去检查仓库的门锁，回来时天已经全黑，只有走廊尽头还亮着一盏灯。" +
      "他把信放在桌上，想起多年前离开这里的旅人曾经说过，旧信会带来麻烦，" +
      "也会带来答案。窗外的雨越下越大，楼下有人敲门，乙的声音从门缝里传进来，" +
      "说海边出了事，需要他马上过去看看，别再把时间花在这些旧纸上。";
    const longSource = createSource(longParagraph, "source_long_copy");
    const overlap = contentOverlap(goldLabel, longParagraph, ["甲", "乙"]);

    expect(overlap.recall).toBeGreaterThanOrEqual(STRICT_CONTENT_RECALL);
    expect(overlap.precision).toBeLessThan(STRICT_CONTENT_PRECISION_FLOOR);

    const gold = createGold({
      characters: [
        { id: "hero", name: "甲" },
        { id: "ally", name: "乙" },
      ],
      events: [
        {
          id: "g1",
          characterIds: ["hero"],
          evidenceUnits: [1],
          label: goldLabel,
        },
      ],
      endings: [],
    });
    const storyMap = createStoryMap(
      {
        characters: [
          { id: "cand_hero", name: "甲" },
          { id: "cand_ally", name: "乙" },
        ],
        events: [
          {
            id: "event_copy",
            participants: ["cand_hero"],
            evidenceUnits: [1],
            title: "钟楼旧信",
            summary: longParagraph,
          },
        ],
        endings: [
          {
            id: "ending_dummy",
            targetEventId: "event_copy",
            requirement: "结局。",
            evidenceUnits: [1],
          },
        ],
      },
      longSource,
    );

    const result = matchM1Gold({ gold, source: longSource, storyMap });

    expect(result.strict.events.matchedPairs).toEqual([]);
  });

  it("builds count-matched and dense chance baselines with content-free text", () => {
    const gold = createGold({
      characters: [
        { id: "hero", name: "甲" },
        { id: "ally", name: "乙" },
      ],
      events: [
        { id: "g1", characterIds: ["hero", "ally"], evidenceUnits: [1], label: "甲走进钟楼" },
        { id: "g2", characterIds: ["hero", "ally"], evidenceUnits: [3], label: "乙留在门外" },
        { id: "g3", characterIds: ["hero", "ally"], evidenceUnits: [5], label: "甲发现一封信" },
        { id: "g4", characterIds: ["hero", "ally"], evidenceUnits: [7], label: "乙关上灯" },
      ],
      causalLinks: [
        { id: "link_1", from: "g1", to: "g2", strength: "hard" },
        { id: "link_2", from: "g2", to: "g3", strength: "soft" },
      ],
      endings: [
        { id: "end_1", characterIds: ["hero"], evidenceUnits: [7] },
        { id: "end_2", characterIds: ["ally"], evidenceUnits: [8] },
      ],
    });

    const baselines = buildM1ChanceBaselines({ gold, units });

    expect(baselines.matched.events).toHaveLength(4);
    expect(baselines.matched.edges).toHaveLength(2);
    expect(baselines.matched.endingCandidates).toHaveLength(2);
    expect(baselines.dense.events).toHaveLength(Math.ceil(units.length / 3));
    expect(baselines.dense.edges).toHaveLength(0);
    expect(baselines.dense.endingCandidates).toHaveLength(0);
    expect(baselines.matched.events[0]?.participants).toEqual([
      "chance_char_1",
      "chance_char_2",
    ]);

    const result = matchM1Gold({ gold, source, storyMap: baselines.dense });
    expect(result.chanceBaseline.dense.strict.events.f1).toBeLessThanOrEqual(0.1);
    expect(result.chanceBaseline.dense.loose.events.f1)
      .toBeGreaterThanOrEqual(result.chanceBaseline.dense.strict.events.f1);
  });

  it("builds a gold-aligned copy baseline from gold evidence units", () => {
    const gold = createGold({
      characters: [
        { id: "hero", name: "甲" },
        { id: "ally", name: "乙" },
      ],
      events: [
        {
          id: "g1",
          characterIds: ["hero", "ally"],
          evidenceUnits: [3, 1, 3],
          label: "甲在钟楼发现一封信",
        },
        {
          id: "g2",
          characterIds: ["hero"],
          evidenceUnits: [5],
          label: "甲把信交给乙",
        },
      ],
      causalLinks: [
        { id: "link_1", from: "g1", to: "g2", strength: "hard" },
      ],
      endings: [
        {
          id: "end_1",
          characterIds: ["hero"],
          evidenceUnits: [7, 8],
          label: "甲决定离开",
        },
        {
          id: "end_2",
          characterIds: ["ally"],
          evidenceUnits: [6],
          label: "乙读完信",
        },
      ],
    });

    const baselines = buildM1ChanceBaselines({ gold, units });
    const copy = baselines.goldAlignedCopy;
    const firstCopiedText = `${units[2]!.text}${units[0]!.text}`;
    const secondCopiedText = units[4]!.text;

    expect(copy.events).toHaveLength(2);
    expect(copy.events[0]?.evidence).toEqual([reference(3), reference(1)]);
    expect(copy.events[0]?.summary).toBe(firstCopiedText);
    expect(copy.events[0]?.title).toBe(
      [...firstCopiedText].slice(0, 20).join(""),
    );
    expect(copy.events[1]?.summary).toBe(secondCopiedText);
    expect(copy.events[0]?.participants).toEqual([
      "chance_char_1",
      "chance_char_2",
    ]);
    expect(copy.edges).toHaveLength(1);
    expect(copy.endingCandidates).toHaveLength(2);
    expect(copy.endingCandidates[0]?.targetEventId).toBe(
      copy.events.at(-1)?.id,
    );
    expect(copy.endingCandidates[0]?.evidence).toEqual([
      reference(7),
      reference(8),
    ]);
    expect(copy.endingCandidates[0]?.requirement).toBe(
      `${units[6]!.text}${units[7]!.text}`,
    );

    const result = matchM1Gold({ gold, source, storyMap: copy });

    expect(result.strict.events.goldTotal).toBe(2);
    expect(result.strict.events.candidateTotal).toBe(2);
    expect(Number.isFinite(
      result.chanceBaseline.goldAlignedCopy.loose.events.f1,
    )).toBe(true);
    expect(Number.isFinite(
      result.chanceBaseline.goldAlignedCopy.strict.events.f1,
    )).toBe(true);
    expect(Number.isFinite(
      result.chanceBaseline.goldAlignedCopy.strict.endings.f1,
    )).toBe(true);
  });

  it("strictly matches an ending only with exact units and label content", () => {
    const gold = createGold({
      characters: [{ id: "hero", name: "甲" }],
      events: [
        {
          id: "g1",
          characterIds: ["hero"],
          evidenceUnits: [8],
          label: "甲留在钟楼",
        },
      ],
      endings: [
        {
          id: "end_1",
          characterIds: ["hero"],
          evidenceUnits: [8],
          label: "甲留在钟楼里",
        },
      ],
    });
    const storyMap = createStoryMap({
      characters: [{ id: "cand_hero", name: "甲" }],
      events: [
        {
          id: "event_final",
          participants: ["cand_hero"],
          evidenceUnits: [8],
          title: "甲留在钟楼",
          summary: "...",
        },
      ],
      endings: [
        {
          id: "ending_final",
          targetEventId: "event_final",
          requirement: "甲留在钟楼。",
          evidenceUnits: [8],
        },
      ],
    });

    const result = matchM1Gold({ gold, source, storyMap });

    expect(result.strict.endings.matchedPairs).toEqual([
      { candidateId: "ending_final", goldId: "end_1" },
    ]);
  });

  it("computes content overlap from CJK bigrams after masking names and stopwords", () => {
    expect(contentOverlap("阿甲阿乙", "阿甲阿乙", ["阿甲", "阿乙"])).toEqual({
      recall: 0,
      precision: 0,
      f1: 0,
    });
    expect(contentOverlap("他们的了着过", "是在和与也都")).toEqual({
      recall: 0,
      precision: 0,
      f1: 0,
    });
    expect(contentOverlap("他们我们因为所以", "他们我们因为所以")).toEqual({
      recall: 0,
      precision: 0,
      f1: 0,
    });
    expect(contentOverlap("", "钟楼", [])).toEqual({
      recall: 0,
      precision: 0,
      f1: 0,
    });
    expect(contentOverlap("钟楼", "", [])).toEqual({
      recall: 0,
      precision: 0,
      f1: 0,
    });

    const identical = contentOverlap("钟楼里的旧信", "钟楼里的旧信", ["甲"]);
    expect(identical.recall).toBe(1);
    expect(identical.precision).toBe(1);

    const partial = contentOverlap("钟楼旧信", "钟楼里找到旧信");
    expect(partial.recall).toBeCloseTo(2 / 3);
    expect(partial.precision).toBeCloseTo(2 / 6);
    expect(partial.f1).toBeCloseTo(
      (2 * (2 / 3) * (2 / 6)) / (2 / 3 + 2 / 6),
    );
  });

  it("keeps recall while precision drops for a long verbose candidate", () => {
    const goldLabel = "甲在钟楼发现一封信";
    const concise = "甲在钟楼发现信";
    const verbose =
      `${concise}。他在钟楼外面来回走了很久，又问了很多人，` +
      "最后还是没有找到别的线索，只好把这件事记在心里，准备以后再查。";

    const conciseOverlap = contentOverlap(goldLabel, concise, ["甲"]);
    const verboseOverlap = contentOverlap(goldLabel, verbose, ["甲"]);

    expect(conciseOverlap.recall).toBeGreaterThanOrEqual(
      STRICT_CONTENT_RECALL,
    );
    expect(verboseOverlap.recall).toBeGreaterThanOrEqual(
      STRICT_CONTENT_RECALL,
    );
    expect(verboseOverlap.precision).toBeLessThan(conciseOverlap.precision);
  });

  it("keeps stuffing and source-copy strict event/ending F1 at or below 0.1", () => {
    const gold = createGold({
      characters: [
        { id: "hero", name: "甲" },
        { id: "ally", name: "乙" },
      ],
      events: [
        {
          id: "g1",
          characterIds: ["hero"],
          evidenceUnits: [1],
          label: "秘密终于揭开",
        },
        {
          id: "g2",
          characterIds: ["ally"],
          evidenceUnits: [4],
          label: "归途无人知晓",
        },
      ],
      endings: [
        {
          id: "end_1",
          characterIds: ["hero"],
          evidenceUnits: [8],
          label: "灯火熄灭之后",
        },
        {
          id: "end_2",
          characterIds: ["ally"],
          evidenceUnits: [7],
          label: "海面归于平静",
        },
      ],
    });
    const baselines = buildM1ChanceBaselines({ gold, units });

    expect(baselines.stuffing.events).toHaveLength(gold.events.length);
    expect(baselines.stuffing.endingCandidates).toHaveLength(
      gold.endings.length,
    );
    expect(baselines.sourceCopy.events[0]?.summary).toBe(units[0]!.text);
    expect(baselines.sourceCopy.events[0]?.title).toBe(
      [...units[0]!.text].slice(0, 20).join(""),
    );

    for (const name of ["stuffing", "sourceCopy"] as const) {
      const result = matchM1Gold({
        gold,
        source,
        storyMap: baselines[name],
      });
      expect(result.chanceBaseline[name].strict.events.f1)
        .toBeLessThanOrEqual(0.1);
      expect(result.strict.events.matched).toBe(0);
      expect(result.chanceBaseline[name].strict.endings.f1)
        .toBeLessThanOrEqual(0.1);
      expect(result.strict.endings.matched).toBe(0);
    }
  });
});
