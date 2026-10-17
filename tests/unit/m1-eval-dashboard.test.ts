import { describe, expect, it } from "vitest";

import {
  combineHardRules,
  combineTargets,
  evaluateAggregateStoryMapTargets,
  evaluateContinuationTargets,
  evaluateCorrectionCostTargets,
  evaluateHardRules,
  evaluateRippleTargets,
  evaluateStoryMapTargets,
  evaluateUserObservationTargets,
  hardRulesPassed,
  M1StoryMapHumanSchema,
  type M1ContinuationHuman,
  type M1RippleHuman,
  type M1StoryMapHuman,
} from "@/evals/m1-eval";
import {
  determineM1ContinuationStatus,
  type M1ContinuationStory,
} from "@/evals/m1-continuation";

function storyMap(overrides: Partial<M1StoryMapHuman> = {}): M1StoryMapHuman {
  return {
    storyClass: "A",
    coreCharacterRecall: 1,
    coreCharacterTotal: 5,
    coreCharacterMatched: 5,
    identityF1: 1,
    keyEventRecall: 0.9,
    keyEventTotal: 10,
    keyEventMatched: 9,
    endingCandidateRecall: 1,
    criticalMergeMistakes: 0,
    causalEdgeApprovalRate: 0.8,
    evidenceValidityRate: 1,
    eventsWithoutValidEvidence: 0,
    ...overrides,
  };
}

function ripple(overrides: Partial<M1RippleHuman> = {}): M1RippleHuman {
  return {
    storyClass: "A",
    strictDivergenceEvaluated: true,
    openDivergenceEvaluated: true,
    approvedSuggestionCount: 3,
    directImpactApprovalRate: 0.9,
    anchorConsistencyRate: 1,
    preDivergenceMutations: 0,
    feedbackResolved: true,
    ...overrides,
  };
}

function continuation(
  overrides: Partial<M1ContinuationHuman> = {},
): M1ContinuationHuman {
  return {
    storyClass: "A",
    worldlineConsistency: 5,
    characterContinuity: 5,
    narrativeContinuity: 5,
    sceneInterest: 5,
    wouldContinueReading: true,
    hardConflicts: 0,
    recoveredDeletedFacts: 0,
    preDivergenceRewrites: 0,
    strictAnchorViolations: 0,
    ...overrides,
  };
}

describe("M1 dashboard: quality targets do not block", () => {
  it("reports the M1-07 recall shortfall as below_target while hard rules pass", () => {
    // M1-07 实际情况：Ending 召回 66.7% / 50%，修正 16 次，真人观察 0 次。
    const maps = [
      storyMap({ endingCandidateRecall: 0.667 }),
      storyMap({ storyClass: "B", endingCandidateRecall: 0.667 }),
      storyMap({ storyClass: "C", endingCandidateRecall: 0.5 }),
    ];
    const targets = combineTargets(maps.map(evaluateStoryMapTargets));
    expect(targets.status).toBe("below_target");
    expect(targets.misses).toContain("C:ending_candidate_recall_0.5");

    const correction = evaluateCorrectionCostTargets(
      {
        storyClass: "A",
        reviewDurationMin: 7,
        materialRevisions: 16,
        manualEventAdditions: 0,
        characterFixes: 0,
        edgeFixes: 0,
      },
      20_000,
    );
    expect(correction).toEqual({
      status: "below_target",
      misses: ["material_revisions_16"],
      unmeasured: [],
    });

    const rules = combineHardRules(
      maps.map((map) =>
        evaluateHardRules({
          storyMap: map,
          ripple: ripple(),
          continuation: continuation(),
        }),
      ),
    );
    expect(hardRulesPassed(rules)).toBe(true);
  });

  it("treats missing human data and user observation as not_measured, never as failure", () => {
    expect(evaluateStoryMapTargets(null).status).toBe("not_measured");
    expect(evaluateContinuationTargets(null).status).toBe("not_measured");
    expect(evaluateUserObservationTargets(null).status).toBe("not_measured");
    expect(evaluateAggregateStoryMapTargets([null, null, null]).status).toBe(
      "not_measured",
    );
    const rules = evaluateHardRules({
      storyMap: null,
      ripple: null,
      continuation: null,
    });
    expect(Object.values(rules).every((r) => r.status === "not_measured")).toBe(
      true,
    );
    expect(hardRulesPassed(rules)).toBe(true);
  });

  it("accepts author self-review as a valid score", () => {
    const parsed = M1StoryMapHumanSchema.parse(storyMap({ reviewer: "author" }));
    expect(parsed.reviewer).toBe("author");
    expect(evaluateStoryMapTargets(parsed).status).toBe("met");
  });

  it("null ripple rates are not_measured with unmeasured entries", () => {
    const result = evaluateRippleTargets(
      ripple({ directImpactApprovalRate: null, anchorConsistencyRate: null }),
    );
    expect(result.status).toBe("not_measured");
    expect(result.misses).toEqual([]);
    expect(result.unmeasured).toEqual([
      "direct_impact_approval_rate",
      "anchor_consistency_rate",
    ]);
  });

  it("combineTargets propagates unmeasured instead of reporting met", () => {
    const met = evaluateRippleTargets(ripple({ storyClass: "A" }));
    const partiallyUnmeasured = evaluateRippleTargets(
      ripple({
        storyClass: "B",
        directImpactApprovalRate: null,
        anchorConsistencyRate: null,
      }),
    );
    const combined = combineTargets([met, partiallyUnmeasured]);
    expect(combined.status).toBe("not_measured");
    expect(combined.misses).toEqual([]);
    expect(combined.unmeasured).toEqual([
      "B:direct_impact_approval_rate",
      "B:anchor_consistency_rate",
    ]);
  });

  it("combineTargets marks an entirely unmeasured story when others are measured", () => {
    const metA = evaluateStoryMapTargets(storyMap({ storyClass: "A" }));
    const missingB = evaluateStoryMapTargets(null);
    const metC = evaluateStoryMapTargets(storyMap({ storyClass: "C" }));
    const combined = combineTargets([metA, missingB, metC]);
    expect(combined.status).toBe("not_measured");
    expect(combined.misses).toEqual([]);
    expect(combined.unmeasured).toEqual(["B:not_measured"]);

    // 全部未测时保持普通的 not_measured，不额外生成占位条目。
    const allMissing = combineTargets([
      evaluateStoryMapTargets(null),
      evaluateStoryMapTargets(null),
    ]);
    expect(allMissing.status).toBe("not_measured");
    expect(allMissing.unmeasured).toEqual([]);
  });
});

