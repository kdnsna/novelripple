import type { SceneNode } from "@/domain/continuation/scene-tree";
import type {
  PathCharacterHistoryEntry,
  WorldlineTreeRow,
} from "@/domain/continuation/worldline-tree";

/**
 * 世界线树视图的纯展示逻辑。
 *
 * 树本身的派生在 `@/domain/continuation/worldline-tree`；这里只负责把
 * 行模型映射成可读标签/角标，以及维护展开集合。放在组件层之外是为了
 * 在不依赖 DOM 的 Vitest 中直接测试。
 */

/** 默认展开分歧点与当前路径上的全部节点。 */
export function defaultExpandedTreeIds(
  currentPath: readonly SceneNode[],
): Set<string | null> {
  const expanded = new Set<string | null>([null]);
  for (const node of currentPath) expanded.add(node.id);
  return expanded;
}

/**
 * 阅读位置变化时把新当前路径并入已有展开集合。
 *
 * 只增不减：用户手动展开的旁支不会被位置切换清掉。分歧点是所有路径的
 * 起点，因此始终重新展开，保证当前节点可见。
 */
export function expandTreeIdsForPath(
  previous: ReadonlySet<string | null>,
  currentPath: readonly SceneNode[],
): Set<string | null> {
  const expanded = new Set(previous);
  expanded.add(null);
  for (const node of currentPath) expanded.add(node.id);
  return expanded;
}

/** 树行的可访问名称：根行为“分歧点”，场景为“第 n 幕 · 标题”。 */
export function worldlineTreeRowLabel(row: WorldlineTreeRow): string {
  return row.id === null
    ? "分歧点"
    : `第 ${row.depth} 幕 · ${row.title}`;
}

/** 行内小角标；顺序固定，便于测试和无障碍名称保持稳定。 */
export function worldlineTreeRowBadges(row: WorldlineTreeRow): string[] {
  const badges: string[] = [];
  if (row.origin === "retry") badges.push("重试");
  if (row.siblingCount > 1) {
    badges.push(`版本 ${row.siblingIndex + 1}/${row.siblingCount}`);
  }
  if (row.unexploredDirectionCount > 0) {
    badges.push(`+${row.unexploredDirectionCount} 个未选方向`);
  }
  return badges;
}

/** 人物状态历史的一行：分歧点 → 第 n 幕。 */
export function pathCharacterHistoryLabel(
  entry: PathCharacterHistoryEntry,
): string {
  const source =
    entry.sourceKind === "divergence" ? "分歧点" : `第 ${entry.depth} 幕`;
  return `${source}：${entry.summary}`;
}
