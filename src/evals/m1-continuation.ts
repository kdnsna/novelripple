import { z } from "zod";

const TokenCountSchema = z.number().int().nonnegative().nullable();

const GenerationStageSchema = z
  .object({
    status: z.enum(["succeeded", "failed", "not_run"]),
    promptVersion: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
    attemptCount: z.union([z.literal(1), z.literal(2)]).nullable(),
    inputTokens: TokenCountSchema,
    outputTokens: TokenCountSchema,
    totalTokens: TokenCountSchema,
    artifactCreated: z.boolean(),
    failureCode: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((stage, context) => {
    if (
      stage.status === "succeeded" &&
      (stage.attemptCount === null || !stage.artifactCreated || stage.failureCode)
    ) {
      context.addIssue({
        code: "custom",
        message: "successful stage must record an artifact without failure",
      });
    }
    if (stage.status !== "succeeded" && stage.artifactCreated) {
      context.addIssue({
        code: "custom",
        message: "failed or skipped stage cannot record an artifact",
      });
    }
  });

const SuggestionStageSchema = GenerationStageSchema.and(
  z
    .object({
      suggestionCount: z.number().int().min(1).max(3).nullable(),
      selectedSuggestionIndex: z.number().int().min(0).max(2).nullable(),
    })
    .strict(),
);

const DirectionsStageSchema = GenerationStageSchema.and(
  z
    .object({
      directionCount: z.number().int().min(1).max(3).nullable(),
      distinctTitleCount: z.number().int().min(1).max(3).nullable(),
      selectedDirectionIndex: z.number().int().min(0).max(2).nullable(),
      selectedAffectedCharacterCount: z.number().int().nonnegative().nullable(),
    })
    .strict(),
);

const StoryMapProvisioningSchema = z
  .object({
    status: z.enum(["reused_confirmed", "confirmed_by_harness", "failed"]),
    baselineConfirmedVersion: z.number().int().positive().nullable(),
    draftVersionConfirmed: z.number().int().positive().nullable(),
    reviewOperationsApplied: z.number().int().nonnegative(),
    finalVersion: z.number().int().positive().nullable(),
    failureCode: z.string().min(1).nullable(),
  })
  .strict();

const WorldlineStageSchema = z
  .object({
    status: z.enum(["succeeded", "failed", "not_run"]),
    mode: z.enum(["strict", "open"]).nullable(),
    anchorCount: z.number().int().nonnegative().nullable(),
    durationMs: z.number().int().nonnegative(),
    worldlinesBefore: z.number().int().nonnegative().nullable(),
    worldlinesAfter: z.number().int().nonnegative().nullable(),
    canonicalWorldlineCreated: z.boolean(),
    childWorldlineActive: z.boolean(),
    acceptedArtifactPersisted: z.boolean(),
    failureCode: z.string().min(1).nullable(),
  })
  .strict();

const StatePatchSummarySchema = z
  .object({
    factsAddedCount: z.number().int().nonnegative(),
    factsRemovedCount: z.number().int().nonnegative(),
    characterChangesCount: z.number().int().nonnegative(),
    threadsOpenedCount: z.number().int().nonnegative(),
    threadsClosedCount: z.number().int().nonnegative(),
  })
  .strict();

const ConsistencyChecksSchema = z
  .object({
    resurrectedRemovedFacts: z.boolean(),
    deletedAcceptedFacts: z.boolean(),
    preDivergenceMutation: z.boolean(),
    anchorDeletion: z.boolean(),
    invalidCharacter: z.boolean(),
    invalidThread: z.boolean(),
    otherViolations: z.number().int().nonnegative(),
    hardGatePassed: z.boolean(),
  })
  .strict();

const SceneStageSchema = GenerationStageSchema.and(
  z
    .object({
      proseTotalChars: z.number().int().nonnegative().nullable(),
      proseCjkChars: z.number().int().nonnegative().nullable(),
      proseWithinTargetRange: z.boolean().nullable(),
      statePatch: StatePatchSummarySchema.nullable(),
      consistency: ConsistencyChecksSchema.nullable(),
    })
    .strict(),
);

const IsolationChecksSchema = z
  .object({
    sourceContentHashUnchanged: z.boolean(),
    storyMapArtifactUnchanged: z.boolean(),
    canonicalWorldlineUnchanged: z.boolean(),
    siblingWorldlinesUnchanged: z.boolean(),
    worldlineCountExpected: z.boolean(),
  })
  .strict();

const M1ContinuationStorySchema = z
  .object({
    storyClass: z.enum(["A", "B", "C"]),
    status: z.enum(["completed", "failed"]),
    confirmedStoryMapMatched: z.boolean(),
    storyMapProvisioning: StoryMapProvisioningSchema,
    suggestions: SuggestionStageSchema,
    impactPlan: GenerationStageSchema,
    worldline: WorldlineStageSchema,
    directions: DirectionsStageSchema,
    scene: SceneStageSchema,
    isolation: IsolationChecksSchema,
    humanReview: z
      .object({
        worldlineConsistency: z.number().int().min(1).max(5).nullable(),
        characterContinuity: z.number().int().min(1).max(5).nullable(),
        narrativeContinuity: z.number().int().min(1).max(5).nullable(),
        sceneInterest: z.number().int().min(1).max(5).nullable(),
        wouldContinueReading: z.boolean().nullable(),
        status: z.enum(["awaiting_human_review", "completed"]),
      })
      .strict(),
  })
  .strict();

export type M1ContinuationStory = z.infer<typeof M1ContinuationStorySchema>;

export type M1ContinuationStatus =
  | "passed"
  | "awaiting_human_review"
  | "failed";

const STAGE_SUCCESS = "succeeded" as const;

export function determineM1ContinuationStatus(
  stories: M1ContinuationStory[],
): M1ContinuationStatus {
  if (
    stories.length !== 3 ||
    new Set(stories.map((story) => story.storyClass)).size !== 3 ||
    stories.some(
      (story) =>
        story.status === "failed" ||
        !story.confirmedStoryMapMatched ||
        story.storyMapProvisioning.status === "failed" ||
        story.suggestions.status !== STAGE_SUCCESS ||
        story.impactPlan.status !== STAGE_SUCCESS ||
        story.worldline.status !== "succeeded" ||
        story.directions.status !== STAGE_SUCCESS ||
        story.scene.status !== STAGE_SUCCESS ||
        story.scene.consistency?.hardGatePassed !== true ||
        !Object.values(story.isolation).every(Boolean),
    )
  ) {
    return "failed";
  }

  if (
    stories.every(
      (story) => story.humanReview.status === "completed",
    )
  ) {
    const gatesPassed =
      stories.every(
        (story) =>
          (story.humanReview.worldlineConsistency ?? 0) >= 4 &&
          (story.humanReview.narrativeContinuity ?? 0) >= 3.5,
      ) &&
      stories.filter((story) => story.humanReview.wouldContinueReading === true)
        .length >= 2;
    return gatesPassed ? "passed" : "failed";
  }

  return "awaiting_human_review";
}

export const M1ContinuationReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("m1_continuation"),
    runId: z.string().min(1),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/),
    evaluatedAt: z.iso.datetime(),
    provider: z.string().min(1),
    model: z.string().min(1),
    structuredOutputMode: z.enum([
      "json_schema",
      "json_object",
      "prompt_json",
    ]),
    status: z.enum(["passed", "awaiting_human_review", "failed"]),
    databaseFile: z.literal("eval.db"),
    baselineDatabase: z.string().min(1),
    stories: z.array(M1ContinuationStorySchema).length(3),
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
    const expected = determineM1ContinuationStatus(report.stories);
    if (report.status !== expected) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "report status must match story results",
      });
    }
  });

export type M1ContinuationReport = z.infer<
  typeof M1ContinuationReportSchema
>;
