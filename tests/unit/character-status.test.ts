import { describe, expect, it } from "vitest";

import {
  derivePathCharacterStatuses,
  deriveSourceBaselineStatuses,
} from "@/domain/continuation/character-status";
import {
  buildSceneTree,
  derivePathState,
  getScenePath,
} from "@/domain/continuation/scene-tree";
import {
  derivePathCharacterTimeline,
  resolveReadingPath,
} from "@/domain/continuation/worldline-tree";
import {
  StoryMapSchema,
  WorldlineDeltaSchema,
  type StatePatch,
  type WorldlineCharacterStatusOverride,
} from "@/domain/schemas";
import {
  emptyStatePatch,
  v2SceneFixture,
} from "../helpers/continuation-scene-fixtures";

const reference = {
  sourceId: "source_status_probe",
  sectionId: "section_1",
  start: 0,
  end: 8,
  excerptHash: `sha256:${"a".repeat(64)}`,
};

const storyMap = StoryMapSchema.parse({
  schemaVersion: 1,
  id: "story_map_status_probe",
  sourceId: "source_status_probe",
  version: 1,
  status: "confirmed",
  title: "状态探针",
  logline: "短句构造的人物状态测试",
  characters: [
    {
      id: "character_shen",
      name: "沈砚",
      aliases: ["阿砚"],
      role: "protagonist",
      initialState: "看守灯塔",
    },
    {
      id: "character_gu",
      name: "顾闻舟",
      aliases: [],
      role: "antagonist",
      initialState: "掌握通行权",
    },
    {
      id: "character_zhou",
      name: "周岚",
      aliases: [],
      role: "supporting",
      initialState: "记录证词",
    },
  ],
  events: [
    {
      id: "event_1",
      title: "风浪",
      summary: "风暴前的值守",
      sequence: 1,
      participants: ["character_shen"],
      stateChanges: ["阿砚在风暴中身亡"],
      evidenceKind: "fact",
      evidence: [reference],
    },
    {
      id: "event_2",
      title: "传闻",
      summary: "关于顾闻舟的推断",
      sequence: 2,
      participants: ["character_gu"],
      stateChanges: ["顾闻舟死亡"],
      evidenceKind: "inference",
      confidence: 0.4,
      evidence: [reference],
    },
    {
      id: "event_3",
      title: "否认",
      summary: "顾闻舟没有死",
      sequence: 3,
      participants: ["character_gu"],
      stateChanges: ["顾闻舟没死，只是暂时离开"],
      evidenceKind: "fact",
      evidence: [reference],
    },
    {
      id: "event_4",
      title: "分歧",
      summary: "周岚改变了选择",
      sequence: 4,
      participants: ["character_zhou"],
      stateChanges: ["周岚死亡"],
      evidenceKind: "fact",
      evidence: [reference],
    },
    {
      id: "event_5",
      title: "之后",
      summary: "分歧之后的事件",
      sequence: 5,
      participants: ["character_zhou"],
      stateChanges: ["周岚死亡"],
      evidenceKind: "fact",
      evidence: [reference],
    },
    {
      id: "event_6",
      title: "落水",
      summary: "只有一名参与者",
      sequence: 2,
      participants: ["character_zhou"],
      stateChanges: ["落水身亡"],
      evidenceKind: "fact",
      evidence: [reference],
    },
  ],
  edges: [],
  endingCandidates: [
    {
      id: "ending_1",
      targetEventId: "event_4",
      requirement: "保留分歧点",
      evidence: [reference],
    },
  ],
});

const divergence = {
  id: "divergence_test",
  eventId: "event_4",
  type: "prevent" as const,
  instruction: "阻止分歧事件",
};

function baseDelta() {
  return WorldlineDeltaSchema.parse(emptyStatePatch());
}

function characterPatch(
  ...changes: Array<{
    characterId: string;
    summary: string;
    status?: "alive" | "dead" | "absent" | "unknown" | null;
  }>
): StatePatch {
  return { ...emptyStatePatch(), characterChanges: changes };
}

function treeWithStatuses() {
  return buildSceneTree([
    v2SceneFixture({
      id: "scene_1",
      parentSceneId: null,
      depth: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
      statePatch: characterPatch({
        characterId: "character_shen",
        summary: "第一幕：沈砚倒下",
        status: "dead",
      }),
    }),
    v2SceneFixture({
      id: "scene_2",
      parentSceneId: "scene_1",
      depth: 2,
      createdAt: "2026-08-11T00:01:00.000Z",
      statePatch: characterPatch({
        characterId: "character_shen",
        summary: "第二幕：有人提起沈砚",
      }),
    }),
    v2SceneFixture({
      id: "scene_3",
      parentSceneId: "scene_2",
      depth: 3,
      createdAt: "2026-08-11T00:02:00.000Z",
      statePatch: characterPatch({
        characterId: "character_shen",
        summary: "第三幕：没有新消息",
        status: null,
      }),
    }),
    v2SceneFixture({
      id: "scene_sibling",
      parentSceneId: "scene_1",
      depth: 2,
      createdAt: "2026-08-11T00:03:00.000Z",
      statePatch: characterPatch({
        characterId: "character_shen",
        summary: "兄弟分支：沈砚安然离开",
        status: "alive",
      }),
    }),
  ]);
}

function derive(
  path: ReturnType<typeof getScenePath>,
  overrides: WorldlineCharacterStatusOverride[] = [],
) {
  return derivePathCharacterStatuses({
    storyMap,
    divergence,
    baseDelta: baseDelta(),
    path,
    overrides,
  });
}

