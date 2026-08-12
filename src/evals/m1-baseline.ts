import { z } from "zod";

import type {
  Source,
  SourceReference,
  StoryMap,
} from "@/domain/schemas";
import {
  normalizeSourceText,
  sha256,
} from "@/domain/source/normalize-source";
import type { AnalysisSegment } from "@/domain/source/analysis-segments";
import type {
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
} from "@/server/ai/types";

type BenchmarkCharacter = {
  id: string;
  name: string;
  aliases: string[];
};

type BenchmarkLabeledItem = {
  id: string;
  label: string;
};

type BenchmarkEnding = BenchmarkLabeledItem & {
  interpretive: boolean;
};

type BenchmarkDivergence = {
  id: string;
  eventId: string;
  type: "prevent" | "choice" | "outcome";
  mode: "strict" | "open";
  instruction: string;
  anchorIds: string[];
  expectedAnchorStatus:
    | "preserved"
    | "rerouted"
    | "threatened"
    | "incompatible"
    | null;
};

export type M1BenchmarkManifest = {
  schemaVersion: 1;
  id: string;
  title: string;
  rights: {
    category: "original" | "public-domain" | "licensed-public" | "private";
    basis: string;
    redistributionAllowed: boolean;
    license?: string;
    sourceUrl?: string;
  };
  visibility: "public" | "private";
  sourcePath: string;
  language: "zh-CN";
  characterCount: number;
  storyClass: "A" | "B" | "C";
  unseenByPromptAuthors: boolean;
  expectedCoreCharacters: BenchmarkCharacter[];
  expectedSupportingCharacters: BenchmarkCharacter[];
  expectedKeyEvents: BenchmarkLabeledItem[];
  expectedEndingCandidates: BenchmarkEnding[];
  testDivergences: BenchmarkDivergence[];
};

const RateScoreSchema = z
  .object({
    matched: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    rate: z.number().min(0).max(1),
  })
  .strict();

