import { z } from "zod";

import type { Source, SourceReference, StoryMap } from "@/domain/schemas";
import {
  deriveEvidenceUnits,
  sourceReferenceForUnit,
  type EvidenceUnit,
} from "@/domain/source/evidence-units";

import type { M1Gold } from "./m1-gold";

/** 宽松（loose）事件/结局 Unit 邻近窗口；Gold 匹配只是近似指标，不是放行门禁。 */
export const UNIT_WINDOW = 2;
/** 严格（strict）匹配要求候选 Evidence Unit 与 gold Unit 精确相等。 */
export const STRICT_UNIT_WINDOW = 0;
/** 严格匹配的内容信号下限：gold label 的 bigram 至少被候选标题/摘要覆盖 25%。 */
export const STRICT_CONTENT_SCORE = 0.25;
/** dense chance baseline：每 3 个 Unit 放一个内容无关事件。 */
export const DENSE_BASELINE_EVENT_STRIDE = 3;

type NamedCharacter = {
  id: string;
  name: string;
  aliases: string[];
};

const IdPairSchema = z
  .object({
    candidateId: z.string().min(1),
    goldId: z.string().min(1),
  })
  .strict();

const MatchRateSchema = z
  .object({
    matched: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    rate: z.number().min(0).max(1),
  })
  .strict();

const EventMatchSchema = z
  .object({
    goldTotal: z.number().int().nonnegative(),
    candidateTotal: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    recall: z.number().min(0).max(1),
    precision: z.number().min(0).max(1),
    f1: z.number().min(0).max(1),
    matchedPairs: z.array(IdPairSchema),
    unmatchedGoldIds: z.array(z.string().min(1)),
  })
  .strict();

const EdgeMatchSchema = EventMatchSchema.extend({
  hardRecall: MatchRateSchema,
}).strict();

const EndingMatchSchema = EventMatchSchema.extend({
  nonInterpretiveRecall: MatchRateSchema,
}).strict();

const LenientIdentitySchema = z
  .object({
    exactMatches: z.number().int().nonnegative(),
    expectedTotal: z.number().int().nonnegative(),
    candidateTotal: z.number().int().nonnegative(),
    precision: z.number().min(0).max(1),
    recall: z.number().min(0).max(1),
    f1: z.number().min(0).max(1),
    missingExpectedIds: z.array(z.string().min(1)),
    candidateReviewIds: z.array(z.string().min(1)),
    potentialMergeCandidateIds: z.array(z.string().min(1)),
    excludedCandidateIds: z.array(z.string().min(1)),
  })
  .strict();

const MatchMetricsSchema = z
  .object({
    recall: z.number().min(0).max(1),
    precision: z.number().min(0).max(1),
    f1: z.number().min(0).max(1),
  })
  .strict();

const ChanceMatchSchema = z
  .object({
    events: MatchMetricsSchema,
    edges: MatchMetricsSchema,
    endings: MatchMetricsSchema,
  })
  .strict();

const StrictGoldMatchSchema = z
  .object({
    events: EventMatchSchema,
    edges: EdgeMatchSchema,
    endings: EndingMatchSchema,
  })
  .strict();

const ChanceBaselineSchema = z
  .object({
    matched: z
      .object({ loose: ChanceMatchSchema, strict: ChanceMatchSchema })
      .strict(),
    dense: z
      .object({ loose: ChanceMatchSchema, strict: ChanceMatchSchema })
      .strict(),
  })
  .strict();

export const M1GoldMatchSchema = z
  .object({
    /** 向后兼容：顶层字段始终是 loose 匹配。 */
    events: EventMatchSchema,
    edges: EdgeMatchSchema,
    endings: EndingMatchSchema,
    strict: StrictGoldMatchSchema,
    chanceBaseline: ChanceBaselineSchema,
    lenientIdentity: LenientIdentitySchema,
  })
  .strict();

