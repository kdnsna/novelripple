import { getScenePath, type SceneTree } from "@/domain/continuation/scene-tree";
import type { ReadingPosition } from "@/domain/continuation/worldline-tree";
import type { WorldlineHead } from "@/domain/schemas";

/**
 * 持久化阅读游标（`worldlines.head_kind` + `head_node_id`）与客户端
 * `ReadingPosition` 的纯映射。
 *
 * - `null` 表示从未设置：首次进入沿默认路径走到叶子；
 * - `root` 表示用户明确停在分歧点；
 * - `scene` 必须是当前世界线场景树中真实存在的节点，由 `assertHeadOnTree`
 *   在读取/写入边界 fail closed 校验。
 */
export function readingPositionFromHead(
  head: WorldlineHead | null,
): ReadingPosition {
  if (head === null) return { kind: "default" };
  return head.kind === "root"
    ? { kind: "root" }
    : { kind: "scene", sceneId: head.sceneId };
}

/**
 * 反向映射；`default` 表示从未设置，持久化为 `null`。用户明确停到
 * 分歧点时写入 `{ kind: "root" }`，不会退化成默认路径。
 */
export function headFromReadingPosition(
  position: ReadingPosition,
): WorldlineHead | null {
  switch (position.kind) {
    case "default":
      return null;
    case "root":
      return { kind: "root" };
    case "scene":
      return { kind: "scene", sceneId: position.sceneId };
  }
}

/** 场景 head 必须能在场景树中解析；未知 id 直接抛错，不静默回退。 */
export function assertHeadOnTree(
  tree: SceneTree,
  head: WorldlineHead | null,
): void {
  if (head === null || head.kind === "root") return;
  getScenePath(tree, head.sceneId);
}
