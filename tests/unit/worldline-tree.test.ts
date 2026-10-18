import { describe, expect, it } from "vitest";

import {
  buildSceneTree,
  derivePathState,
  getDefaultScenePath,
  type SceneTree,
} from "@/domain/continuation/scene-tree";
import {
  buildWorldlineTreeOutline,
  derivePathCharacterTimeline,
  latestBatchForParent,
  listDirectionOptions,
  resolveReadingPath,
} from "@/domain/continuation/worldline-tree";
import { WorldlineDeltaSchema, type StatePatch } from "@/domain/schemas";

import {
  continuationDirectionFixture,
  directionBatchFixture,
  emptyStatePatch,
  v2SceneFixture,
} from "../helpers/continuation-scene-fixtures";

function characterPatch(
  ...changes: Array<[characterId: string, summary: string]>
): StatePatch {
  return {
    ...emptyStatePatch(),
    characterChanges: changes.map(([characterId, summary]) => ({
      characterId,
      summary,
    })),
  };
}

/**
 * 一棵固定的小树：
 *
 * 分歧点
 * ├─ 第一幕（本幕优先）
 * │  ├─ 第二幕（本幕优先）
 * │  │  └─ 第三幕
 * │  └─ 第二幕重试（折叠）
 * │     └─ 隐藏的第三幕
 * └─ 另一个第一幕（折叠）
 */
function buildOutlineTree(): SceneTree {
  return buildSceneTree([
    v2SceneFixture({
      id: "scene_root_a",
      parentSceneId: null,
      depth: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
      title: "第一幕",
    }),
    v2SceneFixture({
      id: "scene_child_a",
      parentSceneId: "scene_root_a",
      depth: 2,
      createdAt: "2026-08-11T00:01:00.000Z",
      title: "第二幕",
    }),
    v2SceneFixture({
      id: "scene_grand_a",
      parentSceneId: "scene_child_a",
      depth: 3,
      createdAt: "2026-08-11T00:02:00.000Z",
      title: "第三幕",
    }),
    v2SceneFixture({
      id: "scene_child_b",
      parentSceneId: "scene_root_a",
      depth: 2,
      createdAt: "2026-08-11T00:03:00.000Z",
      origin: "retry",
      attemptIndex: 1,
      title: "第二幕重试",
    }),
    v2SceneFixture({
      id: "scene_grand_b",
      parentSceneId: "scene_child_b",
      depth: 3,
      createdAt: "2026-08-11T00:04:00.000Z",
      title: "隐藏的第三幕",
    }),
    v2SceneFixture({
      id: "scene_root_b",
      parentSceneId: null,
      depth: 1,
      createdAt: "2026-08-11T00:05:00.000Z",
      title: "另一个第一幕",
    }),
    v2SceneFixture({
      id: "scene_child_c",
      parentSceneId: "scene_root_b",
      depth: 2,
      createdAt: "2026-08-11T00:06:00.000Z",
      title: "另一条第二幕",
    }),
  ]);
}

describe("resolveReadingPath", () => {
  const tree = buildOutlineTree();

  it("follows the default path to a leaf", () => {
    expect(
      resolveReadingPath(tree, { kind: "default" }).map((node) => node.id),
    ).toEqual(["scene_root_a", "scene_child_a", "scene_grand_a"]);
    expect(getDefaultScenePath(tree).map((node) => node.id)).toEqual([
      "scene_root_a",
      "scene_child_a",
      "scene_grand_a",
    ]);
  });

  it("returns an empty path for the divergence point", () => {
    expect(resolveReadingPath(tree, { kind: "root" })).toEqual([]);
  });

  it("reopens from any existing node, including an inner node", () => {
    expect(
      resolveReadingPath(tree, { kind: "scene", sceneId: "scene_child_a" }).map(
        (node) => node.id,
      ),
    ).toEqual(["scene_root_a", "scene_child_a"]);
    expect(
      resolveReadingPath(tree, { kind: "scene", sceneId: "scene_grand_b" }).map(
        (node) => node.id,
      ),
    ).toEqual(["scene_root_a", "scene_child_b", "scene_grand_b"]);
  });

  it("fails closed for an unknown scene id", () => {
    expect(() =>
      resolveReadingPath(tree, { kind: "scene", sceneId: "scene_missing" }),
    ).toThrow("不存在节点");
  });
});

