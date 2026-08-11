import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  validateImpactPlan,
  validateStoryMap,
} from "@/domain/invariants/validate-story-map";
import { DivergenceSchema } from "@/domain/schemas";
import { sha256 } from "@/domain/source/normalize-source";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";

describe("ripple-001 fixture", () => {
  it("contains the planned benchmark shape", async () => {
    const { source, storyMap, impactPlans, continuation } =
      await loadRippleFixture();

    const hanCharacterCount =
      source.normalizedText.match(/\p{Script=Han}/gu)?.length ?? 0;

    expect(hanCharacterCount).toBeGreaterThanOrEqual(8_000);
    expect(hanCharacterCount).toBeLessThanOrEqual(12_000);
    expect(source.normalizedText.length).toBeLessThanOrEqual(15_000);
    expect(source.sections).toHaveLength(9);
    expect(storyMap.characters).toHaveLength(5);
    expect(storyMap.events).toHaveLength(12);
    expect(storyMap.edges).toHaveLength(12);
    expect(impactPlans).toHaveLength(3);
    expect(continuation.directions.directions).toHaveLength(3);
    expect(continuation.scene.statePatch.factsAdded).toHaveLength(1);
    expect(continuation.scene.statePatch.factsAdded[0]?.key).not.toBe(
      "event:event_07",
    );
    expect(validateStoryMap(storyMap, source)).toEqual([]);
    expect(
      impactPlans.flatMap((plan) => validateImpactPlan(plan, storyMap)),
    ).toEqual([]);
  });

  it("loads one prevent, choice, and outcome divergence from two meaningful nodes", async () => {
    const fixture = await loadRippleFixture();
    const divergences = z
      .array(DivergenceSchema)
      .parse("divergences" in fixture ? fixture.divergences : []);

    expect(fixture).toHaveProperty("divergences");
    expect(divergences.map((divergence) => divergence.type)).toEqual([
      "prevent",
      "choice",
      "outcome",
    ]);
    expect(new Set(divergences.map((divergence) => divergence.eventId))).toEqual(
      new Set(["event_07", "event_09"]),
    );
    expect(fixture.impactPlans.map((plan) => plan.divergence)).toEqual(
      divergences,
    );
  });

  it("resolves every evidence reference to the declared source and hash", async () => {
    const { source, storyMap } = await loadRippleFixture();
    const references = [
      ...storyMap.events.flatMap((event) => event.evidence),
      ...storyMap.edges.flatMap((edge) => edge.evidence),
      ...storyMap.endingCandidates.flatMap((ending) => ending.evidence),
    ];

    expect(references.length).toBeGreaterThan(30);
    for (const reference of references) {
      const excerpt = source.normalizedText.slice(reference.start, reference.end);
      expect(reference.sourceId).toBe(source.id);
      expect(sha256(excerpt)).toBe(reference.excerptHash);
    }
  });

  it("marks the planned strict-mode outcomes correctly", async () => {
    const { impactPlans } = await loadRippleFixture();

    expect(impactPlans[0].anchorEvaluations[0].status).toBe("rerouted");
    expect(impactPlans[1].anchorEvaluations[0].status).toBe("incompatible");
    expect(impactPlans[2].anchors).toEqual([]);
  });

  it("defines model-independent acceptance and failure boundaries", async () => {
    const rubric = await readFile(
      path.join(process.cwd(), "fixtures", "ripple-001", "rubric.md"),
      "utf8",
    );

    for (const heading of [
      "## 必须命中",
      "## 合理变体",
      "## 严重错误",
      "## Hallucination 判定",
      "## 无证据事件判定",
      "## Continuation 恢复已删除事实判定",
    ]) {
      expect(rubric).toContain(heading);
    }
    expect(rubric).toContain("人工 Golden Fixture");
    expect(rubric).toContain("不依赖任何具体模型");
  });
});
