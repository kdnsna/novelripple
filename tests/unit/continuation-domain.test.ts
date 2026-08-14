import { describe, expect, it } from "vitest";

import {
  ContinuationDirectionsModelOutputSchema,
  ContinuationSceneModelOutputSchema,
  StoryMapArtifactSchema,
  type ContinuationDirectionsModelOutput,
  type ContinuationSceneModelOutput,
} from "@/domain/schemas";
import {
  deriveWorldlineDelta,
  validateContinuationDirections,
  validateContinuationStatePatch,
} from "@/domain/invariants/validate-continuation";
import { createWorldline } from "@/domain/services/create-worldline";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import { M1_06_LONG_SCENE_PROSE } from "../helpers/continuation-scene-fixtures";

async function createStrictReroutedState() {
  const fixture = await loadRippleFixture();
  const storyMapArtifact = StoryMapArtifactSchema.parse({
    id: "artifact_story_map_ripple_001_confirmed",
    projectId: "project_ripple_001",
    sourceId: fixture.storyMap.sourceId,
    kind: "story_map_revision",
    schemaVersion: 2,
    version: 2,
    storyMap: { ...fixture.storyMap, version: 2, status: "confirmed" },
    review: { evidenceConfirmations: [] },
    basedOnArtifactId: "artifact_story_map_ripple_001_draft",
    generationRunId: null,
    createdAt: "2026-08-11T00:00:00.000Z",
  });
  const acceptedImpactPlan = {
    ...fixture.impactPlans[0],
    id: "artifact_impact_plan_accepted",
    storyMapId: storyMapArtifact.storyMap.id,
    status: "accepted" as const,
  };
  const worldline = createWorldline({
    projectId: storyMapArtifact.projectId,
    parentWorldlineId: "wl_canonical",
    baseStoryMapArtifact: storyMapArtifact,
    impactPlan: acceptedImpactPlan,
    mode: "strict",
    createdAt: "2026-08-11T01:00:00.000Z",
  });
  const delta = deriveWorldlineDelta({
    worldline,
    impactPlan: acceptedImpactPlan,
    storyMap: storyMapArtifact.storyMap,
  });

  return { fixture, storyMapArtifact, acceptedImpactPlan, worldline, delta };
}

function validDirections(): ContinuationDirectionsModelOutput {
  return {
    directions: [
      {
        title: "钟楼守证",
        premise: "许澄留在钟楼保护仍由自己保管的红账原件。",
        affectedCharacterIds: ["char_xucheng", "char_shenyan"],
        expectedConsequence: "顾闻舟的控制目标转向钟楼。",
      },
      {
        title: "分散见证",
        premise: "周岚不接触原件，转而寻找多名独立见证人。",
        affectedCharacterIds: ["char_xucheng", "char_zhoulan"],
        expectedConsequence: "公开路径变慢，但证据风险得到分散。",
      },
      {
        title: "风暴直送",
        premise: "许澄尝试在风暴封路前亲自把原件送出岛。",
        affectedCharacterIds: ["char_xucheng", "char_guwenzhou"],
        expectedConsequence: "原件保管和人员安全形成直接冲突。",
      },
    ],
  };
}

function validScene(): ContinuationSceneModelOutput {
  return {
    title: "钟楼里的第二份记录",
    prose: M1_06_LONG_SCENE_PROSE,
    statePatch: {
      factsAdded: [
        {
          key: "generated:clocktower-offline-record",
          statement: "许澄与沈砚在钟楼建立了红账的离线见证记录",
        },
      ],
      factsRemoved: [],
      characterChanges: [
        {
          characterId: "char_xucheng",
          summary: "许澄开始用多方校验降低独自保管原件的风险",
        },
      ],
      threadsOpened: ["顾闻舟抵达钟楼后的直接对峙"],
      threadsClosed: [],
    },
  };
}

