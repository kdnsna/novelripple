import { describe, expect, it } from "vitest";

import { StoryMapArtifactSchema } from "@/domain/schemas";
import { createWorldline } from "@/domain/services/create-worldline";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";

async function createBaseInput(status: "draft" | "confirmed" = "confirmed") {
  const { storyMap } = await loadRippleFixture();
  const baseStoryMapArtifact = StoryMapArtifactSchema.parse({
    id: "artifact_story_map_ripple_001_v1",
    projectId: "project_ripple_001",
    sourceId: storyMap.sourceId,
    kind: "story_map",
    schemaVersion: 2,
    version: 1,
    storyMap: { ...storyMap, status },
    review: { evidenceConfirmations: [] },
    basedOnArtifactId: null,
    generationRunId: null,
    createdAt: "2026-08-11T00:00:00.000Z",
  });
  return {
    projectId: "project_ripple_001",
    parentWorldlineId: "wl_ripple_001_canonical",
    baseStoryMapArtifact,
    createdAt: "2026-08-11T02:00:00.000Z",
  } as const;
}

describe("createWorldline", () => {
  it("does not create formal state from an unaccepted impact plan", async () => {
    const { impactPlans } = await loadRippleFixture();
    const baseInput = await createBaseInput();

    expect(() =>
      createWorldline({
        ...baseInput,
        impactPlan: impactPlans[0],
        mode: "strict",
      }),
    ).toThrow("必须由用户接受");
  });

  it("creates the same child worldline for a repeated confirmation", async () => {
    const { impactPlans } = await loadRippleFixture();
    const baseInput = await createBaseInput();
    const acceptedPlan = { ...impactPlans[0], status: "accepted" as const };

    const first = createWorldline({
      ...baseInput,
      impactPlan: acceptedPlan,
      mode: "strict",
    });
    const repeated = createWorldline({
      ...baseInput,
      impactPlan: acceptedPlan,
      mode: "strict",
    });

    expect(repeated.id).toBe(first.id);
    expect(repeated.idempotencyKey).toBe(first.idempotencyKey);
    expect(first.parentWorldlineId).toBe(baseInput.parentWorldlineId);
    expect(first.baseStoryMapArtifactId).toBe(baseInput.baseStoryMapArtifact.id);
    expect(first.acceptedImpactPlanId).toBe(acceptedPlan.id);
    expect(impactPlans[0].status).toBe("candidate");
  });

  it("fails closed when a strict-mode anchor is incompatible", async () => {
    const { impactPlans } = await loadRippleFixture();
    const baseInput = await createBaseInput();
    const incompatiblePlan = {
      ...impactPlans[1],
      status: "accepted" as const,
    };

    expect(() =>
      createWorldline({
        ...baseInput,
        impactPlan: incompatiblePlan,
        mode: "strict",
      }),
    ).toThrow("严格模式锚点不兼容");

  });

  it("creates an open-mode worldline without carrying anchors", async () => {
    const { impactPlans } = await loadRippleFixture();
    const baseInput = await createBaseInput();
    const openPlan = {
      ...impactPlans[2],
      status: "accepted" as const,
    };

    const worldline = createWorldline({
      ...baseInput,
      impactPlan: openPlan,
      mode: "open",
    });

    expect(worldline.mode).toBe("open");
    expect(worldline.anchors).toEqual([]);
  });

  it("fails closed when the base Story Map Artifact is still draft", async () => {
    const { impactPlans } = await loadRippleFixture();
    const baseInput = await createBaseInput("draft");
    const acceptedPlan = { ...impactPlans[0], status: "accepted" as const };

    expect(() =>
      createWorldline({
        ...baseInput,
        impactPlan: acceptedPlan,
        mode: "strict",
      }),
    ).toThrow("Story Map 必须先由用户确认");
  });
});
