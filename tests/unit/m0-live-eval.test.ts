import { describe, expect, it } from "vitest";

import {
  M0LiveEvalFailureReportSchema,
  evaluateM0ReleaseGate,
  scoreContinuationStatePatch,
  scoreFixtureImpactPlan,
  scoreFixtureStoryMap,
} from "@/evals/m0-live-eval";
import { WorldlineDeltaSchema } from "@/domain/schemas";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";

describe("M0 live eval scoring", () => {
  it("keeps failed-stage diagnostics and completed partial metrics", () => {
    const report = M0LiveEvalFailureReportSchema.parse({
      schemaVersion: 1,
      fixtureId: "ripple-001",
      evaluatedAt: "2026-08-11T00:00:00.000Z",
      provider: "openai-compatible",
      model: "test-model",
      status: "failed",
      failedStage: "impact_plan",
      promptVersions: [{ kind: "story_map_extract", version: "story-map.v1" }],
      partial: { impacts: [] },
      error: "impact plan failed",
    });

    expect(report.failedStage).toBe("impact_plan");
    expect(report.promptVersions).toHaveLength(1);
  });

  it("scores the human golden Story Map without relying on model wording", async () => {
    const { source, storyMap } = await loadRippleFixture();

    const score = scoreFixtureStoryMap({
      source,
      golden: storyMap,
      candidate: storyMap,
    });

    expect(score.eventRecall).toEqual({ matched: 12, total: 12, rate: 1 });
    expect(score.characterRecall).toEqual({ matched: 5, total: 5, rate: 1 });
    expect(score.evidenceValidity.rate).toBe(1);
    expect(score.criticalMissingEventIds).toEqual([]);
    expect(score.invalidOrHallucinatedEvents).toEqual([]);
    expect(score.unmatchedSourceBackedEventIds).toEqual([]);
    expect(Object.keys(score.eventIdMap)).toHaveLength(12);
  });

  it("reports missing structure and invalid Evidence instead of guessing", async () => {
    const { source, storyMap } = await loadRippleFixture();
    const candidate = structuredClone(storyMap);
    candidate.events = candidate.events.filter((event) => event.id !== "event_03");
    candidate.edges = candidate.edges.filter(
      (edge) => edge.from !== "event_03" && edge.to !== "event_03",
    );
    candidate.events[0]!.evidence[0]!.excerptHash = `sha256:${"0".repeat(64)}`;

    const score = scoreFixtureStoryMap({ source, golden: storyMap, candidate });

    expect(score.eventRecall.matched).toBe(11);
    expect(score.criticalMissingEventIds).toContain("event_03");
    expect(score.evidenceValidity.rate).toBeLessThan(1);
    expect(score.invalidOrHallucinatedEvents).toContainEqual(
      expect.objectContaining({ eventId: "event_01" }),
    );
  });

  it("scores required direct impacts and Anchor results structurally", async () => {
    const { storyMap, impactPlans } = await loadRippleFixture();
    const eventIdMap = Object.fromEntries(
      storyMap.events.map((event) => [event.id, event.id]),
    );

    const scores = impactPlans.map((plan) =>
      scoreFixtureImpactPlan({ expected: plan, candidate: plan, eventIdMap }),
    );

    expect(scores.every((score) => score.directImpactHitRate.rate === 1)).toBe(
      true,
    );
    expect(scores.map((score) => score.anchorResult.actualStatuses)).toEqual([
      ["rerouted"],
      ["incompatible"],
      [],
    ]);
    expect(scores.every((score) => score.anchorResult.passed)).toBe(true);
  });

  it("detects a Continuation state patch that restores a removed fact", async () => {
    const { storyMap, continuation } = await loadRippleFixture();
    const currentState = WorldlineDeltaSchema.parse({
      factsAdded: [],
      factsRemoved: ["event:event_07"],
      characterChanges: [],
      threadsOpened: ["顾闻舟如何定位仍持原件的许澄"],
      threadsClosed: [],
    });

    expect(
      scoreContinuationStatePatch({
        patch: continuation.scene.statePatch,
        currentState,
        storyMap,
        divergenceEventId: "event_07",
        protectedAnchorEventIds: ["event_11"],
      }),
    ).toEqual({ contradictionDetected: false, issues: [] });

    const contradiction = structuredClone(continuation.scene.statePatch);
    contradiction.factsAdded.push({
      key: "event:event_07",
      statement: "原交付路径恢复",
    });
    const score = scoreContinuationStatePatch({
      patch: contradiction,
      currentState,
      storyMap,
      divergenceEventId: "event_07",
      protectedAnchorEventIds: ["event_11"],
    });

    expect(score.contradictionDetected).toBe(true);
    expect(score.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("不得恢复已删除事实")]),
    );
  });

  it("turns every M0 quality threshold into an explicit release failure", async () => {
    const { source, storyMap, impactPlans, continuation } =
      await loadRippleFixture();
    const storyMapScore = scoreFixtureStoryMap({
      source,
      golden: storyMap,
      candidate: storyMap,
    });
    const eventIdMap = storyMapScore.eventIdMap;
    const impactScores = impactPlans.map((plan) =>
      scoreFixtureImpactPlan({ expected: plan, candidate: plan, eventIdMap }),
    );
    const continuationScore = scoreContinuationStatePatch({
      patch: continuation.scene.statePatch,
      currentState: WorldlineDeltaSchema.parse({
        factsAdded: [],
        factsRemoved: ["event:event_07"],
        characterChanges: [],
        threadsOpened: ["顾闻舟如何定位仍持原件的许澄"],
        threadsClosed: [],
      }),
      storyMap,
      divergenceEventId: "event_07",
      protectedAnchorEventIds: ["event_11"],
    });

    expect(
      evaluateM0ReleaseGate({ storyMapScore, impactScores, continuationScore }),
    ).toEqual({ passed: true, failures: [] });

    const failed = evaluateM0ReleaseGate({
      storyMapScore: {
        ...storyMapScore,
        evidenceValidity: { matched: 1, total: 2, rate: 0.5 },
      },
      impactScores,
      continuationScore,
    });
    expect(failed.passed).toBe(false);
    expect(failed.failures).toContain("Evidence 有效率低于 100%：50.0%");
  });
});