describe("Continuation domain", () => {
  it("rejects scene prose below the M1-06 1200-character floor and accepts above it", async () => {
    const { fixture } = await createStrictReroutedState();
    expect(
      ContinuationSceneModelOutputSchema.safeParse({
        ...validScene(),
        prose: "太短。".repeat(300),
      }).success,
    ).toBe(false);
    const longEnough = "风".repeat(1_200);
    const parsed = ContinuationSceneModelOutputSchema.parse({
      ...validScene(),
      prose: longEnough,
    });
    expect(parsed.prose).toHaveLength(1_200);
    expect(fixture.storyMap.id).toBeTruthy();
  });

  it("derives a baseline-plus-delta state without copying the Canon Story Map", async () => {
    const { delta } = await createStrictReroutedState();

    expect(delta.factsRemoved).toEqual(
      expect.arrayContaining([
        "event:event_07",
        "event:event_08",
        "event:event_09",
        "event:event_11",
      ]),
    );
    expect(delta.factsAdded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "impact:impact_02",
          statement: "顾闻舟会把目标从周岚转向仍持有原件的许澄",
        }),
      ]),
    );
    expect(delta.characterChanges).toHaveLength(2);
    expect(delta.threadsOpened).toEqual(["顾闻舟如何定位仍持原件的许澄"]);
    expect(delta.threadsClosed).toEqual(["周岚移交途中被拦截"]);
    expect(delta).not.toHaveProperty("events");
    expect(delta).not.toHaveProperty("storyMap");
  });

  it("requires exactly three directions and known affected characters", async () => {
    const { fixture } = await createStrictReroutedState();
    const directions = validDirections();

    expect(ContinuationDirectionsModelOutputSchema.parse(directions).directions).toHaveLength(3);
    expect(validateContinuationDirections(directions, fixture.storyMap)).toEqual([]);
    expect(
      ContinuationDirectionsModelOutputSchema.safeParse({
        directions: directions.directions.slice(0, 2),
      }).success,
    ).toBe(false);

    const unknownCharacter = structuredClone(directions);
    unknownCharacter.directions[0].affectedCharacterIds = ["char_missing"];
    expect(validateContinuationDirections(unknownCharacter, fixture.storyMap)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining("affectedCharacterIds") }),
      ]),
    );
  });

  it("rejects a Scene state patch that restores a removed fact", async () => {
    const { fixture, delta } = await createStrictReroutedState();
    const scene = ContinuationSceneModelOutputSchema.parse(validScene());

    expect(
      validateContinuationStatePatch(
        scene.statePatch,
        delta,
        fixture.storyMap,
        "event_07",
        ["event_11"],
      ),
    ).toEqual([]);

    const restored = structuredClone(scene.statePatch);
    restored.factsAdded.push({
      key: "event:event_07",
      statement: "许澄已经把红色账簿交给周岚",
    });
    expect(
      validateContinuationStatePatch(
        restored,
        delta,
        fixture.storyMap,
        "event_07",
        ["event_11"],
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("已删除事实") }),
      ]),
    );
  });

  it("rejects a Scene state patch that deletes a pre-divergence Canon fact", async () => {
    const { fixture, delta } = await createStrictReroutedState();
    const patch = structuredClone(validScene().statePatch);
    patch.factsRemoved = ["event:event_01"];

    expect(
      validateContinuationStatePatch(
        patch,
        delta,
        fixture.storyMap,
        "event_07",
        ["event_11"],
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("分歧前 Canon 事实"),
        }),
      ]),
    );
  });

  it("rejects new facts that occupy the Canon namespace", async () => {
    const { fixture, delta } = await createStrictReroutedState();
    const patch = structuredClone(validScene().statePatch);
    patch.factsAdded.push({
      key: "event:event_01",
      statement: "用新场景重复声明 Canon 事件",
    });

    expect(
      validateContinuationStatePatch(
        patch,
        delta,
        fixture.storyMap,
        "event_07",
        ["event_11"],
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("generated:") }),
      ]),
    );
  });

  it("rejects deleting accepted Delta facts or protected Anchor targets", async () => {
    const { fixture, delta } = await createStrictReroutedState();
    const deltaPatch = structuredClone(validScene().statePatch);
    deltaPatch.factsRemoved = ["impact:impact_02"];
    expect(
      validateContinuationStatePatch(
        deltaPatch,
        delta,
        fixture.storyMap,
        "event_07",
        ["event_12"],
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("Worldline Delta") }),
      ]),
    );

    const anchorPatch = structuredClone(validScene().statePatch);
    anchorPatch.factsRemoved = ["event:event_12"];
    expect(
      validateContinuationStatePatch(
        anchorPatch,
        delta,
        fixture.storyMap,
        "event_07",
        ["event_12"],
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("Anchor") }),
      ]),
    );
  });

  it("rejects unknown character and impossible thread transitions in a Scene", async () => {
    const { fixture, delta } = await createStrictReroutedState();
    const patch = structuredClone(validScene().statePatch);
    patch.characterChanges[0].characterId = "char_missing";
    patch.threadsClosed = ["从未开启的线索"];

    expect(
      validateContinuationStatePatch(
        patch,
        delta,
        fixture.storyMap,
        "event_07",
        ["event_11"],
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("未知人物") }),
        expect.objectContaining({ message: expect.stringContaining("尚未开启") }),
      ]),
    );
  });
});