export type M1GoldMatch = z.infer<typeof M1GoldMatchSchema>;
export type M1GoldEventMatch = z.infer<typeof EventMatchSchema>;
export type M1GoldEdgeMatch = z.infer<typeof EdgeMatchSchema>;
export type M1GoldEndingMatch = z.infer<typeof EndingMatchSchema>;
export type M1GoldLenientIdentity = z.infer<typeof LenientIdentitySchema>;
export type M1GoldStrictMatch = z.infer<typeof StrictGoldMatchSchema>;
export type M1GoldChanceMatch = z.infer<typeof ChanceMatchSchema>;
export type M1GoldChanceBaseline = z.infer<typeof ChanceBaselineSchema>;

/** 匹配策略参数：loose 只看 Unit 邻近，strict 额外要求精确 Unit 与内容重合。 */
type MatchStrategy = {
  unitWindow: number;
  minimumContentScore: number | null;
  assignmentOrder: "loose" | "strict";
};

const LOOSE_STRATEGY: MatchStrategy = {
  unitWindow: UNIT_WINDOW,
  minimumContentScore: null,
  assignmentOrder: "loose",
};

const STRICT_STRATEGY: MatchStrategy = {
  unitWindow: STRICT_UNIT_WINDOW,
  minimumContentScore: STRICT_CONTENT_SCORE,
  assignmentOrder: "strict",
};

export type M1GoldMatchOptions = {
  /** 宽松匹配 Unit 窗口，默认 `UNIT_WINDOW`。 */
  looseUnitWindow?: number;
  /** 严格匹配 Unit 窗口，默认 `STRICT_UNIT_WINDOW`（0）。 */
  strictUnitWindow?: number;
  /** 严格匹配内容重合下限，默认 `STRICT_CONTENT_SCORE`。 */
  strictMinimumContentScore?: number;
};

type UnitBoundary = {
  unit: number;
  sectionId: string;
  start: number;
  end: number;
};

type ScoredPair = {
  candidateId: string;
  goldId: string;
  sharedUnitCount: number;
  distance: number;
  sharedCharacterCount: number;
  contentScore: number;
};

export function normalizedCharacterNames(value: {
  name: string;
  aliases: string[];
}): string[] {
  return [value.name, ...value.aliases].map(normalizeText);
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, "").toLocaleLowerCase();
}

export function mapCandidateCharactersToGold(
  candidateCharacters: NamedCharacter[],
  goldCharacters: NamedCharacter[],
): {
  candidateToGold: Map<string, string>;
  goldToCandidate: Map<string, string>;
} {
  const candidateToGold = new Map<string, string>();
  const goldToCandidate = new Map<string, string>();
  const matchedCandidateIds = new Set<string>();

  for (const gold of goldCharacters) {
    const goldNames = normalizedCharacterNames(gold);
    const candidate = candidateCharacters.find(
      (item) =>
        !matchedCandidateIds.has(item.id) &&
        normalizedCharacterNames(item).some((name) => goldNames.includes(name)),
    );
    if (!candidate) continue;
    matchedCandidateIds.add(candidate.id);
    candidateToGold.set(candidate.id, gold.id);
    goldToCandidate.set(gold.id, candidate.id);
  }

  return { candidateToGold, goldToCandidate };
}

/**
 * 纯 Gold 匹配器。仅接收已校验的 Gold / Source / Story Map，返回 ID、计数与比例，
 * 不复制任何 Gold 文本。自动匹配是近似指标，不得作为放行门禁。
 *
 * 顶层 events / edges / endings 保持旧行为（loose）；`strict` 使用精确 Unit 与
 * 内容 bigram 下限，`chanceBaseline` 用内容无关地图给出机会水平。
 */