describe("deriveSourceBaselineStatuses", () => {
  it("infers only pre-divergence fact deaths with evidence", () => {
    const baseline = deriveSourceBaselineStatuses({ storyMap, divergence });
    expect(baseline.get("character_shen")).toEqual({
      status: "dead",
      source: "source_inference",
      eventId: "event_1",
    });
    // inference、否定措辞、分歧点自身与之后的事件都不算基线。
    expect(baseline.has("character_gu")).toBe(false);
    expect(baseline.has("character_zhou")).toBe(true);
    expect(baseline.get("character_zhou")?.eventId).toBe("event_6");
  });

  it("requires the divergence event to exist", () => {
    expect(() =>
      deriveSourceBaselineStatuses({
        storyMap,
        divergence: { ...divergence, eventId: "event_missing" },
      }),
    ).toThrow("分歧事件不在当前 Story Map 中");
  });
});

describe("derivePathCharacterStatuses", () => {
  const tree = treeWithStatuses();

  it("keeps baseline dead through status-less and null later changes", () => {
    const path = resolveReadingPath(tree, {
      kind: "scene",
      sceneId: "scene_3",
    });
    const states = derive(path);
    const shen = states.find(
      (state) => state.characterId === "character_shen",
    );
    expect(shen).toMatchObject({
      status: "dead",
      source: "scene",
      sourceSceneId: "scene_1",
    });
    expect(shen?.summary).toBe("第三幕：没有新消息");
    expect(derivePathState(baseDelta(), path).characterChanges).toContainEqual(
      expect.objectContaining({ characterId: "character_shen", status: "dead" }),
    );

    // UI 的旧 timeline 也直接读取同一个折叠结果。
    const timeline = derivePathCharacterTimeline({
      baseDelta: baseDelta(),
      path,
      characters: storyMap.characters,
    });
    expect(
      timeline.find((state) => state.characterId === "character_shen")
        ?.currentStatus,
    ).toBe("dead");
  });

  it("lets a later explicit alive override the baseline dead", () => {
    const path = [
      ...getScenePath(tree, "scene_1"),
      ...getScenePath(tree, "scene_sibling").slice(1),
    ];
    const states = derive(path);
    const shen = states.find(
      (state) => state.characterId === "character_shen",
    );
    expect(shen).toMatchObject({
      status: "alive",
      source: "scene",
      sourceSceneId: "scene_sibling",
    });
  });

  it("never folds a sibling branch's status", () => {
    const path = resolveReadingPath(tree, {
      kind: "scene",
      sceneId: "scene_2",
    });
    const states = derive(path);
    const shen = states.find(
      (state) => state.characterId === "character_shen",
    );
    expect(shen?.status).toBe("dead");
    expect(shen?.sourceSceneId).toBe("scene_1");
    expect(shen?.history.map((entry) => entry.summary)).not.toContain(
      "兄弟分支：沈砚安然离开",
    );
  });

  it("applies reader overrides at divergence and only through anchored scenes", () => {
    const overrides: WorldlineCharacterStatusOverride[] = [
      {
        id: "override_1",
        worldlineId: "wl_1",
        anchorSceneId: null,
        characterId: "character_gu",
        status: "dead",
        idempotencyKey: "key_1",
        createdAt: "2026-08-10T00:00:00.000Z",
      },
      {
        id: "override_2",
        worldlineId: "wl_1",
        anchorSceneId: "scene_2",
        characterId: "character_gu",
        status: "alive",
        idempotencyKey: "key_2",
        createdAt: "2026-08-10T00:01:00.000Z",
      },
    ];
    const beforeAnchor = derive(
      resolveReadingPath(tree, { kind: "scene", sceneId: "scene_1" }),
      overrides,
    );
    expect(
      beforeAnchor.find((state) => state.characterId === "character_gu"),
    ).toMatchObject({ status: "dead", source: "reader" });

    const throughAnchor = derive(
      resolveReadingPath(tree, { kind: "scene", sceneId: "scene_2" }),
      overrides,
    );
    expect(
      throughAnchor.find((state) => state.characterId === "character_gu"),
    ).toMatchObject({
      status: "alive",
      source: "reader",
      sourceSceneId: "scene_2",
    });

    const sibling = derive(
      resolveReadingPath(tree, { kind: "scene", sceneId: "scene_sibling" }),
      overrides,
    );
    expect(
      sibling.find((state) => state.characterId === "character_gu"),
    ).toMatchObject({ status: "dead", source: "reader" });
  });

  it("lets the latest override for the same character and anchor win", () => {
    const states = derive([], [
      {
        id: "override_a",
        worldlineId: "wl_1",
        anchorSceneId: null,
        characterId: "character_zhou",
        status: "dead",
        idempotencyKey: "a",
        createdAt: "2026-08-10T00:00:00.000Z",
      },
      {
        id: "override_b",
        worldlineId: "wl_1",
        anchorSceneId: null,
        characterId: "character_zhou",
        status: "absent",
        idempotencyKey: "b",
        createdAt: "2026-08-10T00:02:00.000Z",
      },
    ]);
    expect(
      states.find((state) => state.characterId === "character_zhou"),
    ).toMatchObject({ status: "absent", source: "reader" });
  });

  it("defaults everyone else to unknown and hides default rows", () => {
    const states = derive([]);
    expect(
      states.find((state) => state.characterId === "character_gu"),
    ).toBeUndefined();
    expect(states.map((state) => state.characterId).sort()).toEqual([
      "character_shen",
      "character_zhou",
    ]);
  });
});