describe("M1 dashboard: hard rules still block", () => {
  it.each([
    [
      "sourceNotOverwritten",
      { ripple: ripple({ preDivergenceMutations: 1 }) },
      "pre_divergence_mutations_1",
    ],
    [
      "sourceNotOverwritten",
      { continuation: continuation({ preDivergenceRewrites: 2 }) },
      "pre_divergence_rewrites_2",
    ],
    [
      "traceability",
      { storyMap: storyMap({ eventsWithoutValidEvidence: 1 }) },
      "events_without_evidence_1",
    ],
    [
      "traceability",
      { storyMap: storyMap({ evidenceValidityRate: 0.95 }) },
      "evidence_validity_0.95",
    ],
    [
      "worldlineIsolation",
      { continuation: continuation({ recoveredDeletedFacts: 1 }) },
      "recovered_deleted_facts_1",
    ],
    [
      "badOutputRejected",
      { continuation: continuation({ hardConflicts: 1 }) },
      "hard_conflicts_1",
    ],
    [
      "badOutputRejected",
      { continuation: continuation({ strictAnchorViolations: 1 }) },
      "strict_anchor_violations_1",
    ],
  ] as const)("%s fails on %s", (ruleId, input, violation) => {
    const rules = evaluateHardRules({
      storyMap: null,
      ripple: null,
      continuation: null,
      ...input,
    });
    expect(rules[ruleId]).toEqual({ status: "fail", violations: [violation] });
    expect(hardRulesPassed(rules)).toBe(false);
  });

  it("a violation in any single story fails the combined rule", () => {
    const clean = evaluateHardRules({
      storyMap: storyMap(),
      ripple: ripple(),
      continuation: continuation(),
    });
    const dirty = evaluateHardRules({
      storyMap: storyMap(),
      ripple: ripple(),
      continuation: continuation({ recoveredDeletedFacts: 1 }),
    });
    const combined = combineHardRules([clean, clean, dirty]);
    expect(combined.worldlineIsolation).toEqual({
      status: "fail",
      violations: ["C:recovered_deleted_facts_1"],
    });
    expect(hardRulesPassed(combined)).toBe(false);
  });
});

describe("M1 continuation status", () => {
  function completedStory(
    storyClass: "A" | "B" | "C",
    worldlineConsistency: number,
  ): M1ContinuationStory {
    const ok = { status: "succeeded" };
    return {
      storyClass,
      status: "completed",
      confirmedStoryMapMatched: true,
      storyMapProvisioning: { status: "reused_confirmed" },
      suggestions: ok,
      impactPlan: ok,
      worldline: ok,
      directions: ok,
      scene: { ...ok, consistency: { hardGatePassed: true } },
      isolation: { canonUnchanged: true },
      humanReview: {
        status: "completed",
        worldlineConsistency,
        narrativeContinuity: 5,
        wouldContinueReading: true,
      },
    } as unknown as M1ContinuationStory;
  }

  it("low human scores are below_target, not failed", () => {
    expect(
      determineM1ContinuationStatus([
        completedStory("A", 3),
        completedStory("B", 5),
        completedStory("C", 5),
      ]),
    ).toBe("below_target");
  });

  it("a broken consistency hard gate is still failed", () => {
    const broken = completedStory("A", 5);
    (broken.scene as { consistency: { hardGatePassed: boolean } }).consistency.hardGatePassed = false;
    expect(
      determineM1ContinuationStatus([
        broken,
        completedStory("B", 5),
        completedStory("C", 5),
      ]),
    ).toBe("failed");
  });
});
