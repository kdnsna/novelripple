import { describe, expect, it } from "vitest";

import {
  countUncertainRelations,
  mapAnchorEvaluationRows,
  suggestionsRefreshState,
  summarizeImpactScope,
  summarizePlainAnchorStatus,
} from "@/components/story-workspace/ripple-simulator-panel";
import { isUncertainImpact } from "@/domain/ripple/derive-uncertain-impact-ids";
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

  it("summarizes the first impact per scope and the worst Anchor status", async () => {
    const { impactPlans } = await loadRippleFixture();
    const first = impactPlans[0]!;
    const second = impactPlans[1]!;

    expect(summarizeImpactScope(first, "direct")).toContain(
      first.impacts.find((impact) => impact.scope === "direct")!.summary,
    );
    expect(summarizePlainAnchorStatus(first)).toBe("原结局保住了 · 改道");
    expect(
      summarizePlainAnchorStatus({
        ...first,
        anchors: [first.anchors[0]!, second.anchors[0]!],
        anchorEvaluations: [
          first.anchorEvaluations[0]!,
          second.anchorEvaluations[0]!,
        ],
      }),
    ).toBe("2 个结局 · 原结局无法保留");
  });

  it("keeps uncertainty annotations optional and presents flagged impacts as possibilities", async () => {
    const { impactPlans } = await loadRippleFixture();
    const plan = impactPlans[0]!;

    expect(countUncertainRelations(plan)).toBe(0);
    expect(isUncertainImpact(plan, plan.impacts[0]!.id)).toBe(false);

    const annotated = {
      ...plan,
      uncertainEdgeIds: ["edge_07_08", "edge_11_12"],
      uncertainImpactIds: [plan.impacts[0]!.id],
      usedUncertainEdgeIds: ["edge_07_08"],
    };
    expect(countUncertainRelations(annotated)).toBe(1);
    expect(isUncertainImpact(annotated, plan.impacts[0]!.id)).toBe(true);
    expect(summarizeImpactScope(annotated, "direct")).toContain("可能：");
    // 旧 Artifact 没有 usedUncertainEdgeIds 时回退到旧字段。
    const legacy = {
      ...plan,
      uncertainEdgeIds: ["edge_07_08"],
    };
    expect(countUncertainRelations(legacy)).toBe(1);
  });

  it("distinguishes batch-limit and model-call-limit refresh hints", () => {
    expect(
      suggestionsRefreshState({ batchCount: 1, batchLimit: 2, error: null }),
    ).toEqual({ canRefresh: true, hint: null });
    expect(
      suggestionsRefreshState({
        batchCount: 2,
        batchLimit: 2,
        error: null,
      }),
    ).toEqual({
      canRefresh: false,
      hint: "已达到本 revision 的换一批上限（2 批）",
    });
    expect(
      suggestionsRefreshState({
        batchCount: 1,
        batchLimit: 2,
        error:
          "Ripple Suggestions 已达到本 Story Map revision 的模型调用上限（最多 12 次，含失败与重试）",
      }),
    ).toEqual({
      canRefresh: false,
      hint: "本 revision 的模型调用次数已达上限，可继续使用已有建议",
    });
  });
});
