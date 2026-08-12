import { describe, expect, it } from "vitest";

import {
  M0LiveEvalFailureReportSchema,
  evaluateM0ReleaseGate,
  scoreContinuationStatePatch,
  scoreFixtureImpactPlan,
  scoreFixtureStoryMap,
} from "@/evals/m0-live-eval";
import { WorldlineDeltaSchema } from "@/domain/schemas";
import { sha256 } from "@/domain/source/normalize-source";
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
      goldenSource: source,
      candidateSource: source,
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

  it("maps all Events when equal Source content is imported under a different Source ID", async () => {
    const { source, storyMap } = await loadRippleFixture();
    const candidateSource = structuredClone(source);
    candidateSource.id = "source_live_eval_candidate_001";
    const candidate = structuredClone(storyMap);
    candidate.sourceId = candidateSource.id;
    for (const reference of [
      ...candidate.events.flatMap((event) => event.evidence),
      ...candidate.edges.flatMap((edge) => edge.evidence),
      ...candidate.endingCandidates.flatMap((ending) => ending.evidence),
    ]) {
      reference.sourceId = candidateSource.id;
    }

    const input = {
      goldenSource: source,
      candidateSource,
      golden: storyMap,
      candidate,
    };
    const score = scoreFixtureStoryMap(input);

    expect(source.id).toBe("source_ripple_001");
    expect(candidate.sourceId).toBe(candidateSource.id);
    expect(candidateSource.id).not.toBe(source.id);
    expect(score.eventRecall).toEqual({ matched: 12, total: 12, rate: 1 });
    expect(Object.keys(score.eventIdMap)).toHaveLength(12);
  });

  it("fails closed when Golden and Candidate Source contentHash values differ", async () => {
    const { source, storyMap } = await loadRippleFixture();
    const candidateSource = structuredClone(source);
    candidateSource.normalizedText = `${candidateSource.normalizedText}\n不同内容`;
    candidateSource.contentHash = sha256(candidateSource.normalizedText);

    const input = {
      goldenSource: source,
      candidateSource,
      golden: storyMap,
      candidate: storyMap,
    };

    expect(() => scoreFixtureStoryMap(input)).toThrow(/contentHash/);
  });

  it("fails closed when the Golden Story Map is invalid for its Source", async () => {
    const { source, storyMap } = await loadRippleFixture();
    const golden = structuredClone(storyMap);
    golden.events[0]!.evidence[0]!.excerptHash = `sha256:${"0".repeat(64)}`;

    const input = {
      goldenSource: source,
      candidateSource: source,
      golden,
      candidate: storyMap,
    };

    expect(() => scoreFixtureStoryMap(input)).toThrow(/Golden Story Map/);
  });

  it("fails closed when the Candidate Story Map binds to the wrong Source ID", async () => {
    const { source, storyMap } = await loadRippleFixture();
    const candidate = structuredClone(storyMap);
    candidate.sourceId = "source_wrong_candidate_binding";

    expect(() =>
      scoreFixtureStoryMap({
        goldenSource: source,
        candidateSource: source,
        golden: storyMap,
        candidate,
      }),
    ).toThrow(/Candidate Story Map.*Source/);
  });

  it("reports missing structure and invalid Evidence instead of guessing", async () => {
    const { source, storyMap } = await loadRippleFixture();
    const candidate = structuredClone(storyMap);
    candidate.events = candidate.events.filter((event) => event.id !== "event_03");
    candidate.edges = candidate.edges.filter(
      (edge) => edge.from !== "event_03" && edge.to !== "event_03",
    );
    candidate.events[0]!.evidence[0]!.excerptHash = `sha256:${"0".repeat(64)}`;

    const score = scoreFixtureStoryMap({
      goldenSource: source,
      candidateSource: source,
      golden: storyMap,
      candidate,
    });

    expect(score.eventRecall.matched).toBe(10);
    expect(score.eventIdMap.event_01).toBeUndefined();
    expect(score.criticalMissingEventIds).toContain("event_03");
    expect(score.evidenceValidity.rate).toBeLessThan(1);
    expect(score.invalidOrHallucinatedEvents).toContainEqual(
      expect.objectContaining({ eventId: "event_01" }),
    );
  });

  it("does not match a Golden Event from a very short Evidence substring and unrelated summary", async () => {
    const { source, storyMap } = await loadRippleFixture();
    const candidate = structuredClone(storyMap);
    const goldenEvidence = storyMap.events[0].evidence[0];
    const shortStart = goldenEvidence.start + 2;
    const shortEnd = shortStart + 4;
    candidate.events[0].summary = "一个与返港完全无关的候选事件";
    candidate.events[0].evidence = [
      {
        ...goldenEvidence,
        start: shortStart,
        end: shortEnd,
        excerptHash: sha256(source.normalizedText.slice(shortStart, shortEnd)),
      },
    ];

    const score = scoreFixtureStoryMap({
      goldenSource: source,
      candidateSource: source,
      golden: storyMap,
      candidate,
    });

    expect(score.eventIdMap.event_01).toBeUndefined();
    expect(score.missingEventIds).toContain("event_01");
    expect(score.unmatchedSourceBackedEventIds).toContain("event_01");
  });

  it("matches normally overlapping wider and narrower Evidence ranges", async () => {
    const { source, storyMap } = await loadRippleFixture();
    const goldenEvidence = storyMap.events[0].evidence[0];

    const widerCandidate = structuredClone(storyMap);
    const widerStart = goldenEvidence.start - 8;
    const widerEnd = goldenEvidence.end + 8;
    widerCandidate.events[0].evidence = [
      {
        ...goldenEvidence,
        start: widerStart,
        end: widerEnd,
        excerptHash: sha256(source.normalizedText.slice(widerStart, widerEnd)),
      },
    ];

    const narrowerCandidate = structuredClone(storyMap);
    const inset = Math.floor((goldenEvidence.end - goldenEvidence.start) / 4);
    const narrowerStart = goldenEvidence.start + inset;
    const narrowerEnd = goldenEvidence.end - inset;
    narrowerCandidate.events[0].evidence = [
      {
        ...goldenEvidence,
        start: narrowerStart,
        end: narrowerEnd,
        excerptHash: sha256(
          source.normalizedText.slice(narrowerStart, narrowerEnd),
        ),
      },
    ];

    const widerScore = scoreFixtureStoryMap({
      goldenSource: source,
      candidateSource: source,
      golden: storyMap,
      candidate: widerCandidate,
    });
    const narrowerScore = scoreFixtureStoryMap({
      goldenSource: source,
      candidateSource: source,
      golden: storyMap,
      candidate: narrowerCandidate,
    });

    expect(widerScore.eventIdMap.event_01).toBe("event_01");
    expect(narrowerScore.eventIdMap.event_01).toBe("event_01");
  });

  it("keeps one-to-one Event mapping stable when candidate order changes", async () => {
    const { source, storyMap } = await loadRippleFixture();
    const candidate = structuredClone(storyMap);
    candidate.events.reverse();

    const score = scoreFixtureStoryMap({
      goldenSource: source,
      candidateSource: source,
      golden: storyMap,
      candidate,
    });

    expect(score.eventIdMap).toEqual(
      Object.fromEntries(storyMap.events.map((event) => [event.id, event.id])),
    );
    expect(new Set(Object.values(score.eventIdMap)).size).toBe(12);
  });

  it("scores required direct impacts and Anchor results structurally", async () => {
    const { storyMap, impactPlans } = await loadRippleFixture();
    const eventIdMap = Object.fromEntries(
      storyMap.events.map((event) => [event.id, event.id]),
    );

    const scores = impactPlans.map((plan) =>
      scoreFixtureImpactPlan({
        expected: plan,
        candidate: plan,
        eventIdMap,
        storyMap,
      }),
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
    expect(scores.every((score) => score.reasonPathContract.passed)).toBe(true);
  });

  it("does not award a direct Impact hit when its reasonPath contract is invalid", async () => {
    const { storyMap, impactPlans } = await loadRippleFixture();
    const eventIdMap = Object.fromEntries(
      storyMap.events.map((event) => [event.id, event.id]),
    );
    const candidate = structuredClone(impactPlans[0]);
    candidate.impacts[0].reasonPath = ["event_07", "event_08"];

    const score = scoreFixtureImpactPlan({
      expected: impactPlans[0],
      candidate,
      eventIdMap,
      storyMap,
    });

    expect(score.directImpactHitRate.rate).toBeLessThan(1);
    expect(score.reasonPathContract.passed).toBe(false);
    expect(score.reasonPathContract.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("affectedEventId")]),
    );
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
      goldenSource: source,
      candidateSource: source,
      golden: storyMap,
      candidate: storyMap,
    });
    const eventIdMap = storyMapScore.eventIdMap;
    const impactScores = impactPlans.map((plan) =>
      scoreFixtureImpactPlan({
        expected: plan,
        candidate: plan,
        eventIdMap,
        storyMap,
      }),
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

    const invalidReasonPath = evaluateM0ReleaseGate({
      storyMapScore,
      impactScores: impactScores.map((score, index) =>
        index === 0
          ? {
              ...score,
              reasonPathContract: {
                passed: false,
                issues: [
                  "impacts.0.reasonPath: reasonPath 的终点必须等于 affectedEventId",
                ],
              },
            }
          : score,
      ),
      continuationScore,
    });
    expect(invalidReasonPath.passed).toBe(false);
    expect(invalidReasonPath.failures).toEqual(
      expect.arrayContaining([expect.stringContaining("reasonPath 合同")]),
    );
  });
});
