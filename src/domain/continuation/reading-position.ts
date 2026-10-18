import { getScenePath, type SceneTree } from "@/domain/continuation/scene-tree";
import type { ReadingPosition } from "@/domain/continuation/worldline-tree";

/**
 * 持久化阅读位置（`worldlines.head_node_id`）与客户端 `ReadingPosition`
 * 的纯映射。
 *
 * - `null` 表示默认路径：与迁移前行为一致，沿首选分支走到叶子；
 * - 非空必须是当前世界线场景树中真实存在的节点，由 `assertHeadOnTree`
 *   在读取/写入边界 fail closed 校验。
 */
export function readingPositionFromHead(
  headNodeId: string | null,
): ReadingPosition {
  return headNodeId === null
    ? { kind: "default" }
    : { kind: "scene", sceneId: headNodeId };
}

/** 反向映射；`default` 与 `root` 都持久化为 `null`。 */
export function headNodeIdFromReadingPosition(
  position: ReadingPosition,
): string | null {
  return position.kind === "scene" ? position.sceneId : null;
}

/** 非空 head 必须能在场景树中解析；未知 id 直接抛错，不静默回退。 */
export function assertHeadOnTree(
  tree: SceneTree,
  headNodeId: string | null,
): void {
  if (headNodeId === null) return;
  getScenePath(tree, headNodeId);
}
