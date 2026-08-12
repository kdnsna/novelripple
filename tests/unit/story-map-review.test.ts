import { describe, expect, it } from "vitest";

import { StoryMapArtifactSchema, type StoryMapArtifact } from "@/domain/schemas";
import {
  deriveStoryMapReview,
  summarizeStoryMapReviewOperations,
} from "@/domain/review/derive-story-map-review";
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
