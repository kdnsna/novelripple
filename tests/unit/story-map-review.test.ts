import { describe, expect, it } from "vitest";

import { StoryMapArtifactSchema, type StoryMapArtifact } from "@/domain/schemas";
import {
  deriveStoryMapReview,
  summarizeStoryMapReviewOperations,
} from "@/domain/review/derive-story-map-review";
import { deriveStoryMapRefinementState } from "@/domain/review/derive-story-map-refinement";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";

async function createArtifact(): Promise<StoryMapArtifact> {
  const fixture = await loadRippleFixture();
  return StoryMapArtifactSchema.parse({
    id: "artifact_review_1",
    projectId: fixture.source.projectId,
    sourceId: fixture.source.id,
    kind: "story_map",
    schemaVersion: 2,
    version: 1,
    storyMap: fixture.storyMap,
    review: { evidenceConfirmations: [] },
    basedOnArtifactId: null,
    generationRunId: "run_review_1",
    createdAt: "2026-08-13T00:00:00.000Z",
  });
}

describe("derived Story Map review", () => {
  it("orders every explainable risk class without producing a total score", async () => {
    const fixture = await loadRippleFixture();
    const artifact = await createArtifact();
    artifact.storyMap.events[3]!.confidence = 0.7;
    artifact.storyMap.edges[0]!.confidence = 0.6;
    artifact.storyMap.edges[0]!.confirmed = false;
    artifact.storyMap.characters[0]!.aliases = ["阿澄", "修复师"];
    artifact.storyMap.characters[1]!.aliases = ["许澄"];

    const derived = deriveStoryMapReview(artifact, fixture.source);
    const categories = derived.queue.map((item) => item.category);

    expect(categories).toEqual(
      expect.arrayContaining([
        "inference_event",
        "low_confidence_event",
        "low_confidence_edge",
        "alias_rich_character",
        "identity_merge_risk",
        "ending_candidate",
        "high_leverage_divergence",
        "unconfirmed_evidence",
        "validator_advisory",
      ]),
    );
    expect(derived.queue[0]?.category).toBe("inference_event");
    expect(derived.queue.map((item) => item.priority)).toEqual(
      [...derived.queue.map((item) => item.priority)].sort(
        (left, right) => left - right,
      ),
    );
    expect(derived).not.toHaveProperty("score");
    expect(
      derived.queue.find((item) => item.category === "identity_merge_risk")
        ?.reason,
    ).toContain("相同名称或别名");
  });

  it("uses exact normalized aliases and graph reachability deterministically", async () => {
    const fixture = await loadRippleFixture();
    const artifact = await createArtifact();
    artifact.storyMap.characters[0]!.aliases = ["  同 名  "];
    artifact.storyMap.characters[1]!.aliases = ["同 名"];

    const first = deriveStoryMapReview(artifact, fixture.source);
    const second = deriveStoryMapReview(artifact, fixture.source);
    const divergenceItems = first.queue.filter(
      (item) => item.category === "high_leverage_divergence",
    );

    expect(first).toEqual(second);
    expect(divergenceItems).toHaveLength(3);
    expect(divergenceItems[0]).toMatchObject({ targetId: "event_01" });
    expect(divergenceItems[0]?.reason).toMatch(/\d+ 个后续事件/);
    expect(
      first.queue.filter((item) => item.category === "identity_merge_risk"),
    ).toHaveLength(1);

    artifact.storyMap.characters[1]!.aliases = ["同名"];
    expect(
      deriveStoryMapReview(artifact, fixture.source).queue.filter(
        (item) => item.category === "identity_merge_risk",
      ),
    ).toHaveLength(0);
  });

  it("derives a readiness checklist and becomes ready only after required review", async () => {
    const fixture = await loadRippleFixture();
    const artifact = await createArtifact();
    const initial = deriveStoryMapReview(artifact, fixture.source);

    expect(initial.readiness).toMatchObject({
      eventsHaveEvidence: true,
      coreCharactersReviewed: false,
      endingCandidatesReviewed: false,
      noIllegalReferences: true,
      noDanglingEdges: true,
      importantEvidenceReviewed: false,
      readyForRipple: false,
    });
    expect(initial.coreCharacterIds).toEqual(
      expect.arrayContaining(["char_xucheng", "char_guwenzhou"]),
    );

    artifact.review.characterConfirmations = initial.coreCharacterIds;
    artifact.review.endingCandidateConfirmations = artifact.storyMap.endingCandidates.map(
      (ending) => ending.id,
    );
    for (const requirement of initial.importantEvidence) {
      if (requirement.targetKind === "event") {
        artifact.review.evidenceConfirmations.push({
          eventId: requirement.targetId,
          evidence: requirement.evidence,
        });
      } else {
        artifact.review.edgeEvidenceConfirmations.push({
          edgeId: requirement.targetId,
          evidence: requirement.evidence,
        });
      }
    }

    expect(deriveStoryMapReview(artifact, fixture.source).readiness).toEqual({
      eventsHaveEvidence: true,
      coreCharactersReviewed: true,
      endingCandidatesReviewed: true,
      noIllegalReferences: true,
      noDanglingEdges: true,
      importantEvidenceReviewed: true,
      readyForRipple: true,
    });
  });


  it("defaults uncertainEdgeIds for old review rows and treats an uncertain Edge as reviewed", async () => {
    const fixture = await loadRippleFixture();
    const artifact = await createArtifact();
    const parsedOldRow = StoryMapArtifactSchema.parse({
      ...artifact,
      review: { evidenceConfirmations: [] },
    });
    expect(parsedOldRow.review.uncertainEdgeIds).toEqual([]);

    const edge = artifact.storyMap.edges[0]!;
    edge.confidence = 0.6;
    for (const requirement of deriveStoryMapReview(artifact, fixture.source)
      .importantEvidence) {
      if (requirement.targetKind !== "event") continue;
      artifact.review.evidenceConfirmations.push({
        eventId: requirement.targetId,
        evidence: requirement.evidence,
      });
    }
    const before = deriveStoryMapReview(artifact, fixture.source);
    expect(before.readiness.importantEvidenceReviewed).toBe(false);
    expect(
      before.queue.find((item) => item.id === `low_confidence_edge:${edge.id}`)
        ?.status,
    ).toBe("pending");

    artifact.review.uncertainEdgeIds = [edge.id];
    const after = deriveStoryMapReview(artifact, fixture.source);

    expect(after.readiness.importantEvidenceReviewed).toBe(true);
    expect(
      after.queue.find((item) => item.id === `low_confidence_edge:${edge.id}`)
        ?.status,
    ).toBe("reviewed");
    expect(
      after.queue.find((item) => item.id === `uncertain_edge:${edge.id}`),
    ).toMatchObject({
      category: "uncertain_edge",
      targetKind: "edge",
      targetId: edge.id,
      status: "pending",
    });
  });

  it("does not treat dangling or illegal references as reviewable warnings", async () => {
    const fixture = await loadRippleFixture();
    const artifact = await createArtifact();
    artifact.storyMap.edges[0]!.to = "event_missing";
    artifact.storyMap.events[0]!.evidence[0]!.excerptHash = `sha256:${"0".repeat(64)}`;

    const derived = deriveStoryMapReview(artifact, fixture.source);

    expect(derived.readiness.noDanglingEdges).toBe(false);
    expect(derived.readiness.noIllegalReferences).toBe(false);
    expect(derived.readiness.eventsHaveEvidence).toBe(false);
    expect(derived.readiness.readyForRipple).toBe(false);
  });

  it("summarizes lightweight revision operations without source content", async () => {
    const artifact = await createArtifact();
    const revisions = [
      withOperation(artifact, 2, "confirm_character"),
      withOperation(artifact, 3, "merge_characters"),
      withOperation(artifact, 4, "add_event"),
      withOperation(artifact, 5, "confirm_story_map"),
    ];

    expect(summarizeStoryMapReviewOperations(revisions)).toEqual({
      totalOperations: 4,
      materialRevisions: 2,
      manualEventAdditions: 1,
      byType: {
        add_event: 1,
        confirm_character: 1,
        confirm_story_map: 1,
        merge_characters: 1,
      },
    });
  });

  it("derives unrefined quick-confirm badges from the existing review queue", async () => {
    const fixture = await loadRippleFixture();
    const artifact = await createArtifact();
    artifact.storyMap.status = "confirmed";
    artifact.storyMap.events[3]!.confidence = 0.7;
    artifact.storyMap.edges[0]!.confidence = 0.6;
    artifact.review.operation = {
      type: "quick_confirm_story_map",
      timestamp: "2026-08-13T00:00:00.000Z",
      storyMapVersion: 1,
    };

    const derived = deriveStoryMapReview(artifact, fixture.source);
    const refinement = deriveStoryMapRefinementState(artifact, derived);
    const expectedEvents = [
      ...new Set(
        derived.queue
          .filter(
            (item) => item.status === "pending" && item.targetKind === "event",
          )
          .map((item) => item.targetId),
      ),
    ].sort();

    expect(derived.readiness.readyForRipple).toBe(false);
    expect(refinement.quickConfirmed).toBe(true);
    expect(refinement.needsRefinement).toBe(true);
    expect(refinement.eventIds).toEqual(expectedEvents);
    expect(refinement.eventIds).toContain(artifact.storyMap.events[3]!.id);
    expect(refinement.edgeIds).toContain(artifact.storyMap.edges[0]!.id);
    expect(refinement.endingIds).toEqual(
      artifact.storyMap.endingCandidates.map((ending) => ending.id).sort(),
    );
    expect(
      refinement.pendingItems.every(
        (item) => item.status === "pending" && item.targetKind !== "character",
      ),
    ).toBe(true);

    expect(
      deriveStoryMapRefinementState(artifact, {
        ...derived,
        readiness: { ...derived.readiness, readyForRipple: true },
      }).needsRefinement,
    ).toBe(false);
    expect(
      deriveStoryMapRefinementState(
        {
          ...artifact,
          storyMap: { ...artifact.storyMap, status: "draft" },
        },
        derived,
      ).needsRefinement,
    ).toBe(false);

    artifact.review.operation = {
      type: "confirm_story_map",
      timestamp: "2026-08-13T00:00:00.000Z",
      storyMapVersion: 1,
    };
    const normallyConfirmed = deriveStoryMapRefinementState(
      artifact,
      deriveStoryMapReview(artifact, fixture.source),
    );
    expect(normallyConfirmed.quickConfirmed).toBe(false);
    // “未精修”只看 confirmed + readiness，不依赖最新 operation type；
    // 仓库的正常确认要求 readiness，这里人为构造的未就绪 confirmed 仍应提示精修。
    expect(normallyConfirmed.needsRefinement).toBe(true);
  });
});

function withOperation(
  base: StoryMapArtifact,
  version: number,
  type: NonNullable<StoryMapArtifact["review"]["operation"]>["type"],
): StoryMapArtifact {
  return {
    ...structuredClone(base),
    id: `artifact_review_${version}`,
    kind: "story_map_revision",
    version,
    storyMap: { ...structuredClone(base.storyMap), version },
    basedOnArtifactId: base.id,
    generationRunId: null,
    review: {
      ...structuredClone(base.review),
      operation: {
        type,
        timestamp: `2026-08-13T00:00:0${version}.000Z`,
        storyMapVersion: version,
      },
    },
  };
}