export function matchM1Gold(input: {
  gold: M1Gold;
  source: Source;
  storyMap: StoryMap;
  /** 人物 identity 评分使用的 gold；缺省时使用 Gold characters。 */
  expectedCharacters?: NamedCharacter[];
  options?: M1GoldMatchOptions;
}): M1GoldMatch {
  const evidenceUnits = deriveEvidenceUnits(input.source);
  const units = toUnitBoundaries(evidenceUnits);
  const looseStrategy = resolveStrategy(LOOSE_STRATEGY, input.options);
  const strictStrategy = resolveStrategy(STRICT_STRATEGY, input.options);

  const loose = evaluateGoldMatch({
    gold: input.gold,
    storyMap: input.storyMap,
    units,
    sourceId: input.source.id,
    strategy: looseStrategy,
  });
  const strict = evaluateGoldMatch({
    gold: input.gold,
    storyMap: input.storyMap,
    units,
    sourceId: input.source.id,
    strategy: strictStrategy,
  });
  const chanceMaps = buildM1ChanceBaselines({
    gold: input.gold,
    units: evidenceUnits,
  });
  const chanceBaseline = {
    matched: {
      loose: compactChanceMatch(
        evaluateGoldMatch({
          gold: input.gold,
          storyMap: chanceMaps.matched,
          units,
          sourceId: input.source.id,
          strategy: looseStrategy,
        }),
      ),
      strict: compactChanceMatch(
        evaluateGoldMatch({
          gold: input.gold,
          storyMap: chanceMaps.matched,
          units,
          sourceId: input.source.id,
          strategy: strictStrategy,
        }),
      ),
    },
    dense: {
      loose: compactChanceMatch(
        evaluateGoldMatch({
          gold: input.gold,
          storyMap: chanceMaps.dense,
          units,
          sourceId: input.source.id,
          strategy: looseStrategy,
        }),
      ),
      strict: compactChanceMatch(
        evaluateGoldMatch({
          gold: input.gold,
          storyMap: chanceMaps.dense,
          units,
          sourceId: input.source.id,
          strategy: strictStrategy,
        }),
      ),
    },
  };
  const lenientIdentity = scoreLenientIdentity({
    expectedCharacters: input.expectedCharacters ?? input.gold.characters,
    candidateCharacters: input.storyMap.characters,
    mentionedOnlyNames: input.gold.mentionedOnly.map((item) => item.name),
  });

  return M1GoldMatchSchema.parse({
    events: loose.events,
    edges: loose.edges,
    endings: loose.endings,
    strict,
    chanceBaseline,
    lenientIdentity,
  });
}

function resolveStrategy(
  base: MatchStrategy,
  options: M1GoldMatchOptions | undefined,
): MatchStrategy {
  if (!options) return base;
  return {
    ...base,
    unitWindow:
      base.assignmentOrder === "strict"
        ? (options.strictUnitWindow ?? base.unitWindow)
        : (options.looseUnitWindow ?? base.unitWindow),
    minimumContentScore:
      base.assignmentOrder === "strict"
        ? (options.strictMinimumContentScore ?? base.minimumContentScore)
        : base.minimumContentScore,
  };
}

function evaluateGoldMatch(input: {
  gold: M1Gold;
  storyMap: StoryMap;
  units: UnitBoundary[];
  sourceId: string;
  strategy: MatchStrategy;
}): {
  events: M1GoldEventMatch;
  edges: M1GoldEdgeMatch;
  endings: M1GoldEndingMatch;
} {
  const { candidateToGold } = mapCandidateCharactersToGold(
    input.storyMap.characters,
    input.gold.characters,
  );
  const events = matchEvents({
    gold: input.gold,
    storyMap: input.storyMap,
    units: input.units,
    sourceId: input.sourceId,
    candidateToGold,
    strategy: input.strategy,
  });
  const edges = matchEdges({
    gold: input.gold,
    storyMap: input.storyMap,
    candidateEventToGold: events.candidateToGold,
    strategy: input.strategy,
  });
  const endings = matchEndings({
    gold: input.gold,
    storyMap: input.storyMap,
    units: input.units,
    sourceId: input.sourceId,
    candidateToGold,
    candidateEventToGold: events.candidateToGold,
    strategy: input.strategy,
  });
  return { events: events.score, edges, endings };
}

function compactChanceMatch(value: {
  events: M1GoldEventMatch;
  edges: M1GoldEdgeMatch;
  endings: M1GoldEndingMatch;
}): M1GoldChanceMatch {
  return {
    events: pickMetrics(value.events),
    edges: pickMetrics(value.edges),
    endings: pickMetrics(value.endings),
  };
}

function pickMetrics(value: { recall: number; precision: number; f1: number }) {
  return { recall: value.recall, precision: value.precision, f1: value.f1 };
}

function toUnitBoundaries(units: readonly EvidenceUnit[]): UnitBoundary[] {
  return units.map((unit, index) => ({
    unit: index + 1,
    sectionId: unit.sectionId,
    start: unit.start,
    end: unit.end,
  }));
}

