import { describe, expect, it } from "vitest";

import { validateStoryMap } from "@/domain/invariants/validate-story-map";
import { sha256 } from "@/domain/source/normalize-source";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";

describe("ripple-001 fixture", () => {
  it("contains the planned benchmark shape", async () => {
    const { source, storyMap, impactPlans } = await loadRippleFixture();

    expect(source.normalizedText.length).toBeGreaterThanOrEqual(8_000);
    expect(source.normalizedText.length).toBeLessThanOrEqual(15_000);
    expect(source.sections).toHaveLength(9);
    expect(storyMap.characters).toHaveLength(5);
    expect(storyMap.events).toHaveLength(12);
    expect(storyMap.edges).toHaveLength(12);
    expect(impactPlans).toHaveLength(3);
    expect(validateStoryMap(storyMap, source)).toEqual([]);
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
});
