import { describe, expect, it } from "vitest";

import { M1GoldSchema, parseM1Gold } from "@/evals/m1-gold";

function evidence(unit: number) {
  return {
    unit,
    unitId: `u${String(unit).padStart(6, "0")}`,
    section: 1,
    quote: "用于测试的虚构引文",
    start: 0,
    end: 4,
  };
}

function createGold() {
  return {
    schemaVersion: 1,
    storyId: "m1-x",
    characters: [
      {
        id: "hero",
        name: "甲",
        aliases: ["阿甲"],
        tier: "core",
        evidence: [evidence(2)],
      },
    ],
    mentionedOnly: [{ name: "路人丙", evidence: [evidence(9)] }],
    events: [
      {
        id: "ev_1",
        label: "测试事件一",
        storyOrder: 1,
        narrativeMode: "scene",
        characterIds: ["hero"],
        narrativeFirstUnit: 4,
        evidence: [evidence(4)],
      },
      {
        id: "ev_2",
        label: "测试事件二",
        storyOrder: 2,
        narrativeMode: "scene",
        characterIds: ["hero"],
        narrativeFirstUnit: 6,
        evidence: [evidence(6)],
      },
    ],
    causalLinks: [
      {
        id: "c_1",
        from: "ev_1",
        to: "ev_2",
        strength: "hard",
        label: "测试因果",
        evidence: [evidence(4)],
      },
    ],
    endings: [
      {
        id: "end_1",
        label: "测试结局",
        interpretive: false,
        characterIds: ["hero"],
        evidence: [evidence(8)],
      },
    ],
  };
}

describe("M1 private gold schema", () => {
  it("accepts the documented format and ignores unknown top-level keys", () => {
    const gold = parseM1Gold({
      ...createGold(),
      extraTopLevel: { ignored: true },
    });

    expect(gold.storyId).toBe("m1-x");
    expect(gold.characters[0]?.tier).toBe("core");
    expect(gold.causalLinks[0]?.strength).toBe("hard");
    expect((gold as Record<string, unknown>).extraTopLevel).toEqual({
      ignored: true,
    });
  });

  it("rejects malformed evidence, tier and strength values", () => {
    const shortRange = createGold();
    shortRange.characters[0]!.evidence[0]!.start = 4;
    shortRange.characters[0]!.evidence[0]!.end = 4;
    expect(() => parseM1Gold(shortRange)).toThrow();

    const badUnitId = createGold();
    badUnitId.events[0]!.evidence[0]!.unitId = "u000009";
    expect(() => parseM1Gold(badUnitId)).toThrow();

    const badTier = createGold();
    (badTier.characters[0] as { tier: string }).tier = "extra";
    expect(() => parseM1Gold(badTier)).toThrow();

    const badStrength = createGold();
    (badStrength.causalLinks[0] as { strength: string }).strength = "maybe";
    expect(() => parseM1Gold(badStrength)).toThrow();
  });

  it("rejects dangling references and duplicate IDs", () => {
    const danglingEvent = createGold();
    danglingEvent.causalLinks[0]!.to = "missing_event";
    expect(() => parseM1Gold(danglingEvent)).toThrow(/missing_event/);

    const danglingCharacter = createGold();
    danglingCharacter.events[0]!.characterIds = ["missing_character"];
    expect(() => parseM1Gold(danglingCharacter)).toThrow(/missing_character/);

    const duplicateEvent = createGold();
    duplicateEvent.events[1]!.id = duplicateEvent.events[0]!.id;
    expect(() => parseM1Gold(duplicateEvent)).toThrow(/不得重复/);
  });

  it("rejects a missing schema version", () => {
    const withoutVersion = createGold() as Record<string, unknown>;
    delete withoutVersion.schemaVersion;

    expect(M1GoldSchema.safeParse(withoutVersion).success).toBe(false);
  });
});