/**
 * 内容信号：去掉空白、标点和符号后做字符 bigram（CJK 按字符，ASCII 先小写），
 * 返回 gold bigram 被候选文本覆盖的比例。
 */
export function contentBigramScore(
  goldText: string,
  candidateText: string,
): number {
  const goldBigrams = contentBigrams(goldText);
  if (goldBigrams.size === 0) return 0;
  return (
    intersectionSize(goldBigrams, contentBigrams(candidateText)) /
    goldBigrams.size
  );
}

function contentBigrams(value: string): Set<string> {
  const text = value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  const chars = [...text];
  const result = new Set<string>();
  for (let index = 0; index + 1 < chars.length; index += 1) {
    result.add(`${chars[index]}${chars[index + 1]}`);
  }
  return result;
}

/**
 * 内容无关的机会基线（不调用模型）：
 * - matched：事件数量与 gold 相同、Unit 在全篇均匀铺开，边按 gold 数量上限串联，
 *   结局数量与 gold 相同并落在最后 20% 的 Unit；
 * - dense：每 3 个 Unit 一个空事件。
 * 两者都使用全部 gold 人物作为参与者，标题为“事件 n”，摘要/结局要求不含内容。
 */
export function buildM1ChanceBaselines(input: {
  gold: M1Gold;
  units: readonly EvidenceUnit[];
}): { matched: StoryMap; dense: StoryMap } {
  return {
    matched: buildMatchedChanceBaseline(input.gold, input.units),
    dense: buildDenseChanceBaseline(input.gold, input.units),
  };
}

function buildMatchedChanceBaseline(
  gold: M1Gold,
  units: readonly EvidenceUnit[],
): StoryMap {
  const characters = chanceCharacters(gold);
  const participants = characters.map((character) => character.id);
  const eventCount =
    units.length > 0 && participants.length > 0 ? gold.events.length : 0;
  const events = Array.from({ length: eventCount }, (_, index) =>
    chanceEvent(index, evenlySpacedUnit(units, index, eventCount), participants),
  );
  const edgeCount = Math.min(
    gold.causalLinks.length,
    Math.max(0, eventCount - 1),
  );
  const edges = Array.from({ length: edgeCount }, (_, index) => ({
    id: `chance_edge_${index + 1}`,
    from: events[index]!.id,
    to: events[index + 1]!.id,
    type: "causes" as const,
    explanation: "机会基线",
    confidence: 1,
    confirmed: true,
    evidence: [
      sourceReferenceForUnit(evenlySpacedUnit(units, index, eventCount)),
    ],
  }));
  const endingCount = events.length > 0 ? gold.endings.length : 0;
  const endingUnits = lastTwentyPercentUnits(units);
  const endingCandidates = Array.from({ length: endingCount }, (_, index) => {
    const eventIndex = Math.max(
      0,
      Math.min(events.length - 1, events.length - endingCount + index),
    );
    const unit =
      endingUnits[
        Math.round(
          (index * Math.max(0, endingUnits.length - 1)) /
            Math.max(1, endingCount - 1),
        )
      ] ?? units.at(-1)!;
    return {
      id: `chance_ending_${index + 1}`,
      targetEventId: events[eventIndex]!.id,
      requirement: "...",
      evidence: [sourceReferenceForUnit(unit)],
    };
  });

  return chanceStoryMap({
    id: "chance_matched",
    sourceId: units[0]?.sourceId ?? "chance_source",
    characters,
    events,
    edges,
    endingCandidates,
  });
}

function buildDenseChanceBaseline(
  gold: M1Gold,
  units: readonly EvidenceUnit[],
): StoryMap {
  const characters = chanceCharacters(gold);
  const participants = characters.map((character) => character.id);
  const eventCount =
    participants.length > 0
      ? Math.ceil(units.length / DENSE_BASELINE_EVENT_STRIDE)
      : 0;
  const events = Array.from({ length: eventCount }, (_, index) =>
    chanceEvent(
      index,
      units[index * DENSE_BASELINE_EVENT_STRIDE]!,
      participants,
    ),
  );
  return chanceStoryMap({
    id: "chance_dense",
    sourceId: units[0]?.sourceId ?? "chance_source",
    characters,
    events,
    edges: [],
    endingCandidates: [],
  });
}

