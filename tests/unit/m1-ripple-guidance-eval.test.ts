import { describe, expect, it } from "vitest";

import {
  M1RippleGuidanceReportSchema,
  determineM1RippleGuidanceStatus,
  type M1RippleGuidanceStory,
} from "@/evals/m1-ripple-guidance";

function successfulStage(artifactCreated = true) {
  return {
    status: "succeeded" as const,
    promptVersion: "test.v1",
    durationMs: 10,
    attemptCount: 1 as const,
    inputTokens: 20,
    outputTokens: 10,
    totalTokens: 30,
    artifactCreated,
    failureCode: null,
  };
}

function story(storyClass: "A" | "B" | "C"): M1RippleGuidanceStory {
  return {
    storyClass,
    status: "completed" as const,
    confirmedStoryMapMatched: true,
    suggestions: {
      ...successfulStage(),
      suggestionCount: 3,
    },
    initialCandidate: successfulStage(),
    feedbackCandidate: successfulStage(),
    invariants: {
      suggestionsExactlyThree: true,
      noWorldlineWrites: true,
      oldCandidateImmutable: true,
      lineageContractPreserved: true,
      hardValidationPassed: true,
    },
    humanReview: {
      valuableSuggestionCount: null,
      feedbackProblemResolved: null,
      status: "awaiting_human_review" as const,
    },
  };
}

describe("M1 Ripple guidance evaluation contract", () => {
  it("keeps a successful automatic run awaiting human quality review", () => {
    const stories = [story("A"), story("B"), story("C")];
    const status = determineM1RippleGuidanceStatus(stories);

    expect(status).toBe("awaiting_human_review");
    expect(
      M1RippleGuidanceReportSchema.parse({
        schemaVersion: 1,
        kind: "m1_ripple_guidance",
        runId: "20260813-abcdef0-12345678",
        commitSha: "a".repeat(40),
        evaluatedAt: "2026-08-13T00:00:00.000Z",
        provider: "openai-compatible",
        model: "test-model",
        structuredOutputMode: "json_object",
        status,
        databaseFile: "eval.db",
        stories,
        privacy: {
          containsSourceBody: false,
          containsRawModelOutput: false,
          containsPrivateTitleOrNames: false,
        },
      }).status,
    ).toBe("awaiting_human_review");
  });

  it("only passes when every story has two valuable suggestions and fixed feedback", () => {
    const stories = [story("A"), story("B"), story("C")].map((item) => ({
      ...item,
      humanReview: {
        valuableSuggestionCount: 2,
        feedbackProblemResolved: true,
        status: "completed" as const,
      },
    }));

    expect(determineM1RippleGuidanceStatus(stories)).toBe("passed");
  });

  it("fails closed when automatic generation or an invariant fails", () => {
    const stories = [story("A"), story("B"), story("C")];
    stories[1] = {
      ...stories[1],
      status: "failed",
      invariants: {
        ...stories[1].invariants,
        hardValidationPassed: false,
      },
    };

    expect(determineM1RippleGuidanceStatus(stories)).toBe("failed");
  });

  it("rejects report fields that could carry private story content", () => {
    const result = M1RippleGuidanceReportSchema.safeParse({
      schemaVersion: 1,
      kind: "m1_ripple_guidance",
      runId: "20260813-abcdef0-12345678",
      commitSha: "a".repeat(40),
      evaluatedAt: "2026-08-13T00:00:00.000Z",
      provider: "openai-compatible",
      model: "test-model",
      structuredOutputMode: "json_object",
      status: "awaiting_human_review",
      databaseFile: "eval.db",
      stories: [story("A"), story("B"), story("C")],
      sourceBody: "forbidden",
      privacy: {
        containsSourceBody: false,
        containsRawModelOutput: false,
        containsPrivateTitleOrNames: false,
      },
    });

    expect(result.success).toBe(false);
  });
});
