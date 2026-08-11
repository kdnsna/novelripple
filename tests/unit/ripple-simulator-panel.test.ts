import { describe, expect, it } from "vitest";

import { mapAnchorEvaluationRows } from "@/components/story-workspace/ripple-simulator-panel";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";

describe("Ripple Preview Anchor presentation", () => {
  it("maps each of multiple evaluations to its own ending requirement", async () => {
    const { impactPlans } = await loadRippleFixture();
    const first = impactPlans[0];
    const second = impactPlans[1];
    const plan = {
      ...first,
      anchors: [first.anchors[0], second.anchors[0]],
      anchorEvaluations: [
        first.anchorEvaluations[0],
        second.anchorEvaluations[0],
      ],
    };

    expect(mapAnchorEvaluationRows(plan)).toEqual([
      expect.objectContaining({
        requirement: "白鸥号沉船事故的系统性真相最终进入公共记录",
        status: "rerouted",
      }),
      expect.objectContaining({
        requirement: "红色账簿原件最终进入市档案馆",
        status: "incompatible",
      }),
    ]);
  });
});