function chanceCharacters(gold: M1Gold): StoryMap["characters"] {
  return gold.characters.map((character, index) => ({
    id: `chance_char_${index + 1}`,
    name: character.name,
    aliases: [...character.aliases],
    role: "supporting",
    initialState: "机会基线占位状态",
  }));
}

function chanceEvent(
  index: number,
  unit: EvidenceUnit,
  participants: string[],
): StoryMap["events"][number] {
  return {
    id: `chance_event_${index + 1}`,
    title: `事件 ${index + 1}`,
    summary: "...",
    sequence: index + 1,
    participants,
    stateChanges: [],
    evidenceKind: "fact",
    evidence: [sourceReferenceForUnit(unit)],
  };
}

function chanceStoryMap(input: {
  id: string;
  sourceId: string;
  characters: StoryMap["characters"];
  events: StoryMap["events"];
  edges: StoryMap["edges"];
  endingCandidates: StoryMap["endingCandidates"];
}): StoryMap {
  return {
    schemaVersion: 1,
    id: input.id,
    sourceId: input.sourceId,
    version: 1,
    status: "draft",
    title: "机会基线",
    logline: "内容无关的机会基线地图",
    characters: input.characters,
    events: input.events,
    edges: input.edges,
    endingCandidates: input.endingCandidates,
  };
}

function evenlySpacedUnit(
  units: readonly EvidenceUnit[],
  index: number,
  count: number,
): EvidenceUnit {
  if (count <= 1) return units[0]!;
  return units[Math.round((index * (units.length - 1)) / (count - 1))]!;
}

function lastTwentyPercentUnits(
  units: readonly EvidenceUnit[],
): readonly EvidenceUnit[] {
  return units.slice(Math.floor(units.length * 0.8));
}

function referenceUnitIndices(
  reference: SourceReference,
  units: UnitBoundary[],
  sourceId: string,
): number[] {
  if (reference.sourceId !== sourceId || reference.start >= reference.end) {
    return [];
  }
  return units
    .filter(
      (unit) =>
        unit.sectionId === reference.sectionId &&
        reference.start < unit.end &&
        unit.start < reference.end,
    )
    .map((unit) => unit.unit);
}

function referenceUnits(
  references: SourceReference[],
  units: UnitBoundary[],
  sourceId: string,
): Set<number> {
  const result = new Set<number>();
  for (const reference of references) {
    for (const unit of referenceUnitIndices(reference, units, sourceId)) {
      result.add(unit);
    }
  }
  return result;
}

function goldEventUnits(event: { evidence: Array<{ unit: number }> }): Set<number> {
  return new Set(event.evidence.map((item) => item.unit));
}

function minimumDistance(left: Set<number>, right: Set<number>): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const leftUnit of left) {
    for (const rightUnit of right) {
      minimum = Math.min(minimum, Math.abs(leftUnit - rightUnit));
    }
  }
  return minimum;
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let size = 0;
  for (const value of left) {
    if (right.has(value)) size += 1;
  }
  return size;
}

function sharedUnitCount(left: Set<number>, right: Set<number>): number {
  let size = 0;
  for (const value of left) {
    if (right.has(value)) size += 1;
  }
  return size;
}

function compareLoosePairs(left: ScoredPair, right: ScoredPair): number {
  return (
    right.sharedUnitCount - left.sharedUnitCount ||
    left.distance - right.distance ||
    right.sharedCharacterCount - left.sharedCharacterCount ||
    compareIds(left.candidateId, right.candidateId) ||
    compareIds(left.goldId, right.goldId)
  );
}

