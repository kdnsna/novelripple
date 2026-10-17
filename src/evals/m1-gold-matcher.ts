import { z } from "zod";

import type { Source, SourceReference, StoryMap } from "@/domain/schemas";
import { deriveEvidenceUnits } from "@/domain/source/evidence-units";

import type { M1Gold } from "./m1-gold";

/** 事件/结局 Unit 邻近窗口；Gold 匹配只是近似指标，不是放行门禁。 */
export const UNIT_WINDOW = 2;

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

export const M1GoldMatchSchema = z
  .object({
    events: EventMatchSchema,
    edges: EdgeMatchSchema,
    endings: EndingMatchSchema,
    lenientIdentity: LenientIdentitySchema,
  })
  .strict();

export type M1GoldMatch = z.infer<typeof M1GoldMatchSchema>;
export type M1GoldEventMatch = z.infer<typeof EventMatchSchema>;
export type M1GoldEdgeMatch = z.infer<typeof EdgeMatchSchema>;
export type M1GoldEndingMatch = z.infer<typeof EndingMatchSchema>;
export type M1GoldLenientIdentity = z.infer<typeof LenientIdentitySchema>;

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
 */
export function matchM1Gold(input: {
  gold: M1Gold;
  source: Source;
  storyMap: StoryMap;
  /** 人物 identity 评分使用的 gold；缺省时使用 Gold characters。 */
  expectedCharacters?: NamedCharacter[];
}): M1GoldMatch {
  const units = deriveUnits(input.source);
  const { candidateToGold } = mapCandidateCharactersToGold(
    input.storyMap.characters,
    input.gold.characters,
  );

  const events = matchEvents({
    gold: input.gold,
    storyMap: input.storyMap,
    units,
    sourceId: input.source.id,
    candidateToGold,
  });
  const edges = matchEdges({
    gold: input.gold,
    storyMap: input.storyMap,
    candidateEventToGold: events.candidateToGold,
  });
  const endings = matchEndings({
    gold: input.gold,
    storyMap: input.storyMap,
    units,
    sourceId: input.source.id,
    candidateToGold,
  });
  const lenientIdentity = scoreLenientIdentity({
    expectedCharacters: input.expectedCharacters ?? input.gold.characters,
    candidateCharacters: input.storyMap.characters,
    mentionedOnlyNames: input.gold.mentionedOnly.map((item) => item.name),
  });

  return M1GoldMatchSchema.parse({
    events: events.score,
    edges,
    endings,
    lenientIdentity,
  });
}

function deriveUnits(source: Source): UnitBoundary[] {
  return deriveEvidenceUnits(source).map((unit, index) => ({
    unit: index + 1,
    sectionId: unit.sectionId,
    start: unit.start,
    end: unit.end,
  }));
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

function compareScoredPairs(left: ScoredPair, right: ScoredPair): number {
  return (
    right.sharedUnitCount - left.sharedUnitCount ||
    left.distance - right.distance ||
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
): Array<{ candidateId: string; goldId: string }> {
  const assignedCandidateIds = new Set<string>();
  const assignedGoldIds = new Set<string>();
  const result: Array<{ candidateId: string; goldId: string }> = [];

  for (const pair of [...pairs].sort(compareScoredPairs)) {
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
      if (distance > UNIT_WINDOW) continue;
      const characterIds = new Set(gold.characterIds);
      const sharedCharacterCount = intersectionSize(
        candidateGoldCharacters,
        characterIds,
      );
      if (characterIds.size > 0 && sharedCharacterCount === 0) continue;
      pairs.push({
        candidateId: candidate.id,
        goldId: gold.id,
        sharedUnitCount: sharedUnitCount(candidateUnits, goldUnits),
        distance,
        sharedCharacterCount,
      });
    }
  }

  const matchedPairs = assignPairs(pairs);
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
      });
    }
  }

  const matchedPairs = assignPairs(pairs);
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
}): M1GoldEndingMatch {
  const pairs: ScoredPair[] = [];
  const eventsById = new Map(
    input.storyMap.events.map((event) => [event.id, event] as const),
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
      const distance = minimumDistance(candidateUnits, goldUnits);
      if (distance > UNIT_WINDOW) continue;
      const goldCharacterIds = new Set(gold.characterIds);
      const sharedCharacterCount = intersectionSize(
        candidateGoldCharacters,
        goldCharacterIds,
      );
      if (sharedCharacterCount === 0) continue;
      pairs.push({
        candidateId: ending.id,
        goldId: gold.id,
        sharedUnitCount: sharedUnitCount(candidateUnits, goldUnits),
        distance,
        sharedCharacterCount,
      });
    }
  }

  const matchedPairs = assignPairs(pairs);
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

