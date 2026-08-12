import { validateContinuationStatePatch } from "@/domain/invariants/validate-continuation";
import {
  validateImpactPlanReasonPaths,
  validateStoryMap,
} from "@/domain/invariants/validate-story-map";
import { z } from "zod";
import type {
  ImpactPlan,
  Source,
  SourceReference,
  StatePatch,
  StoryMap,
  WorldlineDelta,
} from "@/domain/schemas";
import { sha256 } from "@/domain/source/normalize-source";

const criticalGoldenEventIds = [
  "event_03",
  "event_04",
  "event_06",
  "event_07",
  "event_09",
  "event_10",
  "event_11",
  "event_12",
] as const;
const minimumEvidenceOverlapLength = 12;
const minimumEvidenceCoverage = 0.5;

const RateScoreSchema = z
  .object({
    matched: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    rate: z.number().min(0).max(1),
  })
  .strict();

const StoryMapEvalScoreSchema = z
  .object({
    eventRecall: RateScoreSchema,
    characterRecall: RateScoreSchema,
    evidenceValidity: RateScoreSchema,
    eventIdMap: z.record(z.string(), z.string()),
    missingEventIds: z.array(z.string()),
    criticalMissingEventIds: z.array(z.string()),
    invalidOrHallucinatedEvents: z.array(
      z
        .object({
          eventId: z.string(),
          reasons: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    ),
    unmatchedSourceBackedEventIds: z.array(z.string()),
  })
  .strict();

const ReasonPathContractScoreSchema = z
  .object({
    passed: z.boolean(),
    issues: z.array(z.string().min(1)),
  })
  .strict();

const ImpactPlanEvalScoreSchema = z
  .object({
    divergenceId: z.string().min(1),
    directImpactHitRate: RateScoreSchema,
    missingDirectImpactIds: z.array(z.string()),
    reasonPathContract: ReasonPathContractScoreSchema,
    anchorResult: z
      .object({
        expectedStatuses: z.array(z.string()),
        actualStatuses: z.array(z.string()),
        passed: z.boolean(),
      })
      .strict(),
  })
  .strict();

const ContinuationEvalScoreSchema = z
  .object({
    contradictionDetected: z.boolean(),
    issues: z.array(z.string()),
  })
  .strict();

const ReleaseGateSchema = z
  .object({ passed: z.boolean(), failures: z.array(z.string()) })
  .strict();

const ReportMetadataShape = {
  schemaVersion: z.literal(1),
  fixtureId: z.literal("ripple-001"),
  evaluatedAt: z.iso.datetime(),
  provider: z.string().min(1),
  model: z.string().min(1),
};

const PromptVersionSchema = z
  .object({ kind: z.string().min(1), version: z.string().min(1) })
  .strict();

export const M0LiveEvalFailedStageSchema = z.enum([
  "configuration",
  "setup",
  "story_map",
  "impact_plan",
  "worldline",
  "continuation_directions",
  "continuation_scene",
  "release_gate",
]);

export const M0LiveEvalSuccessReportSchema = z
  .object({
    ...ReportMetadataShape,
    status: z.literal("completed"),
    promptVersions: z.array(PromptVersionSchema),
    storyMap: StoryMapEvalScoreSchema,
    impacts: z.array(ImpactPlanEvalScoreSchema).length(3),
    continuation: ContinuationEvalScoreSchema,
    deterministicScope: z
      .object({
        hallucination:
          z.literal("invalid domain references or missing valid Source Evidence"),
        continuation: z.literal("statePatch against the accepted Worldline Delta"),
      })
      .strict(),
    releaseGate: ReleaseGateSchema,
  })
  .strict();

export const M0LiveEvalFailureReportSchema = z
  .object({
    ...ReportMetadataShape,
    status: z.literal("failed"),
    failedStage: M0LiveEvalFailedStageSchema,
    promptVersions: z.array(PromptVersionSchema),
    partial: z
      .object({
        storyMap: StoryMapEvalScoreSchema.optional(),
        impacts: z.array(ImpactPlanEvalScoreSchema).max(3),
        continuation: ContinuationEvalScoreSchema.optional(),
      })
      .strict(),
    error: z.string().min(1),
  })
  .strict();

export const M0LiveEvalReportSchema = z.discriminatedUnion("status", [
  M0LiveEvalSuccessReportSchema,
  M0LiveEvalFailureReportSchema,
]);

export type M0LiveEvalReport = z.infer<typeof M0LiveEvalReportSchema>;
export type M0LiveEvalFailedStage = z.infer<
  typeof M0LiveEvalFailedStageSchema
>;

export type RateScore = {
  matched: number;
  total: number;
  rate: number;
};

export type StoryMapEvalScore = {
  eventRecall: RateScore;
  characterRecall: RateScore;
  evidenceValidity: RateScore;
  eventIdMap: Record<string, string>;
  missingEventIds: string[];
  criticalMissingEventIds: string[];
  invalidOrHallucinatedEvents: Array<{
    eventId: string;
    reasons: string[];
  }>;
  unmatchedSourceBackedEventIds: string[];
};

export type ImpactPlanEvalScore = {
  divergenceId: string;
  directImpactHitRate: RateScore;
  missingDirectImpactIds: string[];
  reasonPathContract: {
    passed: boolean;
    issues: string[];
  };
  anchorResult: {
    expectedStatuses: string[];
    actualStatuses: string[];
    passed: boolean;
  };
};

export type ContinuationEvalScore = {
  contradictionDetected: boolean;
  issues: string[];
};

export type M0ReleaseGate = {
  passed: boolean;
  failures: string[];
};

export function scoreFixtureStoryMap(input: {
  goldenSource: Source;
  candidateSource: Source;
  golden: StoryMap;
  candidate: StoryMap;
}): StoryMapEvalScore {
  if (input.goldenSource.contentHash !== input.candidateSource.contentHash) {
    throw new Error(
      `无法比较 contentHash 不一致的 Source：Golden=${input.goldenSource.contentHash}，Candidate=${input.candidateSource.contentHash}`,
    );
  }
  const goldenIssues = validateStoryMap(input.golden, input.goldenSource);
  if (goldenIssues.length > 0) {
    throw new Error(
      `Golden Story Map 校验失败：${goldenIssues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("；")}`,
    );
  }
  const domainIssues = validateStoryMap(input.candidate, input.candidateSource);
  const sourceBindingIssue = domainIssues.find(
    (issue) => issue.path === "sourceId",
  );
  if (sourceBindingIssue) {
    throw new Error(
      `Candidate Story Map Source 绑定校验失败：${sourceBindingIssue.message}`,
    );
  }
  const eventIdMap = matchEvents(
    input.golden,
    input.candidate,
    input.goldenSource,
    input.candidateSource,
  );
  const missingEventIds = input.golden.events
    .map((event) => event.id)
    .filter((eventId) => eventIdMap[eventId] === undefined);
  const matchedCharacters = countMatchedCharacters(
    input.golden,
    input.candidate,
  );
  const evidence = collectEvidence(input.candidate);
  const validEvidenceCount = evidence.filter((reference) =>
    isValidEvidence(reference, input.candidateSource),
  ).length;
  const invalidEvents = new Map<string, Set<string>>();

  for (const issue of domainIssues) {
    const match = /^events\.(\d+)/.exec(issue.path);
    if (!match) continue;
    const event = input.candidate.events[Number(match[1])];
    if (!event) continue;
    const reasons = invalidEvents.get(event.id) ?? new Set<string>();
    reasons.add(issue.message);
    invalidEvents.set(event.id, reasons);
  }
  for (const event of input.candidate.events) {
    if (
      event.evidence.length === 0 ||
      !event.evidence.some((reference) =>
        isValidEvidence(reference, input.candidateSource),
      )
    ) {
      const reasons = invalidEvents.get(event.id) ?? new Set<string>();
      reasons.add("事件没有可读取且 Hash 匹配的 Source Evidence");
      invalidEvents.set(event.id, reasons);
    }
  }

  const matchedCandidateIds = new Set(Object.values(eventIdMap));
  const invalidEventIds = new Set(invalidEvents.keys());
  const unmatchedSourceBackedEventIds = input.candidate.events
    .filter(
      (event) =>
        !matchedCandidateIds.has(event.id) && !invalidEventIds.has(event.id),
    )
    .map((event) => event.id);

  return {
    eventRecall: rateScore(
      Object.keys(eventIdMap).length,
      input.golden.events.length,
    ),
    characterRecall: rateScore(
      matchedCharacters,
      input.golden.characters.length,
    ),
    evidenceValidity: rateScore(validEvidenceCount, evidence.length),
    eventIdMap,
    missingEventIds,
    criticalMissingEventIds: criticalGoldenEventIds.filter((eventId) =>
      missingEventIds.includes(eventId),
    ),
    invalidOrHallucinatedEvents: [...invalidEvents.entries()].map(
      ([eventId, reasons]) => ({ eventId, reasons: [...reasons] }),
    ),
    unmatchedSourceBackedEventIds,
  };
}

export function scoreFixtureImpactPlan(input: {
  expected: ImpactPlan;
  candidate: ImpactPlan;
  eventIdMap: Record<string, string>;
  storyMap: StoryMap;
}): ImpactPlanEvalScore {
  const reasonPathIssues = validateImpactPlanReasonPaths(
    input.candidate,
    input.storyMap,
  );
  const invalidImpactIds = new Set(
    reasonPathIssues.flatMap((issue) => {
      const match = /^impacts\.(\d+)\./.exec(issue.path);
      if (!match) return [];
      const impact = input.candidate.impacts[Number(match[1])];
      return impact ? [impact.id] : [];
    }),
  );
  const expectedDirect = input.expected.impacts.filter(
    (impact) => impact.scope === "direct",
  );
  const candidateDirect = input.candidate.impacts.filter(
    (impact) => impact.scope === "direct" && !invalidImpactIds.has(impact.id),
  );
  const usedCandidateIds = new Set<string>();
  const hitExpectedIds = new Set<string>();

  for (const expected of expectedDirect) {
    const expectedAffected = expected.affectedEventId
      ? input.eventIdMap[expected.affectedEventId]
      : null;
    if (expected.affectedEventId && !expectedAffected) continue;
    const match = candidateDirect.find(
      (candidate) =>
        !usedCandidateIds.has(candidate.id) &&
        candidate.changeType === expected.changeType &&
        candidate.affectedEventId === expectedAffected,
    );
    if (!match) continue;
    usedCandidateIds.add(match.id);
    hitExpectedIds.add(expected.id);
  }

  const expectedStatuses = expectedAnchorStatuses(input.expected);
  const actualStatuses = actualAnchorStatuses(
    input.expected,
    input.candidate,
    input.eventIdMap,
  );

  return {
    divergenceId: input.expected.divergence.id,
    directImpactHitRate: rateScore(
      hitExpectedIds.size,
      expectedDirect.length,
    ),
    missingDirectImpactIds: expectedDirect
      .map((impact) => impact.id)
      .filter((id) => !hitExpectedIds.has(id)),
    reasonPathContract: {
      passed: reasonPathIssues.length === 0,
      issues: reasonPathIssues.map(
        (issue) => `${issue.path}: ${issue.message}`,
      ),
    },
    anchorResult: {
      expectedStatuses,
      actualStatuses,
      passed:
        expectedStatuses.length === actualStatuses.length &&
        expectedStatuses.every(
          (status, index) => status === actualStatuses[index],
        ),
    },
  };
}

export function scoreContinuationStatePatch(input: {
  patch: StatePatch;
  currentState: WorldlineDelta;
  storyMap: StoryMap;
  divergenceEventId: string;
  protectedAnchorEventIds: string[];
}): ContinuationEvalScore {
  const issues = validateContinuationStatePatch(
    input.patch,
    input.currentState,
    input.storyMap,
    input.divergenceEventId,
    input.protectedAnchorEventIds,
  ).map((issue) => `${issue.path}: ${issue.message}`);
  return { contradictionDetected: issues.length > 0, issues };
}

export function evaluateM0ReleaseGate(input: {
  storyMapScore: StoryMapEvalScore;
  impactScores: ImpactPlanEvalScore[];
  continuationScore: ContinuationEvalScore;
}): M0ReleaseGate {
  const failures: string[] = [];

  if (input.storyMapScore.characterRecall.rate < 1) {
    failures.push(
      `核心人物召回率低于 100%：${formatPercent(
        input.storyMapScore.characterRecall.rate,
      )}`,
    );
  }
  if (input.storyMapScore.eventRecall.rate < 0.8) {
    failures.push(
      `关键事件召回率低于 80%：${formatPercent(
        input.storyMapScore.eventRecall.rate,
      )}`,
    );
  }
  if (input.storyMapScore.criticalMissingEventIds.length > 0) {
    failures.push(
      `缺少必需关键事件：${input.storyMapScore.criticalMissingEventIds.join(
        ", ",
      )}`,
    );
  }
  if (input.storyMapScore.evidenceValidity.rate < 1) {
    failures.push(
      `Evidence 有效率低于 100%：${formatPercent(
        input.storyMapScore.evidenceValidity.rate,
      )}`,
    );
  }
  if (input.storyMapScore.invalidOrHallucinatedEvents.length > 0) {
    failures.push(
      `存在非法或无有效证据事件：${input.storyMapScore.invalidOrHallucinatedEvents
        .map((event) => event.eventId)
        .join(", ")}`,
    );
  }
  for (const score of input.impactScores) {
    if (!score.reasonPathContract.passed) {
      failures.push(`${score.divergenceId} reasonPath 合同失败`);
    }
    if (score.directImpactHitRate.rate < 1) {
      failures.push(
        `${score.divergenceId} 一级影响命中率低于 100%：${formatPercent(
          score.directImpactHitRate.rate,
        )}`,
      );
    }
    if (!score.anchorResult.passed) {
      failures.push(`${score.divergenceId} Anchor 判断不符合基准`);
    }
  }
  if (input.continuationScore.contradictionDetected) {
    failures.push("Continuation statePatch 恢复或破坏了已确认世界线事实");
  }

  return { passed: failures.length === 0, failures };
}

function matchEvents(
  golden: StoryMap,
  candidate: StoryMap,
  goldenSource: Source,
  candidateSource: Source,
): Record<string, string> {
  const pairs = golden.events.flatMap((goldenEvent) =>
    candidate.events.map((candidateEvent) => ({
      goldenId: goldenEvent.id,
      candidateId: candidateEvent.id,
      similarity: evidenceSimilarity(
        goldenEvent.evidence,
        candidateEvent.evidence,
        goldenSource,
        candidateSource,
      ),
      goldenSequence: goldenEvent.sequence,
      candidateSequence: candidateEvent.sequence,
    })),
  );
  pairs.sort(
    (left, right) =>
      right.similarity - left.similarity ||
      left.goldenSequence - right.goldenSequence ||
      left.candidateSequence - right.candidateSequence,
  );

  const matchedGolden = new Set<string>();
  const matchedCandidate = new Set<string>();
  const result: Record<string, string> = {};
  for (const pair of pairs) {
    if (pair.similarity < 0.5) break;
    if (
      matchedGolden.has(pair.goldenId) ||
      matchedCandidate.has(pair.candidateId)
    ) {
      continue;
    }
    matchedGolden.add(pair.goldenId);
    matchedCandidate.add(pair.candidateId);
    result[pair.goldenId] = pair.candidateId;
  }
  return result;
}

function evidenceSimilarity(
  golden: SourceReference[],
  candidate: SourceReference[],
  goldenSource: Source,
  candidateSource: Source,
): number {
  let best = 0;
  for (const left of golden) {
    if (!isValidEvidence(left, goldenSource)) continue;
    for (const right of candidate) {
      if (!isValidEvidence(right, candidateSource)) continue;
      if (left.sectionId !== right.sectionId) continue;
      const overlap = Math.max(
        0,
        Math.min(left.end, right.end) - Math.max(left.start, right.start),
      );
      if (overlap < minimumEvidenceOverlapLength) continue;
      const goldenCoverage = overlap / (left.end - left.start);
      const candidateCoverage = overlap / (right.end - right.start);
      if (
        goldenCoverage < minimumEvidenceCoverage ||
        candidateCoverage < minimumEvidenceCoverage
      ) {
        continue;
      }
      best = Math.max(best, Math.min(goldenCoverage, candidateCoverage));
    }
  }
  return best;
}

function countMatchedCharacters(golden: StoryMap, candidate: StoryMap): number {
  const unmatchedCandidateIds = new Set(
    candidate.characters.map((character) => character.id),
  );
  let matched = 0;
  for (const expected of golden.characters) {
    const expectedNames = new Set(
      [expected.name, ...expected.aliases].map(normalizeName),
    );
    const found = candidate.characters.find(
      (character) =>
        unmatchedCandidateIds.has(character.id) &&
        [character.name, ...character.aliases]
          .map(normalizeName)
          .some((name) => expectedNames.has(name)),
    );
    if (!found) continue;
    unmatchedCandidateIds.delete(found.id);
    matched += 1;
  }
  return matched;
}

function normalizeName(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, "").toLocaleLowerCase();
}

function collectEvidence(storyMap: StoryMap): SourceReference[] {
  return [
    ...storyMap.events.flatMap((event) => event.evidence),
    ...storyMap.edges.flatMap((edge) => edge.evidence),
    ...storyMap.endingCandidates.flatMap((ending) => ending.evidence),
  ];
}

function isValidEvidence(reference: SourceReference, source: Source): boolean {
  const section = source.sections.find(
    (candidate) => candidate.id === reference.sectionId,
  );
  return (
    reference.sourceId === source.id &&
    Number.isInteger(reference.start) &&
    Number.isInteger(reference.end) &&
    reference.start >= 0 &&
    reference.start < reference.end &&
    reference.end <= source.normalizedText.length &&
    section !== undefined &&
    reference.start >= section.start &&
    reference.end <= section.end &&
    sha256(source.normalizedText.slice(reference.start, reference.end)) ===
      reference.excerptHash
  );
}

function expectedAnchorStatuses(plan: ImpactPlan): string[] {
  return plan.anchors.map((anchor) => {
    const evaluation = plan.anchorEvaluations.find(
      (candidate) => candidate.anchorId === anchor.id,
    );
    return evaluation?.status ?? "missing";
  });
}

function actualAnchorStatuses(
  expected: ImpactPlan,
  candidate: ImpactPlan,
  eventIdMap: Record<string, string>,
): string[] {
  if (expected.anchors.length === 0) {
    return candidate.anchors.length === 0 && candidate.anchorEvaluations.length === 0
      ? []
      : ["unexpected"];
  }
  return expected.anchors.map((expectedAnchor) => {
    const mappedTarget = eventIdMap[expectedAnchor.targetEventId];
    const candidateAnchor = candidate.anchors.find(
      (anchor) => anchor.targetEventId === mappedTarget,
    );
    if (!candidateAnchor) return "missing";
    return (
      candidate.anchorEvaluations.find(
        (evaluation) => evaluation.anchorId === candidateAnchor.id,
      )?.status ?? "missing"
    );
  });
}

function rateScore(matched: number, total: number): RateScore {
  return { matched, total, rate: total === 0 ? 1 : matched / total };
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