/** 严格匹配按内容重合优先、Unit 距离其次做一对一贪心。 */
function compareStrictPairs(left: ScoredPair, right: ScoredPair): number {
  return (
    right.contentScore - left.contentScore ||
    left.distance - right.distance ||
    right.sharedUnitCount - left.sharedUnitCount ||
    right.sharedCharacterCount - left.sharedCharacterCount ||
    compareIds(left.candidateId, right.candidateId) ||
    compareIds(left.goldId, right.goldId)
  );
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assignPairs<T extends ScoredPair>(
  pairs: T[],
  strategy: MatchStrategy,
): Array<{ candidateId: string; goldId: string }> {
  const assignedCandidateIds = new Set<string>();
  const assignedGoldIds = new Set<string>();
  const result: Array<{ candidateId: string; goldId: string }> = [];
  const compare =
    strategy.assignmentOrder === "strict"
      ? compareStrictPairs
      : compareLoosePairs;

  for (const pair of [...pairs].sort(compare)) {
    if (
      assignedCandidateIds.has(pair.candidateId) ||
      assignedGoldIds.has(pair.goldId)
    ) {
      continue;
    }
    assignedCandidateIds.add(pair.candidateId);
    assignedGoldIds.add(pair.goldId);
    result.push({ candidateId: pair.candidateId, goldId: pair.goldId });
  }

  return result.sort(
    (left, right) =>
      compareIds(left.candidateId, right.candidateId) ||
      compareIds(left.goldId, right.goldId),
  );
}

function matchEvents(input: {
  gold: M1Gold;
  storyMap: StoryMap;
  units: UnitBoundary[];
  sourceId: string;
  candidateToGold: Map<string, string>;
  strategy: MatchStrategy;
}): {
  score: M1GoldEventMatch;
  candidateToGold: Map<string, string>;
} {
  const pairs: ScoredPair[] = [];

  for (const candidate of input.storyMap.events) {
    const candidateUnits = referenceUnits(
      candidate.evidence,
      input.units,
      input.sourceId,
    );
    if (candidateUnits.size === 0) continue;
    const candidateGoldCharacters = new Set(
      candidate.participants
        .map((participant) => input.candidateToGold.get(participant))
        .filter((characterId): characterId is string => characterId !== undefined),
    );

    for (const gold of input.gold.events) {
      const goldUnits = goldEventUnits(gold);
      if (goldUnits.size === 0) continue;
      const distance = minimumDistance(candidateUnits, goldUnits);
      if (distance > input.strategy.unitWindow) continue;
      const characterIds = new Set(gold.characterIds);
      const sharedCharacterCount = intersectionSize(
        candidateGoldCharacters,
        characterIds,
      );
      if (characterIds.size > 0 && sharedCharacterCount === 0) continue;
      const contentScore =
        input.strategy.minimumContentScore === null
          ? 0
          : contentBigramScore(
              gold.label,
              `${candidate.title} ${candidate.summary}`,
            );
      if (
        input.strategy.minimumContentScore !== null &&
        contentScore < input.strategy.minimumContentScore
      ) {
        continue;
      }
      pairs.push({
        candidateId: candidate.id,
        goldId: gold.id,
        sharedUnitCount: sharedUnitCount(candidateUnits, goldUnits),
        distance,
        sharedCharacterCount,
        contentScore,
      });
    }
  }

  const matchedPairs = assignPairs(pairs, input.strategy);
  const candidateToGold = new Map(
    matchedPairs.map((pair) => [pair.candidateId, pair.goldId] as const),
  );
  const matchedGoldIds = new Set(matchedPairs.map((pair) => pair.goldId));
  const score = buildMatchScore(
    matchedPairs,
    input.gold.events.map((event) => event.id),
    input.storyMap.events.length,
    new Set(matchedGoldIds),
  );

  return { score, candidateToGold };
}

function matchEdges(input: {
  gold: M1Gold;
  storyMap: StoryMap;
  candidateEventToGold: Map<string, string>;
  strategy: MatchStrategy;
}): M1GoldEdgeMatch {
  const pairs: ScoredPair[] = [];

  for (const edge of input.storyMap.edges) {
    const from = input.candidateEventToGold.get(edge.from);
    const to = input.candidateEventToGold.get(edge.to);
    if (!from || !to) continue;
    for (const link of input.gold.causalLinks) {
      if (link.from !== from || link.to !== to) continue;
      pairs.push({
        candidateId: edge.id,
        goldId: link.id,
        sharedUnitCount: 0,
        distance: 0,
        sharedCharacterCount: 0,
        contentScore: 0,
      });
    }
  }

  const matchedPairs = assignPairs(pairs, input.strategy);
  const matchedGoldIds = new Set(matchedPairs.map((pair) => pair.goldId));
  const goldIds = input.gold.causalLinks.map((link) => link.id);
  const score = buildMatchScore(
    matchedPairs,
    goldIds,
    input.storyMap.edges.length,
    matchedGoldIds,
  );
  const hardGoldIds = new Set(
    input.gold.causalLinks
      .filter((link) => link.strength === "hard")
      .map((link) => link.id),
  );
  const hardMatched = [...matchedGoldIds].filter((id) =>
    hardGoldIds.has(id),
  ).length;

  return {
    ...score,
    hardRecall: rateScore(hardMatched, hardGoldIds.size),
  };
}

function matchEndings(input: {
  gold: M1Gold;
  storyMap: StoryMap;
  units: UnitBoundary[];
  sourceId: string;
  candidateToGold: Map<string, string>;
  candidateEventToGold: Map<string, string>;
  strategy: MatchStrategy;
}): M1GoldEndingMatch {
  const pairs: ScoredPair[] = [];
  const eventsById = new Map(
    input.storyMap.events.map((event) => [event.id, event] as const),
  );
  const goldEventsById = new Map(
    input.gold.events.map((event) => [event.id, event] as const),
  );

  for (const ending of input.storyMap.endingCandidates) {
    const targetEvent = eventsById.get(ending.targetEventId);
    const candidateUnits = referenceUnits(
      ending.evidence,
      input.units,
      input.sourceId,
    );
    if (targetEvent) {
      for (const unit of referenceUnits(
        targetEvent.evidence,
        input.units,
        input.sourceId,
      )) {
        candidateUnits.add(unit);
      }
    }
    if (candidateUnits.size === 0) continue;

    const candidateGoldCharacters = new Set<string>();
    for (const participant of targetEvent?.participants ?? []) {
      const characterId = input.candidateToGold.get(participant);
      if (characterId) candidateGoldCharacters.add(characterId);
    }
    const requirement = normalizeText(ending.requirement);
    for (const candidateCharacter of input.storyMap.characters) {
      const goldId = input.candidateToGold.get(candidateCharacter.id);
      if (!goldId) continue;
      const goldCharacter = input.gold.characters.find(
        (item) => item.id === goldId,
      );
      const names = new Set([
        ...normalizedCharacterNames(candidateCharacter),
        ...(goldCharacter ? normalizedCharacterNames(goldCharacter) : []),
      ]);
      if ([...names].some((name) => name.length > 0 && requirement.includes(name))) {
        candidateGoldCharacters.add(goldId);
      }
    }

    for (const gold of input.gold.endings) {
      const goldUnits = new Set(gold.evidence.map((item) => item.unit));
      if (goldUnits.size === 0) continue;
      let distance = minimumDistance(candidateUnits, goldUnits);
      // strict 还接受“目标事件已严格匹配到的 gold 事件 Unit”作为位置依据。
      if (input.strategy.minimumContentScore !== null) {
        const targetGoldId = input.candidateEventToGold.get(
          ending.targetEventId,
        );
        const targetGoldEvent = targetGoldId
          ? goldEventsById.get(targetGoldId)
          : undefined;
        if (targetGoldEvent) {
          distance = Math.min(
            distance,
            minimumDistance(candidateUnits, goldEventUnits(targetGoldEvent)),
          );
        }
      }
      if (distance > input.strategy.unitWindow) continue;
      const goldCharacterIds = new Set(gold.characterIds);
      const sharedCharacterCount = intersectionSize(
        candidateGoldCharacters,
        goldCharacterIds,
      );
      if (sharedCharacterCount === 0) continue;
      const contentScore =
        input.strategy.minimumContentScore === null
          ? 0
          : contentBigramScore(gold.label, ending.requirement);
      if (
        input.strategy.minimumContentScore !== null &&
        contentScore < input.strategy.minimumContentScore
      ) {
        continue;
      }
      pairs.push({
        candidateId: ending.id,
        goldId: gold.id,
        sharedUnitCount: sharedUnitCount(candidateUnits, goldUnits),
        distance,
        sharedCharacterCount,
        contentScore,
      });
    }
  }

  const matchedPairs = assignPairs(pairs, input.strategy);
  const matchedGoldIds = new Set(matchedPairs.map((pair) => pair.goldId));
  const score = buildMatchScore(
    matchedPairs,
    input.gold.endings.map((ending) => ending.id),
    input.storyMap.endingCandidates.length,
    matchedGoldIds,
  );
  const nonInterpretiveGoldIds = new Set(
    input.gold.endings
      .filter((ending) => !ending.interpretive)
      .map((ending) => ending.id),
  );
  const nonInterpretiveMatched = [...matchedGoldIds].filter((id) =>
    nonInterpretiveGoldIds.has(id),
  ).length;

  return {
    ...score,
    nonInterpretiveRecall: rateScore(
      nonInterpretiveMatched,
      nonInterpretiveGoldIds.size,
    ),
  };
}

function buildMatchScore(
  matchedPairs: Array<{ candidateId: string; goldId: string }>,
  goldIds: string[],
  candidateTotal: number,
  matchedGoldIds: Set<string>,
): {
  goldTotal: number;
  candidateTotal: number;
  matched: number;
  recall: number;
  precision: number;
  f1: number;
  matchedPairs: Array<{ candidateId: string; goldId: string }>;
  unmatchedGoldIds: string[];
} {
  const matched = matchedPairs.length;
  const recall = divide(matched, goldIds.length);
  const precision = divide(matched, candidateTotal);
  return {
    goldTotal: goldIds.length,
    candidateTotal,
    matched,
    recall,
    precision,
    f1: f1Score(precision, recall),
    matchedPairs,
    unmatchedGoldIds: goldIds.filter((id) => !matchedGoldIds.has(id)),
  };
}

function scoreLenientIdentity(input: {
  expectedCharacters: NamedCharacter[];
  candidateCharacters: NamedCharacter[];
  mentionedOnlyNames: string[];
}): M1GoldLenientIdentity {
  const matchedExpectedIds = new Set<string>();
  const matchedCandidateIds = new Set<string>();

  for (const expected of input.expectedCharacters) {
    const expectedNames = normalizedCharacterNames(expected);
    const candidate = input.candidateCharacters.find(
      (item) =>
        !matchedCandidateIds.has(item.id) &&
        normalizedCharacterNames(item).some((name) =>
          expectedNames.includes(name),
        ),
    );
    if (!candidate) continue;
    matchedExpectedIds.add(expected.id);
    matchedCandidateIds.add(candidate.id);
  }

  const mentionedOnlyNames = new Set(
    input.mentionedOnlyNames.map(normalizeText),
  );
  const mentionedOnlyCandidateIds = input.candidateCharacters
    .filter((candidate) =>
      normalizedCharacterNames(candidate).some((name) =>
        mentionedOnlyNames.has(name),
      ),
    )
    .map((candidate) => candidate.id);
  const excludedCandidateIds = mentionedOnlyCandidateIds.filter(
    (id) => !matchedCandidateIds.has(id),
  );
  const candidateTotal =
    input.candidateCharacters.length - excludedCandidateIds.length;
  const exactMatches = matchedExpectedIds.size;
  const precision = divide(exactMatches, candidateTotal);
  const recall = divide(exactMatches, input.expectedCharacters.length);

  return {
    exactMatches,
    expectedTotal: input.expectedCharacters.length,
    candidateTotal,
    precision,
    recall,
    f1: f1Score(precision, recall),
    missingExpectedIds: input.expectedCharacters
      .filter((item) => !matchedExpectedIds.has(item.id))
      .map((item) => item.id),
    candidateReviewIds: input.candidateCharacters
      .filter((item) => !matchedCandidateIds.has(item.id))
      .map((item) => item.id),
    potentialMergeCandidateIds: input.candidateCharacters
      .filter((candidate) => {
        const candidateNames = normalizedCharacterNames(candidate);
        return (
          input.expectedCharacters.filter((expected) =>
            normalizedCharacterNames(expected).some((name) =>
              candidateNames.includes(name),
            ),
          ).length > 1
        );
      })
      .map((item) => item.id),
    excludedCandidateIds,
  };
}

function rateScore(matched: number, total: number) {
  return { matched, total, rate: divide(matched, total) };
}

function divide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function f1Score(precision: number, recall: number): number {
  return precision + recall === 0
    ? 0
    : (2 * precision * recall) / (precision + recall);
}

