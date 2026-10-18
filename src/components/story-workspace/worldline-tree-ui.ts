import type { CharacterStatusSource } from "@/domain/continuation/character-status";
import type { SceneNode } from "@/domain/continuation/scene-tree";
import type {
  PathCharacterHistoryEntry,
  WorldlineTreeRow,
} from "@/domain/continuation/worldline-tree";
import type { CharacterStatus } from "@/domain/schemas";

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

const characterStatusLabels: Record<CharacterStatus, string> = {
  alive: "在世",
  dead: "已故",
  absent: "不在场",
  unknown: "未知",
};

/** 路径人物状态的固定中文标签；顺序与 Schema 枚举一致。 */
export function pathCharacterStatusLabel(status: CharacterStatus): string {
  return characterStatusLabels[status];
}

/** 状态来源标签：原著推断 / 影响计划 / 第 n 幕 / 读者设定 / 默认。 */
export function pathCharacterStatusSourceLabel(
  source: CharacterStatusSource,
  depth: number | null,
): string {
  switch (source) {
    case "source_inference":
      return "原著推断";
    case "impact":
      return "影响计划";
    case "scene":
      return depth === null ? "场景" : `第 ${depth} 幕`;
    case "reader":
      return "读者设定";
    case "default":
      return "默认";
  }
}

/** 人物状态历史的一行：分歧点 → 第 n 幕；有显式状态时附在末尾。 */
export function pathCharacterHistoryLabel(
  entry: PathCharacterHistoryEntry,
): string {
  const source =
    entry.sourceKind === "divergence" ? "分歧点" : `第 ${entry.depth} 幕`;
  const status =
    entry.status === undefined
      ? ""
      : ` · 状态：${pathCharacterStatusLabel(entry.status)}`;
  return `${source}：${entry.summary}${status}`;
}
