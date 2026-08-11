import { describe, expect, it } from "vitest";

import { createWorldline } from "@/domain/services/create-worldline";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";

const baseInput = {
  projectId: "project_ripple_001",
  parentWorldlineId: "wl_ripple_001_canonical",
  baseStoryMapArtifactId: "artifact_story_map_ripple_001_v1",
  createdAt: "2026-08-11T02:00:00.000Z",
} as const;

describe("createWorldline", () => {
  it("does not create formal state from an unaccepted impact plan", async () => {
    const { impactPlans } = await loadRippleFixture();

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
    expect(first.acceptedImpactPlanId).toBe(acceptedPlan.id);
    expect(impactPlans[0].status).toBe("candidate");
  });

  it("fails closed when a hard strict-mode anchor is incompatible", async () => {
    const { impactPlans } = await loadRippleFixture();
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

  it("allows the same causal proposal in open mode without carrying anchors", async () => {
    const { impactPlans } = await loadRippleFixture();
    const incompatiblePlan = {
      ...impactPlans[1],
      status: "accepted" as const,
    };

    const worldline = createWorldline({
      ...baseInput,
      impactPlan: incompatiblePlan,
      mode: "open",
    });

    expect(worldline.mode).toBe("open");
    expect(worldline.anchors).toEqual([]);
  });
});
