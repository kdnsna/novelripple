import { describe, expect, it } from "vitest";

import { classifyStoryMapEdges } from "@/domain/ripple/classify-causal-edges";
import { deriveUncertainImpactIds } from "@/domain/ripple/derive-uncertain-impact-ids";
import {
  StoryMapArtifactSchema,
  type StoryEdge,
  type StoryMap,
  type StoryMapArtifact,
} from "@/domain/schemas";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";

function buildArtifact(input: {
  storyMap: StoryMap;
  edges: StoryEdge[];
  uncertainEdgeIds?: string[];
  confirmedEdgeEvidenceIds?: string[];
}): StoryMapArtifact {
  const edgeEvidenceConfirmations = input.edges
    .filter((edge) =>
      (input.confirmedEdgeEvidenceIds ?? []).includes(edge.id),
    )
    .flatMap((edge) =>
      edge.evidence.map((evidence) => ({
        edgeId: edge.id,
        evidence,
      })),
    );

  return StoryMapArtifactSchema.parse({
    id: "artifact_story_map_uncertain_test",
    projectId: "project_uncertain_test",
    sourceId: input.storyMap.sourceId,
    kind: "story_map",
    schemaVersion: 2,
    version: 1,
    storyMap: {
      ...input.storyMap,
      id: "story_map_uncertain_test",
      version: 1,
      status: "confirmed",
      edges: input.edges,
    },
    review: {
      evidenceConfirmations: [],
      edgeEvidenceConfirmations,
      characterConfirmations: [],
      endingCandidateConfirmations: [],
      uncertainEdgeIds: input.uncertainEdgeIds ?? [],
      operation: null,
    },
    basedOnArtifactId: null,
    generationRunId: null,
    createdAt: "2026-08-13T00:00:00.000Z",
  });
}

describe("classifyStoryMapEdges", () => {
  it("marks reader-marked edges as uncertain and keeps the rest established", async () => {
    const { storyMap } = await loadRippleFixture();
    const markedId = "edge_07_08";
    const artifact = buildArtifact({
      storyMap,
      edges: storyMap.edges,
      uncertainEdgeIds: [markedId],
    });

    const classification = classifyStoryMapEdges(artifact);

    expect(classification.uncertain).toHaveLength(1);
    expect(classification.uncertain[0]).toMatchObject({
      edge: { id: markedId },
      reason: "marked_uncertain",
    });
    expect(
      classification.established.map((edge) => edge.id),
    ).toEqual(
      storyMap.edges
        .filter((edge) => edge.id !== markedId)
        .map((edge) => edge.id),
    );
  });

  it("treats below-threshold edges without confirmed evidence as uncertain", async () => {
    const { storyMap } = await loadRippleFixture();
    const low = {
      ...storyMap.edges[0]!,
      id: "edge_low_unreviewed",
      confidence: 0.4,
      confirmed: false,
    };
    const artifact = buildArtifact({
      storyMap,
      edges: [...storyMap.edges, low],
    });

    const classification = classifyStoryMapEdges(artifact);
    const uncertain = classification.uncertain.find(
      (item) => item.edge.id === low.id,
    );

    expect(uncertain).toMatchObject({
      edge: { id: low.id, confidence: 0.4 },
      reason: "unreviewed_low_confidence",
    });
    expect(
      classification.established.some((edge) => edge.id === low.id),
    ).toBe(false);
  });

  it("keeps a below-threshold edge established once all its evidence is confirmed", async () => {
    const { storyMap } = await loadRippleFixture();
    const low = {
      ...storyMap.edges[0]!,
      id: "edge_low_confirmed",
      confidence: 0.4,
      confirmed: false,
    };
    const artifact = buildArtifact({
      storyMap,
      edges: [...storyMap.edges, low],
      confirmedEdgeEvidenceIds: [low.id],
    });

    const classification = classifyStoryMapEdges(artifact);

    expect(
      classification.established.some((edge) => edge.id === low.id),
    ).toBe(true);
    expect(
      classification.uncertain.some((item) => item.edge.id === low.id),
    ).toBe(false);
  });

  it("gives the explicit uncertain mark precedence over low confidence", async () => {
    const { storyMap } = await loadRippleFixture();
    const low = {
      ...storyMap.edges[0]!,
      id: "edge_low_marked",
      confidence: 0.2,
      confirmed: false,
    };
    const artifact = buildArtifact({
      storyMap,
      edges: [...storyMap.edges, low],
      uncertainEdgeIds: [low.id],
    });

    const classification = classifyStoryMapEdges(artifact);

    expect(
      classification.uncertain.find((item) => item.edge.id === low.id),
    ).toMatchObject({ reason: "marked_uncertain" });
  });

  it("is deterministic for the same artifact", async () => {
    const { storyMap } = await loadRippleFixture();
    const artifact = buildArtifact({
      storyMap,
      edges: storyMap.edges,
      uncertainEdgeIds: ["edge_07_08", "edge_02_03"],
    });

    expect(classifyStoryMapEdges(artifact)).toEqual(
      classifyStoryMapEdges(artifact),
    );
  });
});

describe("deriveUncertainImpactIds", () => {
  const edges = [
    { id: "edge_a_b", from: "event_a", to: "event_b" },
    { id: "edge_b_c", from: "event_b", to: "event_c" },
    { id: "edge_c_d", from: "event_c", to: "event_d" },
  ];

  it("marks only impacts whose whole reasonPath is uncertain edges", () => {
    const ids = deriveUncertainImpactIds({
      impacts: [
        { id: "impact_uncertain", reasonPath: ["event_a", "event_b"] },
        { id: "impact_established", reasonPath: ["event_a", "event_b", "event_c"] },
        { id: "impact_direct", reasonPath: ["event_a"] },
        { id: "impact_unmapped", reasonPath: ["event_a", "event_c"] },
      ],
      edges,
      uncertainEdgeIds: ["edge_a_b"],
    });

    expect(ids).toEqual(["impact_uncertain"]);
  });

  it("does not mark a path that is missing an edge or has an established step", () => {
    expect(
      deriveUncertainImpactIds({
        impacts: [
          { id: "impact_missing", reasonPath: ["event_a", "event_c"] },
          { id: "impact_mixed", reasonPath: ["event_a", "event_b", "event_c"] },
        ],
        edges,
        uncertainEdgeIds: ["edge_a_b"],
      }),
    ).toEqual([]);
  });

  it("is deterministic and keeps impact order", () => {
    const input = {
      impacts: [
        { id: "impact_1", reasonPath: ["event_a", "event_b"] },
        { id: "impact_2", reasonPath: ["event_b", "event_c"] },
      ],
      edges,
      uncertainEdgeIds: ["edge_a_b", "edge_b_c"],
    };
    expect(deriveUncertainImpactIds(input)).toEqual(["impact_1", "impact_2"]);
    expect(deriveUncertainImpactIds(input)).toEqual(["impact_1", "impact_2"]);
  });
});