const PendingManualScoreSchema = z
  .object({
    expectedTotal: z.number().int().positive(),
    candidateTotal: z.number().int().nonnegative(),
    matched: z.null(),
    recall: z.null(),
    manualReviewQueue: z
      .object({
        expectedIds: z.array(z.string().min(1)),
        candidateIds: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict();

const ProviderObservationSchema = z
  .object({
    schemaName: z.string().min(1),
    attempt: z.enum(["initial", "repair"]),
    status: z.enum(["succeeded", "failed"]),
    durationMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
    failureCode: z.string().min(1).nullable(),
  })
  .strict();

const ProviderObservationSummarySchema = z
  .object({
    callCount: z.number().int().nonnegative(),
    repairCount: z.number().int().nonnegative(),
    failedCallCount: z.number().int().nonnegative(),
    wallClockDurationMs: z.number().int().nonnegative(),
    usageComplete: z.boolean(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
  })
  .strict();

const StageValidationSchema = z
  .object({
    firstPassValidation: z.enum([
      "passed",
      "failed",
      "not_run",
      "not_observed",
    ]),
    repair: z.enum(["not_needed", "succeeded", "failed", "not_run"]),
  })
  .strict();

const AnalysisSegmentObservationSchema = z
  .object({
    segmentId: z.string().min(1),
    coreCharacters: z.number().int().positive(),
    contextCharacters: z.number().int().positive(),
    status: z.enum(["succeeded", "failed", "not_run"]),
    firstPassValidation: StageValidationSchema.shape.firstPassValidation,
    repair: StageValidationSchema.shape.repair,
  })
  .strict();

export const AnalysisSegmentSummarySchema = z
  .object({
    count: z.number().int().nonnegative(),
    items: z.array(AnalysisSegmentObservationSchema),
  })
  .strict();

export const M1StoryMapCompatibilitySchema = z
  .object({
    extractor: StageValidationSchema,
    reconciler: StageValidationSchema,
    evidenceValidity: RateScoreSchema.nullable(),
    storyMapArtifactCreated: z.boolean(),
  })
  .strict();

export const M1StoryMapBaselineScoreSchema = z
  .object({
    coreCharacterRecall: RateScoreSchema,
    identity: z
      .object({
        exactMatches: z.number().int().nonnegative(),
        expectedTotal: z.number().int().positive(),
        candidateTotal: z.number().int().positive(),
        precision: z.number().min(0).max(1),
        recall: z.number().min(0).max(1),
        f1: z.number().min(0).max(1),
        missingExpectedIds: z.array(z.string().min(1)),
        candidateReviewIds: z.array(z.string().min(1)),
        potentialMergeCandidateIds: z.array(z.string().min(1)),
      })
      .strict(),
    evidenceValidity: RateScoreSchema,
    eventsWithoutValidEvidence: z.array(z.string().min(1)),
    events: PendingManualScoreSchema,
    edges: z
      .object({
        candidateTotal: z.number().int().nonnegative(),
        manualReviewQueue: z.array(z.string().min(1)),
      })
      .strict(),
    endingCandidates: PendingManualScoreSchema,
  })
  .strict();

export type M1StoryMapBaselineScore = z.infer<
  typeof M1StoryMapBaselineScoreSchema
>;

export const M1BaselineStoryReportSchema = z
  .object({
    storyId: z.string().min(1),
    storyClass: z.enum(["A", "B", "C"]),
    visibility: z.enum(["public", "private"]),
    unseenByPromptAuthors: z.boolean(),
    characterCount: z.number().int().min(10_000).max(60_000),
    status: z.enum(["generated", "failed"]),
    provider: z.string().min(1),
    model: z.string().min(1),
    structuredOutputMode: z.enum([
      "json_schema",
      "json_object",
      "prompt_json",
    ]),
    promptVersions: z.array(
      z
        .object({ kind: z.string().min(1), version: z.string().min(1) })
        .strict(),
    ),
    wallClockDurationMs: z.number().int().nonnegative(),
    calls: z.array(ProviderObservationSchema),
    generation: ProviderObservationSummarySchema,
    analysisSegments: AnalysisSegmentSummarySchema,
    compatibility: M1StoryMapCompatibilitySchema,
    reviewTarget: z
      .object({
        projectId: z.string().min(1),
        sourceId: z.string().min(1),
        storyMapArtifactId: z.string().min(1),
      })
      .strict()
      .nullable(),
    storyMap: M1StoryMapBaselineScoreSchema.nullable(),
    modelFailures: z.array(
      z
        .object({
          stage: z.enum([
            "configuration",
            "manifest",
            "source_import",
            "story_map",
          ]),
          code: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((report, context) => {
    if (
      report.status === "generated" &&
      (report.reviewTarget === null || report.storyMap === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "generated report requires reviewTarget and storyMap",
      });
    }
    if (
      report.status === "failed" &&
      (report.reviewTarget !== null || report.storyMap !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "failed report cannot expose incomplete review state",
      });
    }
  });

export const M1BaselineSuiteReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("m1_story_map_baseline"),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/),
    evaluatedAt: z.iso.datetime(),
    status: z.enum(["awaiting_human_review", "failed"]),
    databaseFile: z.literal("eval.db"),
    stories: z.array(M1BaselineStoryReportSchema).min(1),
    privacy: z
      .object({
        containsSourceBody: z.literal(false),
        containsRawModelOutput: z.literal(false),
        containsPrivateTitleOrNames: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((report, context) => {
    const failed = report.stories.some((story) => story.status === "failed");
    if ((report.status === "failed") !== failed) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "suite status must reflect story failures",
      });
    }
  });

export type M1BaselineSuiteReport = z.infer<
  typeof M1BaselineSuiteReportSchema
>;

export type ProviderObservation = {
  schemaName: string;
  attempt: "initial" | "repair";
  status: "succeeded" | "failed";
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  failureCode: string | null;
};

export type ProviderObservationSummary = {
  callCount: number;
  repairCount: number;
  failedCallCount: number;
  wallClockDurationMs: number;
  usageComplete: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type M1StoryMapCompatibility = z.infer<
  typeof M1StoryMapCompatibilitySchema
>;

type ValidationRunObservation = {
  kind: string;
  status: "pending" | "succeeded" | "failed";
  attemptCount: 0 | 1 | 2;
};

export class InstrumentedAIProvider implements AIProvider {
  readonly providerName: string;
  readonly observations: ProviderObservation[] = [];

  constructor(private readonly inner: AIProvider) {
    this.providerName = inner.providerName;
  }

  async generate(request: AIProviderRequest): Promise<AIProviderResponse> {
    const startedAt = performance.now();
    try {
      const response = await this.inner.generate(request);
      this.observations.push({
        schemaName: request.schemaName,
        attempt: request.repair ? "repair" : "initial",
        status: "succeeded",
        durationMs: elapsedMilliseconds(startedAt),
        inputTokens: response.usage?.inputTokens ?? null,
        outputTokens: response.usage?.outputTokens ?? null,
        totalTokens: response.usage?.totalTokens ?? null,
        failureCode: null,
      });
      return response;
    } catch (error) {
      this.observations.push({
        schemaName: request.schemaName,
        attempt: request.repair ? "repair" : "initial",
        status: "failed",
        durationMs: elapsedMilliseconds(startedAt),
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        failureCode: classifyProviderFailure(error),
      });
      throw error;
    }
  }
}

export function countBenchmarkCharacters(value: string): number {
  return [...normalizeSourceText(value)].filter(
    (character) => !/\s/u.test(character),
  ).length;
}

export function assertM1BaselineSuite(
  manifests: M1BenchmarkManifest[],
): void {
  if (manifests.length < 3) {
    throw new Error("M1 baseline 必须包含至少三篇冻结 Benchmark");
  }
  const ids = manifests.map((manifest) => manifest.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("M1 baseline Benchmark ID 不得重复");
  }
  for (const storyClass of ["A", "B", "C"] as const) {
    if (!manifests.some((manifest) => manifest.storyClass === storyClass)) {
      throw new Error(`M1 baseline 缺少 Story ${storyClass}`);
    }
  }
  if (!manifests.some((manifest) => manifest.unseenByPromptAuthors)) {
    throw new Error("M1 baseline 至少需要一篇 unseen 作品");
  }
}

export function summarizeProviderObservations(
  observations: ProviderObservation[],
): ProviderObservationSummary {
  const usageComplete = observations.every(
    (item) =>
      item.status === "succeeded" &&
      item.inputTokens !== null &&
      item.outputTokens !== null &&
      item.totalTokens !== null,
  );
  return {
    callCount: observations.length,
    repairCount: observations.filter((item) => item.attempt === "repair").length,
    failedCallCount: observations.filter((item) => item.status === "failed")
      .length,
    wallClockDurationMs: observations.reduce(
      (total, item) => total + item.durationMs,
      0,
    ),
    usageComplete,
    inputTokens: usageComplete
      ? observations.reduce((total, item) => total + (item.inputTokens ?? 0), 0)
      : null,
    outputTokens: usageComplete
      ? observations.reduce((total, item) => total + (item.outputTokens ?? 0), 0)
      : null,
    totalTokens: usageComplete
      ? observations.reduce((total, item) => total + (item.totalTokens ?? 0), 0)
      : null,
  };
}

export function summarizeStoryMapValidation(input: {
  calls: ProviderObservation[];
  runs: ValidationRunObservation[];
  evidenceValidity: z.infer<typeof RateScoreSchema> | null;
  storyMapArtifactCreated: boolean;
}): M1StoryMapCompatibility {
  return M1StoryMapCompatibilitySchema.parse({
    extractor: summarizeValidationStage(input.calls, input.runs, {
      schemaName: "story_map_segment",
      runKind: "story_map_extract",
      prefix: true,
    }),
    reconciler: summarizeValidationStage(input.calls, input.runs, {
      schemaName: "story_map_content",
      runKind: "story_map_reconcile",
      prefix: false,
    }),
    evidenceValidity: input.evidenceValidity,
    storyMapArtifactCreated: input.storyMapArtifactCreated,
  });
}

export function summarizeAnalysisSegments(input: {
  segments: AnalysisSegment[];
  runs: ValidationRunObservation[];
}): z.infer<typeof AnalysisSegmentSummarySchema> {
  return AnalysisSegmentSummarySchema.parse({
    count: input.segments.length,
    items: input.segments.map((segment) => {
      const run = input.runs.find(
        (candidate) =>
          candidate.kind === `story_map_extract:${segment.id}`,
      );
      const validation = summarizeRunValidation(run);
      return {
        segmentId: segment.id,
        coreCharacters: segment.coreEnd - segment.coreStart,
        contextCharacters: segment.contextEnd - segment.contextStart,
        status: run?.status ?? "not_run",
        ...validation,
      };
    }),
  });
}

function summarizeValidationStage(
  calls: ProviderObservation[],
  runs: ValidationRunObservation[],
  stage: { schemaName: string; runKind: string; prefix: boolean },
): z.infer<typeof StageValidationSchema> {
  const stageRuns = runs.filter((run) =>
    stage.prefix
      ? run.kind.startsWith(`${stage.runKind}:`)
      : run.kind === stage.runKind,
  );
  const stageCalls = calls.filter((call) => call.schemaName === stage.schemaName);

  if (stageRuns.length === 0 && stageCalls.length === 0) {
    return { firstPassValidation: "not_run", repair: "not_run" };
  }
  if (
    stageRuns.some((run) => run.status === "failed" && run.attemptCount >= 2)
  ) {
    return { firstPassValidation: "failed", repair: "failed" };
  }
  if (
    stageRuns.some((run) => run.status === "failed") &&
    stageCalls.some(
      (call) => call.attempt === "repair" && call.status === "failed",
    )
  ) {
    return { firstPassValidation: "failed", repair: "failed" };
  }
  if (
    stageRuns.some((run) => run.status === "failed") ||
    stageCalls.some(
      (call) => call.attempt === "initial" && call.status === "failed",
    )
  ) {
    return { firstPassValidation: "not_observed", repair: "not_run" };
  }
  if (stageRuns.some((run) => run.attemptCount === 2)) {
    return { firstPassValidation: "failed", repair: "succeeded" };
  }
  return { firstPassValidation: "passed", repair: "not_needed" };
}

function summarizeRunValidation(
  run: ValidationRunObservation | undefined,
): z.infer<typeof StageValidationSchema> {
  if (!run) return { firstPassValidation: "not_run", repair: "not_run" };
  if (run.status === "succeeded" && run.attemptCount === 1) {
    return { firstPassValidation: "passed", repair: "not_needed" };
  }
  if (run.status === "succeeded" && run.attemptCount === 2) {
    return { firstPassValidation: "failed", repair: "succeeded" };
  }
  if (run.status === "failed" && run.attemptCount >= 2) {
    return { firstPassValidation: "failed", repair: "failed" };
  }
  return { firstPassValidation: "not_observed", repair: "not_run" };
}

export function validateM1BenchmarkManifest(input: {
  value: unknown;
  jsonSchema: unknown;
  actualCharacterCount: number;
}): M1BenchmarkManifest {
  const converted = z.fromJSONSchema(
    input.jsonSchema as Parameters<typeof z.fromJSONSchema>[0],
    { defaultTarget: "draft-2020-12" },
  );
  const manifest = converted.parse(input.value) as M1BenchmarkManifest;

  if (manifest.characterCount !== input.actualCharacterCount) {
    throw new Error(
      `manifest characterCount ${manifest.characterCount} 与规范化 Source ${input.actualCharacterCount} 不一致`,
    );
  }
  if (
    manifest.visibility === "public" &&
    (!manifest.rights.redistributionAllowed ||
      manifest.rights.category === "private")
  ) {
    throw new Error("public benchmark 必须具有明确的公开再分发权利");
  }

  assertUniqueIds("expectedCoreCharacters", manifest.expectedCoreCharacters);
  assertUniqueIds(
    "expectedSupportingCharacters",
    manifest.expectedSupportingCharacters,
  );
  assertUniqueIds("expectedKeyEvents", manifest.expectedKeyEvents);
  assertUniqueIds(
    "expectedEndingCandidates",
    manifest.expectedEndingCandidates,
  );
  assertUniqueIds("testDivergences", manifest.testDivergences);
  assertNoSharedIds(
    "Character",
    manifest.expectedCoreCharacters,
    manifest.expectedSupportingCharacters,
  );

  const eventIds = new Set(manifest.expectedKeyEvents.map((item) => item.id));
  const endingIds = new Set(
    manifest.expectedEndingCandidates.map((item) => item.id),
  );
  for (const divergence of manifest.testDivergences) {
    if (!eventIds.has(divergence.eventId)) {
      throw new Error(
        `Divergence ${divergence.id} 引用了未知 Event ${divergence.eventId}`,
      );
    }
    for (const anchorId of divergence.anchorIds) {
      if (!endingIds.has(anchorId)) {
        throw new Error(
          `Divergence ${divergence.id} 引用了未知 Ending Candidate ${anchorId}`,
        );
      }
    }
    if (
      divergence.mode === "strict" &&
      (divergence.anchorIds.length === 0 ||
        divergence.expectedAnchorStatus === null)
    ) {
      throw new Error(`strict Divergence ${divergence.id} 缺少 Anchor 预期`);
    }
    if (
      divergence.mode === "open" &&
      (divergence.anchorIds.length > 0 ||
        divergence.expectedAnchorStatus !== null)
    ) {
      throw new Error(`open Divergence ${divergence.id} 不得携带 Anchor 预期`);
    }
  }
  if (!manifest.testDivergences.some((item) => item.mode === "strict")) {
    throw new Error("每篇 M1 benchmark 至少需要一个 strict Divergence");
  }
  if (!manifest.testDivergences.some((item) => item.mode === "open")) {
    throw new Error("每篇 M1 benchmark 至少需要一个 open Divergence");
  }

  assertClassContract(manifest);
  return manifest;
}

export function scoreM1StoryMapCandidate(input: {
  manifest: M1BenchmarkManifest;
  source: Source;
  storyMap: StoryMap;
}): M1StoryMapBaselineScore {
  const expectedCharacters = [
    ...input.manifest.expectedCoreCharacters,
    ...input.manifest.expectedSupportingCharacters,
  ];
  const matchedExpectedIds = new Set<string>();
  const matchedCandidateIds = new Set<string>();

  for (const expected of expectedCharacters) {
    const expectedNames = normalizedNames(expected);
    const candidate = input.storyMap.characters.find(
      (item) =>
        !matchedCandidateIds.has(item.id) &&
        normalizedNames(item).some((name) => expectedNames.includes(name)),
    );
    if (!candidate) continue;
    matchedExpectedIds.add(expected.id);
    matchedCandidateIds.add(candidate.id);
  }

  const matchedCoreCount = input.manifest.expectedCoreCharacters.filter((item) =>
    matchedExpectedIds.has(item.id),
  ).length;
  const exactMatches = matchedExpectedIds.size;
  const precision = divide(exactMatches, input.storyMap.characters.length);
  const recall = divide(exactMatches, expectedCharacters.length);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const references = collectEvidence(input.storyMap);
  const validReferenceCount = references.filter((reference) =>
    isValidEvidence(reference, input.source),
  ).length;
  const eventsWithoutValidEvidence = input.storyMap.events
    .filter(
      (event) =>
        !event.evidence.some((reference) =>
          isValidEvidence(reference, input.source),
        ),
    )
    .map((event) => event.id);

  return M1StoryMapBaselineScoreSchema.parse({
    coreCharacterRecall: rateScore(
      matchedCoreCount,
      input.manifest.expectedCoreCharacters.length,
    ),
    identity: {
      exactMatches,
      expectedTotal: expectedCharacters.length,
      candidateTotal: input.storyMap.characters.length,
      precision,
      recall,
      f1,
      missingExpectedIds: expectedCharacters
        .filter((item) => !matchedExpectedIds.has(item.id))
        .map((item) => item.id),
      candidateReviewIds: input.storyMap.characters
        .filter((item) => !matchedCandidateIds.has(item.id))
        .map((item) => item.id),
      potentialMergeCandidateIds: input.storyMap.characters
        .filter((candidate) => {
          const candidateNames = normalizedNames(candidate);
          return (
            expectedCharacters.filter((expected) =>
              normalizedNames(expected).some((name) =>
                candidateNames.includes(name),
              ),
            ).length > 1
          );
        })
        .map((item) => item.id),
    },
    evidenceValidity: rateScore(validReferenceCount, references.length),
    eventsWithoutValidEvidence,
    events: pendingManualScore(
      input.manifest.expectedKeyEvents.map((item) => item.id),
      input.storyMap.events.map((item) => item.id),
    ),
    edges: {
      candidateTotal: input.storyMap.edges.length,
      manualReviewQueue: input.storyMap.edges.map((item) => item.id),
    },
    endingCandidates: pendingManualScore(
      input.manifest.expectedEndingCandidates.map((item) => item.id),
      input.storyMap.endingCandidates.map((item) => item.id),
    ),
  });
}

function assertClassContract(manifest: M1BenchmarkManifest): void {
  const coreCount = manifest.expectedCoreCharacters.length;
  if (
    manifest.storyClass === "A" &&
    (manifest.characterCount < 10_000 ||
      manifest.characterCount > 25_000 ||
      coreCount < 4 ||
      coreCount > 6)
  ) {
    throw new Error("Story A 必须为 10k—25k 字且有 4—6 名核心人物");
  }
  if (
    manifest.storyClass === "B" &&
    (manifest.characterCount < 25_000 ||
      manifest.characterCount > 45_000 ||
      coreCount < 8 ||
      coreCount > 12)
  ) {
    throw new Error("Story B 必须为 25k—45k 字且有 8—12 名核心人物");
  }
  if (
    manifest.storyClass === "C" &&
    (manifest.characterCount < 15_000 ||
      manifest.characterCount > 35_000 ||
      !manifest.testDivergences.some((item) => item.type !== "prevent"))
  ) {
    throw new Error("Story C 必须为 15k—35k 字且包含非 prevent 分叉");
  }
}

function assertUniqueIds(
  label: string,
  values: Array<{ id: string }>,
): void {
  const ids = values.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} 包含重复 ID`);
  }
}

function assertNoSharedIds(
  label: string,
  left: Array<{ id: string }>,
  right: Array<{ id: string }>,
): void {
  const leftIds = new Set(left.map((item) => item.id));
  const shared = right.find((item) => leftIds.has(item.id));
  if (shared) throw new Error(`${label} ID 重复：${shared.id}`);
}

function normalizedNames(value: { name: string; aliases: string[] }): string[] {
  return [value.name, ...value.aliases].map((name) =>
    name.normalize("NFC").replace(/\s+/gu, "").toLocaleLowerCase(),
  );
}

function collectEvidence(storyMap: StoryMap): SourceReference[] {
  return [
    ...storyMap.events.flatMap((event) => event.evidence),
    ...storyMap.edges.flatMap((edge) => edge.evidence),
    ...storyMap.endingCandidates.flatMap((ending) => ending.evidence),
  ];
}

function isValidEvidence(reference: SourceReference, source: Source): boolean {
  const section = source.sections.find((item) => item.id === reference.sectionId);
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

function pendingManualScore(
  expectedIds: string[],
  candidateIds: string[],
): z.infer<typeof PendingManualScoreSchema> {
  return {
    expectedTotal: expectedIds.length,
    candidateTotal: candidateIds.length,
    matched: null,
    recall: null,
    manualReviewQueue: { expectedIds, candidateIds },
  };
}

function rateScore(matched: number, total: number) {
  return { matched, total, rate: divide(matched, total) };
}

function divide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function classifyProviderFailure(error: unknown): string {
  const details =
    error && typeof error === "object"
      ? (error as { name?: unknown; code?: unknown; status?: unknown })
      : {};
  const name = typeof details.name === "string" ? details.name.toLowerCase() : "";
  const code = typeof details.code === "string" ? details.code.toLowerCase() : "";
  if (
    code === "context_length_exceeded" ||
    code === "context_window_exceeded"
  ) {
    return "context_window";
  }
  if (
    name.includes("timeout") ||
    name === "aborterror" ||
    code.includes("timeout") ||
    details.status === 408 ||
    details.status === 504
  ) {
    return "timeout";
  }
  if (
    code === "invalid_json_schema" ||
    code === "unsupported_response_format"
  ) {
    return "provider_schema_compatibility";
  }
  return "provider_error";
}
