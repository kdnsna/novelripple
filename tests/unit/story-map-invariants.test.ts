import { describe, expect, it } from "vitest";

import { validateStoryMap } from "@/domain/invariants/validate-story-map";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";

describe("Story Map invariants", () => {
  it("rejects a dangling causal edge", async () => {
    const { source, storyMap } = await loadRippleFixture();
    const invalidMap = structuredClone(storyMap);
    invalidMap.edges[0].to = "event_missing";

    expect(validateStoryMap(invalidMap, source)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("悬空引用") }),
      ]),
    );
  });

  it("rejects an evidence hash that no longer matches the source", async () => {
    const { source, storyMap } = await loadRippleFixture();
    const invalidMap = structuredClone(storyMap);
    invalidMap.events[0].evidence[0].excerptHash = `sha256:${"0".repeat(64)}`;

    expect(validateStoryMap(invalidMap, source)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("Hash") }),
      ]),
    );
  });

  it("rejects evidence offsets outside the immutable Source", async () => {
    const { source, storyMap } = await loadRippleFixture();
    const invalidMap = structuredClone(storyMap);
    invalidMap.events[0].evidence[0].end = source.normalizedText.length + 1;

    expect(validateStoryMap(invalidMap, source)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("边界") }),
      ]),
    );
  });

  it("rejects an event participant that is absent from characters", async () => {
    const { source, storyMap } = await loadRippleFixture();
    const invalidMap = structuredClone(storyMap);
    invalidMap.events[0].participants.push("char_missing");

    expect(validateStoryMap(invalidMap, source)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("未知人物") }),
      ]),
    );
  });
});
