import { describe, expect, it } from "vitest";

import { deriveImpactPlanComparison } from "@/domain/ripple/derive-impact-plan-comparison";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";

describe("Impact Plan comparison", () => {
  it("derives ordered Canon path and grouped changes without storing another fact", async () => {
    const fixture = await loadRippleFixture();
    const plan = fixture.impactPlans[0];

    const comparison = deriveImpactPlanComparison(
      fixture.storyMap,
      plan,
    );

    expect(comparison.originalPath.map((event) => event.eventId)).toEqual([
      "event_06",
      "event_07",
      "event_08",
      "event_09",
      "event_10",
      "event_11",
    ]);
    expect(comparison.newPath).toEqual(
      plan.impacts.map((impact) => ({
        impactId: impact.id,
        summary: impact.summary,
      })),
    );
    for (const changeType of [
      "removed",
      "modified",
      "added",
      "preserved",
    ] as const) {
      expect(comparison.changes[changeType]).toEqual(
        plan.impacts
          .filter((impact) => impact.changeType === changeType)
          .map((impact) => ({
            impactId: impact.id,
            summary: impact.summary,
            affectedEventId: impact.affectedEventId,
          })),
      );
    }
  });
});
