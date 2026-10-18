import { describe, expect, it } from "vitest";

import {
  buildSceneTree,
  getDefaultScenePath,
} from "@/domain/continuation/scene-tree";
import {
  buildWorldlineTreeOutline,
  type PathCharacterHistoryEntry,
} from "@/domain/continuation/worldline-tree";

import {
  defaultExpandedTreeIds,
  expandTreeIdsForPath,
  pathCharacterHistoryLabel,
  worldlineTreeRowBadges,
  worldlineTreeRowLabel,
} from "@/components/story-workspace/worldline-tree-ui";
import {
  continuationDirectionFixture,
  directionBatchFixture,
  v2SceneFixture,
} from "../helpers/continuation-scene-fixtures";

function buildRows() {
  const retryScene = v2SceneFixture({
    id: "scene_retry",
    parentSceneId: null,
    depth: 1,
    createdAt: "2026-08-11T00:01:00.000Z",
    origin: "retry",
    attemptIndex: 1,
    title: "重试第一幕",
  });
  const siblingScene = v2SceneFixture({
    id: "scene_sibling",
    parentSceneId: null,
    depth: 1,
    createdAt: "2026-08-11T00:02:00.000Z",
    title: "另一个第一幕",
  });
  const tree = buildSceneTree([retryScene, siblingScene]);
  const batch = directionBatchFixture({
    id: "batch_root",
    parentSceneId: null,
    batchIndex: 0,
    createdAt: "2026-08-11T00:03:00.000Z",
    directions: [
      continuationDirectionFixture(1, { id: "dir_1" }),
      continuationDirectionFixture(2, { id: "dir_2" }),
      continuationDirectionFixture(3, { id: "dir_3" }),
    ],
  });
  const rows = buildWorldlineTreeOutline({
    tree,
    directionBatches: [batch],
    currentPath: getDefaultScenePath(tree),
    expandedIds: new Set<string | null>([null]),
  });
  return { rows, tree };
}

describe("worldline tree presentation helpers", () => {
  it("labels the root and scene rows with their act number", () => {
    const { rows } = buildRows();
    const root = rows.find((row) => row.id === null)!;
    const retry = rows.find((row) => row.id === "scene_retry")!;

    expect(worldlineTreeRowLabel(root)).toBe("分歧点");
    expect(worldlineTreeRowLabel(retry)).toBe("第 1 幕 · 重试第一幕");
  });

  it("builds retry, sibling version and unexplored-direction badges in order", () => {
    const { rows } = buildRows();
    const root = rows.find((row) => row.id === null)!;
    const retry = rows.find((row) => row.id === "scene_retry")!;
    const sibling = rows.find((row) => row.id === "scene_sibling")!;

    expect(worldlineTreeRowBadges(root)).toEqual(["+3 个未选方向"]);
    expect(worldlineTreeRowBadges(retry)).toEqual(["重试", "版本 1/2"]);
    expect(worldlineTreeRowBadges(sibling)).toEqual(["版本 2/2"]);
  });

  it("starts from the current path and unions new paths without dropping user expansion", () => {
    const { tree } = buildRows();
    const defaultExpanded = defaultExpandedTreeIds(getDefaultScenePath(tree));
    expect([...defaultExpanded]).toEqual([null, "scene_sibling"]);

    const withUserExpansion = new Set<string | null>([
      ...defaultExpanded,
      "scene_retry",
    ]);
    const expanded = expandTreeIdsForPath(withUserExpansion, [
      tree.nodes.get("scene_sibling")!,
    ]);

    expect(expanded.has(null)).toBe(true);
    expect(expanded.has("scene_retry")).toBe(true);
    expect(expanded.has("scene_sibling")).toBe(true);
  });

  it("formats divergence and scene history entries", () => {
    const divergence: PathCharacterHistoryEntry = {
      sourceKind: "divergence",
      sceneId: null,
      depth: 0,
      summary: "拒绝交出账簿",
    };
    const scene: PathCharacterHistoryEntry = {
      sourceKind: "scene",
      sceneId: "scene_1",
      depth: 2,
      summary: "决定公开",
    };

    expect(pathCharacterHistoryLabel(divergence)).toBe("分歧点：拒绝交出账簿");
    expect(pathCharacterHistoryLabel(scene)).toBe("第 2 幕：决定公开");
  });
});
