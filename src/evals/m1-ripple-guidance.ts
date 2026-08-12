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

const SuggestionsStageSchema = GenerationStageSchema.and(
  z
    .object({
      suggestionCount: z.number().int().min(1).max(3).nullable(),
    })
    .strict(),
);

const M1RippleGuidanceStorySchema = z
  .object({
    storyClass: z.enum(["A", "B", "C"]),
    status: z.enum(["completed", "failed"]),
    confirmedStoryMapMatched: z.boolean(),
    suggestions: SuggestionsStageSchema,
    initialCandidate: GenerationStageSchema,
    feedbackCandidate: GenerationStageSchema,
    invariants: z
      .object({
        suggestionsExactlyThree: z.boolean(),
        noWorldlineWrites: z.boolean(),
        oldCandidateImmutable: z.boolean(),
        lineageContractPreserved: z.boolean(),
        hardValidationPassed: z.boolean(),
      })
      .strict(),
    humanReview: z
      .object({
        valuableSuggestionCount: z.number().int().min(0).max(3).nullable(),
        feedbackProblemResolved: z.boolean().nullable(),
        status: z.enum(["awaiting_human_review", "completed"]),
      })
      .strict(),
  })
  .strict();

export type M1RippleGuidanceStory = z.infer<
  typeof M1RippleGuidanceStorySchema
>;

export type M1RippleGuidanceStatus =
  | "passed"
  | "awaiting_human_review"
  | "failed";

export function determineM1RippleGuidanceStatus(
  stories: M1RippleGuidanceStory[],
): M1RippleGuidanceStatus {
  if (
    stories.length !== 3 ||
    new Set(stories.map((story) => story.storyClass)).size !== 3 ||
    stories.some(
      (story) =>
        story.status === "failed" ||
        !story.confirmedStoryMapMatched ||
        !Object.values(story.invariants).every(Boolean),
    )
  ) {
    return "failed";
  }

  if (
    stories.every(
      (story) =>
        story.humanReview.status === "completed" &&
        (story.humanReview.valuableSuggestionCount ?? 0) >= 2 &&
        story.humanReview.feedbackProblemResolved === true,
    )
  ) {
    return "passed";
  }

  return "awaiting_human_review";
}

export const M1RippleGuidanceReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("m1_ripple_guidance"),
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
    stories: z.array(M1RippleGuidanceStorySchema).length(3),
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
    const expected = determineM1RippleGuidanceStatus(report.stories);
    if (report.status !== expected) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "report status must match story results",
      });
    }
  });

export type M1RippleGuidanceReport = z.infer<
  typeof M1RippleGuidanceReportSchema
>;