describe("buildWorldlineTreeOutline", () => {
  const tree = buildOutlineTree();
  const currentPath = getDefaultScenePath(tree);

  it("returns rows in pre-order with the root row first", () => {
    const rows = buildWorldlineTreeOutline({
      tree,
      directionBatches: [],
      currentPath,
    });

    expect(rows.map((row) => row.id)).toEqual([
      null,
      "scene_root_a",
      "scene_child_a",
      "scene_grand_a",
      "scene_child_b",
      "scene_root_b",
    ]);
    expect(rows[0]).toMatchObject({
      id: null,
      level: 0,
      title: "分歧点",
      depth: 0,
      origin: null,
      attemptIndex: null,
      siblingIndex: 0,
      siblingCount: 1,
      childCount: 2,
      onCurrentPath: true,
      isCurrent: false,
      expanded: true,
      hasChildren: true,
    });
  });

  it("uses scene depth as the indentation level and reports sibling position", () => {
    const rows = buildWorldlineTreeOutline({
      tree,
      directionBatches: [],
      currentPath,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get("scene_child_a")).toMatchObject({
      level: 2,
      depth: 2,
      siblingIndex: 0,
      siblingCount: 2,
      childCount: 1,
      origin: "generated",
      attemptIndex: 0,
      onCurrentPath: true,
      isCurrent: false,
      expanded: true,
      hasChildren: true,
    });
    expect(byId.get("scene_child_b")).toMatchObject({
      level: 2,
      depth: 2,
      siblingIndex: 1,
      siblingCount: 2,
      childCount: 1,
      origin: "retry",
      attemptIndex: 1,
      onCurrentPath: false,
      isCurrent: false,
      expanded: false,
      hasChildren: true,
    });
    expect(byId.get("scene_root_b")).toMatchObject({
      level: 1,
      siblingIndex: 1,
      siblingCount: 2,
      childCount: 1,
      onCurrentPath: false,
    });
    expect(byId.get("scene_grand_a")?.isCurrent).toBe(true);
    expect(byId.get("scene_grand_a")?.hasChildren).toBe(false);
  });

  it("keeps collapsed nodes' childCount while hiding their children", () => {
    const rows = buildWorldlineTreeOutline({
      tree,
      directionBatches: [],
      currentPath,
    });
    const ids = rows.map((row) => row.id);

    expect(ids).not.toContain("scene_grand_b");
    expect(ids).not.toContain("scene_child_c");
    expect(rows.find((row) => row.id === "scene_child_b")?.childCount).toBe(1);
    expect(rows.find((row) => row.id === "scene_root_b")?.childCount).toBe(1);
  });

  it("lets explicit expandedIds fully replace the default set", () => {
    const onlyRoot = buildWorldlineTreeOutline({
      tree,
      directionBatches: [],
      currentPath,
      expandedIds: new Set<string | null>([null]),
    });
    expect(onlyRoot.map((row) => row.id)).toEqual([
      null,
      "scene_root_a",
      "scene_root_b",
    ]);

    const oneBranch = buildWorldlineTreeOutline({
      tree,
      directionBatches: [],
      currentPath,
      expandedIds: new Set<string | null>([null, "scene_root_a"]),
    });
    expect(oneBranch.map((row) => row.id)).toEqual([
      null,
      "scene_root_a",
      "scene_child_a",
      "scene_child_b",
      "scene_root_b",
    ]);

    const collapsedRoot = buildWorldlineTreeOutline({
      tree,
      directionBatches: [],
      currentPath,
      expandedIds: new Set<string | null>(),
    });
    expect(collapsedRoot.map((row) => row.id)).toEqual([null]);
    expect(collapsedRoot[0]?.childCount).toBe(2);
  });

  it("marks the root as current when the reading position is the divergence point", () => {
    const rows = buildWorldlineTreeOutline({
      tree,
      directionBatches: [],
      currentPath: [],
      expandedIds: new Set<string | null>([null]),
    });

    expect(rows[0]).toMatchObject({
      isCurrent: true,
      onCurrentPath: true,
      expanded: true,
    });
    expect(rows.slice(1).every((row) => !row.onCurrentPath)).toBe(true);
  });

  it("fails closed when currentPath is not a real tree path", () => {
    expect(() =>
      buildWorldlineTreeOutline({
        tree,
        directionBatches: [],
        currentPath: [tree.nodes.get("scene_grand_a")!],
      }),
    ).toThrow("当前路径");
  });

  describe("unexploredDirectionCount", () => {
    const sceneRoot = v2SceneFixture({
      id: "scene_root",
      parentSceneId: null,
      depth: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
    });
    const batchZero = directionBatchFixture({
      id: "batch_zero",
      parentSceneId: null,
      batchIndex: 0,
      createdAt: "2026-08-11T00:01:00.000Z",
      directions: [
        continuationDirectionFixture(1, { id: "dir_zero_1" }),
        continuationDirectionFixture(2, { id: "dir_zero_2" }),
        continuationDirectionFixture(3, { id: "dir_zero_3" }),
      ],
    });
    const batchOne = directionBatchFixture({
      id: "batch_one",
      parentSceneId: null,
      batchIndex: 1,
      createdAt: "2026-08-11T00:02:00.000Z",
      directions: [
        continuationDirectionFixture(1, { id: "dir_one_1" }),
        continuationDirectionFixture(2, { id: "dir_one_2" }),
        continuationDirectionFixture(3, { id: "dir_one_3" }),
      ],
    });
    const explored = v2SceneFixture({
      id: "scene_explored",
      parentSceneId: null,
      depth: 1,
      createdAt: "2026-08-11T00:03:00.000Z",
      directionsArtifactId: batchZero.id,
      selectedDirectionId: "dir_zero_1",
    });
    const retried = v2SceneFixture({
      id: "scene_retried",
      parentSceneId: null,
      depth: 1,
      createdAt: "2026-08-11T00:04:00.000Z",
      origin: "retry",
      attemptIndex: 1,
      directionsArtifactId: batchZero.id,
      selectedDirectionId: "dir_zero_1",
    });
    const exploredFromSecondBatch = v2SceneFixture({
      id: "scene_second",
      parentSceneId: null,
      depth: 1,
      createdAt: "2026-08-11T00:05:00.000Z",
      directionsArtifactId: batchOne.id,
      selectedDirectionId: "dir_one_2",
    });
    const unexploredTree = buildSceneTree([
      sceneRoot,
      explored,
      retried,
      exploredFromSecondBatch,
    ]);

    it("counts ungenerated directions across batches and ignores retries", () => {
      const onlyFirstBatch = buildWorldlineTreeOutline({
        tree: unexploredTree,
        directionBatches: [batchZero],
        currentPath: [],
        expandedIds: new Set<string | null>([null]),
      });
      // batch_zero：3 个方向只有 dir_zero_1 已生成（重试不重复计数）→ 2。
      expect(onlyFirstBatch[0]?.unexploredDirectionCount).toBe(2);

      const rows = buildWorldlineTreeOutline({
        tree: unexploredTree,
        directionBatches: [batchOne, batchZero],
        currentPath: [],
        expandedIds: new Set<string | null>([null]),
      });

      // batch_zero 剩 2 个，batch_one 的 3 个只有 dir_one_2 已生成 → 2，
      // 同一父节点的两个批次合并计数 → 4。
      expect(rows[0]?.unexploredDirectionCount).toBe(4);
      expect(
        rows.find((row) => row.id === "scene_root")
          ?.unexploredDirectionCount,
      ).toBe(0);
    });
  });
});

describe("listDirectionOptions", () => {
  const parent = v2SceneFixture({
    id: "scene_parent",
    parentSceneId: null,
    depth: 1,
    createdAt: "2026-08-11T00:00:00.000Z",
  });
  const firstAttempt = v2SceneFixture({
    id: "scene_first",
    parentSceneId: parent.id,
    depth: 2,
    createdAt: "2026-08-11T00:01:00.000Z",
    directionsArtifactId: "batch_0",
    selectedDirectionId: "dir_a",
  });
  const retryAttempt = v2SceneFixture({
    id: "scene_retry",
    parentSceneId: parent.id,
    depth: 2,
    createdAt: "2026-08-11T00:02:00.000Z",
    origin: "retry",
    attemptIndex: 1,
    directionsArtifactId: "batch_0",
    selectedDirectionId: "dir_a",
  });
  const secondDirection = v2SceneFixture({
    id: "scene_second_direction",
    parentSceneId: parent.id,
    depth: 2,
    createdAt: "2026-08-11T00:03:00.000Z",
    directionsArtifactId: "batch_0",
    selectedDirectionId: "dir_b",
  });
  const tree = buildSceneTree([
    parent,
    firstAttempt,
    retryAttempt,
    secondDirection,
  ]);
  const batch0 = directionBatchFixture({
    id: "batch_0",
    parentSceneId: parent.id,
    batchIndex: 0,
    createdAt: "2026-08-11T00:04:00.000Z",
    directions: [
      continuationDirectionFixture(1, { id: "dir_a" }),
      continuationDirectionFixture(2, { id: "dir_b" }),
      continuationDirectionFixture(3, { id: "dir_c" }),
    ],
  });
  const batch2 = directionBatchFixture({
    id: "batch_2",
    parentSceneId: parent.id,
    batchIndex: 2,
    createdAt: "2026-08-11T00:05:00.000Z",
    directions: [
      continuationDirectionFixture(1, { id: "dir_late_1" }),
      continuationDirectionFixture(2, { id: "dir_late_2" }),
      continuationDirectionFixture(3, { id: "dir_late_3" }),
    ],
  });
  const rootBatch = directionBatchFixture({
    id: "batch_root",
    parentSceneId: null,
    batchIndex: 0,
    createdAt: "2026-08-11T00:06:00.000Z",
  });

  it("orders sibling batches by batchIndex and annotates generated scenes", () => {
    const options = listDirectionOptions({
      tree,
      directionBatches: [batch2, batch0, rootBatch],
      parentSceneId: parent.id,
    });

    expect(options.map((option) => option.batch.id)).toEqual([
      "batch_0",
      "batch_2",
    ]);
    expect(
      options[0]?.directions.map((option) => ({
        id: option.direction.id,
        sceneIds: option.sceneIds,
      })),
    ).toEqual([
      { id: "dir_a", sceneIds: ["scene_first", "scene_retry"] },
      { id: "dir_b", sceneIds: ["scene_second_direction"] },
      { id: "dir_c", sceneIds: [] },
    ]);
    expect(options[1]?.directions.every((option) => option.sceneIds.length === 0)).toBe(
      true,
    );
  });

  it("lists root batches only for the root parent", () => {
    const rootOptions = listDirectionOptions({
      tree,
      directionBatches: [batch2, batch0, rootBatch],
      parentSceneId: null,
    });

    expect(rootOptions.map((option) => option.batch.id)).toEqual(["batch_root"]);
    expect(rootOptions[0]?.directions).toHaveLength(3);
  });
});

describe("latestBatchForParent", () => {
  const makeBatch = (
    id: string,
    batchIndex: number,
    createdAt: string,
  ): ReturnType<typeof directionBatchFixture> =>
    directionBatchFixture({
      id,
      parentSceneId: "scene_parent",
      batchIndex,
      createdAt,
    });

  it("returns the latest batch for the requested parent", () => {
    const batches = [
      makeBatch("batch_0", 0, "2026-08-11T00:00:00.000Z"),
      makeBatch("batch_2", 2, "2026-08-11T00:01:00.000Z"),
      makeBatch("batch_1", 1, "2026-08-11T00:02:00.000Z"),
      directionBatchFixture({
        id: "batch_root",
        parentSceneId: null,
        batchIndex: 5,
        createdAt: "2026-08-11T00:03:00.000Z",
      }),
    ];

    expect(latestBatchForParent(batches, "scene_parent")?.id).toBe("batch_2");
    expect(latestBatchForParent(batches, null)?.id).toBe("batch_root");
    expect(latestBatchForParent(batches, "scene_missing")).toBeNull();
  });

  it("breaks equal batchIndex ties by createdAt and then id", () => {
    const earlier = makeBatch("batch_a", 2, "2026-08-11T00:00:00.000Z");
    const later = makeBatch("batch_b", 2, "2026-08-11T00:01:00.000Z");
    expect(latestBatchForParent([earlier, later], "scene_parent")?.id).toBe(
      "batch_b",
    );
    expect(latestBatchForParent([later, earlier], "scene_parent")?.id).toBe(
      "batch_b",
    );

    const sameTimeLowId = makeBatch("batch_a", 3, "2026-08-11T00:02:00.000Z");
    const sameTimeHighId = makeBatch("batch_b", 3, "2026-08-11T00:02:00.000Z");
    expect(
      latestBatchForParent([sameTimeHighId, sameTimeLowId], "scene_parent")
        ?.id,
    ).toBe("batch_b");
  });
});

describe("derivePathCharacterTimeline", () => {
  const divergence = WorldlineDeltaSchema.parse({
    ...emptyStatePatch(),
    characterChanges: [
      { characterId: "char_xucheng", summary: "分歧点：拒绝交出账簿" },
      { characterId: "char_shenyan", summary: "分歧点：保持沉默" },
    ],
  });
  const tree = buildSceneTree([
    v2SceneFixture({
      id: "scene_root",
      parentSceneId: null,
      depth: 1,
      createdAt: "2026-08-11T00:00:00.000Z",
      statePatch: characterPatch(
        ["char_xucheng", "第一幕：得知封条被换"],
        ["char_shenyan", "第一幕：加入见证"],
      ),
    }),
    v2SceneFixture({
      id: "scene_branch_a",
      parentSceneId: "scene_root",
      depth: 2,
      createdAt: "2026-08-11T00:01:00.000Z",
      statePatch: characterPatch(
        ["char_xucheng", "第二幕：决定公开"],
        ["char_unknown", "第二幕：短暂出现"],
      ),
    }),
    v2SceneFixture({
      id: "scene_sibling",
      parentSceneId: "scene_root",
      depth: 2,
      createdAt: "2026-08-11T00:02:00.000Z",
      statePatch: characterPatch(["char_xucheng", "兄弟分支：不该出现"]),
    }),
  ]);
  const characters = [
    { id: "char_shenyan", name: "沈砚" },
    { id: "char_xucheng", name: "许澄" },
  ];

  it("collects divergence and scene changes in path order", () => {
    const path = resolveReadingPath(tree, {
      kind: "scene",
      sceneId: "scene_branch_a",
    });
    const timeline = derivePathCharacterTimeline({
      baseDelta: divergence,
      path,
      characters,
    });

    expect(timeline.map((state) => state.characterId)).toEqual([
      "char_shenyan",
      "char_xucheng",
      "char_unknown",
    ]);

    const xucheng = timeline.find(
      (state) => state.characterId === "char_xucheng",
    );
    expect(xucheng).toMatchObject({ name: "许澄", current: "第二幕：决定公开" });
    expect(xucheng?.history).toEqual([
      {
        sourceKind: "divergence",
        sceneId: null,
        depth: 0,
        summary: "分歧点：拒绝交出账簿",
      },
      {
        sourceKind: "scene",
        sceneId: "scene_root",
        depth: 1,
        summary: "第一幕：得知封条被换",
      },
      {
        sourceKind: "scene",
        sceneId: "scene_branch_a",
        depth: 2,
        summary: "第二幕：决定公开",
      },
    ]);

    const unknown = timeline.find(
      (state) => state.characterId === "char_unknown",
    );
    expect(unknown).toMatchObject({
      name: "char_unknown",
      current: "第二幕：短暂出现",
    });
    expect(unknown?.history).toHaveLength(1);
  });

  it("never reads a sibling branch's character changes", () => {
    const path = resolveReadingPath(tree, {
      kind: "scene",
      sceneId: "scene_branch_a",
    });
    const timeline = derivePathCharacterTimeline({
      baseDelta: divergence,
      path,
      characters,
    });
    const summaries = timeline.flatMap((state) =>
      state.history.map((entry) => entry.summary),
    );

    expect(summaries).not.toContain("兄弟分支：不该出现");
    expect(timeline.every((state) => state.current !== "兄弟分支：不该出现")).toBe(
      true,
    );
  });

  it("matches derivePathState's later-replaces-earlier semantics", () => {
    const path = resolveReadingPath(tree, {
      kind: "scene",
      sceneId: "scene_branch_a",
    });
    const derived = derivePathState(divergence, path);
    const currentById = new Map(
      derived.characterChanges.map((change) => [
        change.characterId,
        change.summary,
      ]),
    );
    const timeline = derivePathCharacterTimeline({
      baseDelta: divergence,
      path,
      characters,
    });

    for (const state of timeline) {
      expect(state.current).toBe(currentById.get(state.characterId));
    }
    expect(timeline).toHaveLength(currentById.size);
  });

  it("returns only the divergence entries for an empty path", () => {
    const timeline = derivePathCharacterTimeline({
      baseDelta: divergence,
      path: [],
      characters,
    });

    expect(timeline.map((state) => state.characterId)).toEqual([
      "char_shenyan",
      "char_xucheng",
    ]);
    expect(timeline.every((state) => state.history.length === 1)).toBe(true);
  });

  it("fails closed for a broken path", () => {
    expect(() =>
      derivePathCharacterTimeline({
        baseDelta: divergence,
        path: [tree.nodes.get("scene_branch_a")!],
        characters,
      }),
    ).toThrow("断裂的父子链");
  });
});
