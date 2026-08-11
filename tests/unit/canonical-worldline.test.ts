import { describe, expect, it } from "vitest";

import {
  WorldlineSchema,
  type StoryMapArtifact,
  type Worldline,
} from "@/domain/schemas";
import * as worldlineServices from "@/domain/services/create-worldline";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";

describe("read-only Canonical Worldline context", () => {
  it("derives a deterministic Canonical context without persistence", async () => {
    const createCanonicalWorldline = Reflect.get(
      worldlineServices,
      "createCanonicalWorldline",
    ) as
      | ((input: {
          projectId: string;
          baseStoryMapArtifact: StoryMapArtifact;
          createdAt?: string;
        }) => Worldline)
      | undefined;

    expect(createCanonicalWorldline).toBeDefined();
    if (!createCanonicalWorldline) return;

    const { storyMap } = await loadRippleFixture();
    const artifact = {
      id: "artifact_story_map_ripple_001_v1",
      projectId: "project_ripple_001",
      sourceId: storyMap.sourceId,
      kind: "story_map",
      schemaVersion: 2,
      version: storyMap.version,
      storyMap,
      review: { evidenceConfirmations: [] },
      basedOnArtifactId: null,
      generationRunId: null,
      createdAt: "2026-08-11T00:00:00.000Z",
    } satisfies StoryMapArtifact;

    const first = createCanonicalWorldline({
      projectId: artifact.projectId,
      baseStoryMapArtifact: artifact,
      createdAt: artifact.createdAt,
    });
    const repeated = createCanonicalWorldline({
      projectId: artifact.projectId,
      baseStoryMapArtifact: artifact,
      createdAt: "2026-08-11T01:00:00.000Z",
    });

    expect(first).toMatchObject({
      projectId: artifact.projectId,
      parentWorldlineId: null,
      baseStoryMapArtifactId: artifact.id,
      divergence: null,
      mode: "open",
      anchors: [],
      acceptedImpactPlanId: null,
      status: "canonical",
    });
    expect(repeated.id).toBe(first.id);
    expect(repeated.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("refuses to derive Canonical context from a draft Story Map", async () => {
    const createCanonicalWorldline = Reflect.get(
      worldlineServices,
      "createCanonicalWorldline",
    ) as
      | ((input: {
          projectId: string;
          baseStoryMapArtifact: StoryMapArtifact;
        }) => Worldline)
      | undefined;
    expect(createCanonicalWorldline).toBeDefined();
    if (!createCanonicalWorldline) return;

    const { storyMap } = await loadRippleFixture();
    const artifact = {
      id: "artifact_story_map_draft",
      projectId: "project_ripple_001",
      sourceId: storyMap.sourceId,
      kind: "story_map",
      schemaVersion: 2,
      version: storyMap.version,
      storyMap: { ...storyMap, status: "draft" },
      review: { evidenceConfirmations: [] },
      basedOnArtifactId: null,
      generationRunId: null,
      createdAt: "2026-08-11T00:00:00.000Z",
    } satisfies StoryMapArtifact;

    expect(() =>
      createCanonicalWorldline({
        projectId: artifact.projectId,
        baseStoryMapArtifact: artifact,
      }),
    ).toThrow("Story Map 必须先由用户确认");
  });

  it("rejects Canonical rows that carry derived worldline state", () => {
    const result = WorldlineSchema.safeParse({
      id: "wl_invalid_canonical",
      projectId: "project_ripple_001",
      parentWorldlineId: null,
      baseStoryMapArtifactId: "artifact_story_map_ripple_001_v1",
      divergence: null,
      mode: "strict",
      anchors: [
        {
          id: "anchor_ending",
          targetEventId: "event_12",
          requirement: "结局成立",
          strength: "hard",
        },
      ],
      acceptedImpactPlanId: "impact_plan_invalid",
      idempotencyKey: "canonical:invalid",
      status: "canonical",
      createdAt: "2026-08-11T00:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });
});
