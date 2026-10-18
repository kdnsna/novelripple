import {
  getScenePath,
  type SceneNode,
  type SceneTree,
} from "@/domain/continuation/scene-tree";
import type {
  SettingDeltaSubject,
  SettingDeltaV1,
} from "@/domain/schemas";

import { SETTING_DELTA_MAX_ACTIVE } from "./setting-delta-limits";

/**
 * 某个设定主体在当前路径上的生效结果。
 *
 * 同一主体沿路径可以出现多次；`active` 是最深/最新的一条，`history` 是
 * 这条路径上更早可见的版本（旧→新）。读者通过追加新设定修订规则，旧行
 * 永远不会被 UPDATE。
 */
export type ActiveSettingDelta = {
  subjectKey: string;
  active: SettingDeltaV1;
  history: SettingDeltaV1[];
};

/**
 * 主体身份：
 * - 人物使用稳定 characterId；
 * - 术语使用规范化名称（NFKC、去首尾空白、合并内部空白、大小写折叠），
 *   因此“旧 灯塔”和“旧　灯塔”视为同一设定主体。
 */
export function subjectKey(subject: SettingDeltaSubject): string {
  if (subject.kind === "character") {
    return `character:${subject.characterId}`;
  }
  return `term:${normalizeTermName(subject.name)}`;
}

export function normalizeTermName(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("zh-CN");
}

type VisibleDelta = {
  delta: SettingDeltaV1;
  /** 分歧点 = 0；场景锚点 = 该场景深度。 */
  anchorDepth: number;
};

/**
 * 沿给定路径派生生效的设定增量（纯函数）。
 *
 * 可见性：`anchorSceneId === null` 的规则从分歧点起整条世界线生效；否则只有
 * 锚点位于当前路径（祖先或当前节点）时才可见。兄弟分支的规则永不出现。
 * 多个可见版本按（锚点深度、createdAt、id）排序；同一主体只保留最后一条为
 * active，之前的版本进入 history。结果按主体首次出现顺序输出。
 *
 * fail closed：跨世界线 delta、未知锚点、断裂路径、重复 delta id 都会抛错。
 * 超过 `SETTING_DELTA_MAX_ACTIVE` 个主体时只保留最深/最新的主体，限制必需
 * 上下文的有界大小。
 */
export function deriveActiveSettingDeltas(input: {
  tree: SceneTree;
  deltas: readonly SettingDeltaV1[];
  path: readonly SceneNode[];
}): ActiveSettingDelta[] {
  const { tree, path } = input;
  assertPath(tree, path);
  const expectedWorldlineId = assertTreeWorldline(tree, path);
  assertDeltaWorldlines(input.deltas, expectedWorldlineId);

  const pathIds = new Set(path.map((node) => node.id));
  const seenDeltaIds = new Set<string>();
  const visible: VisibleDelta[] = [];

  for (const delta of input.deltas) {
    if (seenDeltaIds.has(delta.id)) {
      throw new Error(`设定增量存在重复 id：${delta.id}`);
    }
    seenDeltaIds.add(delta.id);

    let anchorDepth = 0;
    if (delta.anchorSceneId !== null) {
      const anchor = tree.nodes.get(delta.anchorSceneId);
      if (!anchor) {
        throw new Error(
          `设定增量引用了场景树中不存在的锚点：${delta.anchorSceneId}`,
        );
      }
      // 锚点在树上但不在当前路径：属于兄弟分支或未来分支，不可见。
      if (!pathIds.has(delta.anchorSceneId)) continue;
      anchorDepth = anchor.depth;
    }
    visible.push({ delta, anchorDepth });
  }

  visible.sort(compareVisibleDeltas);

  const firstAppearance: string[] = [];
  const bySubject = new Map<
    string,
    { active: VisibleDelta; history: SettingDeltaV1[] }
  >();
  for (const item of visible) {
    const key = subjectKey(item.delta.subject);
    const existing = bySubject.get(key);
    if (!existing) {
      firstAppearance.push(key);
      bySubject.set(key, { active: item, history: [] });
      continue;
    }
    existing.history.push(existing.active.delta);
    existing.active = item;
  }

  let keptKeys = firstAppearance;
  if (bySubject.size > SETTING_DELTA_MAX_ACTIVE) {
    // 主体过多时保留最深/最新的若干条 active；history 随 active 一起保留。
    keptKeys = [...bySubject.entries()]
      .sort((left, right) => compareVisibleDeltas(right[1].active, left[1].active))
      .slice(0, SETTING_DELTA_MAX_ACTIVE)
      .map(([key]) => key);
    const keep = new Set(keptKeys);
    keptKeys = firstAppearance.filter((key) => keep.has(key));
  }

  return keptKeys.map((key) => {
    const entry = bySubject.get(key)!;
    return {
      subjectKey: key,
      active: entry.active.delta,
      history: entry.history,
    };
  });
}

function assertPath(
  tree: SceneTree,
  path: readonly SceneNode[],
): void {
  for (const node of path) {
    const stored = tree.nodes.get(node.id);
    if (!stored) {
      throw new Error(`当前路径包含场景树中不存在的节点：${node.id}`);
    }
    if (stored.worldlineId !== node.worldlineId) {
      throw new Error(`当前路径节点属于其他世界线：${node.id}`);
    }
  }
  if (path.length === 0) return;
  const target = path[path.length - 1]!;
  const expected = getScenePath(tree, target.id);
  if (
    expected.length !== path.length ||
    expected.some((node, index) => node.id !== path[index]!.id)
  ) {
    throw new Error("设定增量的当前路径不属于给定场景树");
  }
}

function assertTreeWorldline(
  tree: SceneTree,
  path: readonly SceneNode[],
): string | null {
  const worldlineIds = new Set<string>();
  for (const node of tree.nodes.values()) worldlineIds.add(node.worldlineId);
  if (worldlineIds.size > 1) {
    throw new Error("场景树包含跨世界线节点");
  }
  const treeWorldlineId = [...worldlineIds][0] ?? null;
  if (treeWorldlineId !== null) return treeWorldlineId;
  return path[0]?.worldlineId ?? null;
}

function assertDeltaWorldlines(
  deltas: readonly SettingDeltaV1[],
  expectedWorldlineId: string | null,
): void {
  if (expectedWorldlineId !== null) {
    for (const delta of deltas) {
      if (delta.worldlineId !== expectedWorldlineId) {
        throw new Error(
          `设定增量属于其他世界线：${delta.worldlineId} != ${expectedWorldlineId}`,
        );
      }
    }
    return;
  }
  // 空树无法从节点推断世界线；至少要求输入不混合多个世界线。
  const worldlineIds = new Set(deltas.map((delta) => delta.worldlineId));
  if (worldlineIds.size > 1) {
    throw new Error("设定增量来自多个世界线，无法派生");
  }
}

function compareVisibleDeltas(left: VisibleDelta, right: VisibleDelta): number {
  if (left.anchorDepth !== right.anchorDepth) {
    return left.anchorDepth - right.anchorDepth;
  }
  if (left.delta.createdAt !== right.delta.createdAt) {
    return left.delta.createdAt < right.delta.createdAt ? -1 : 1;
  }
  if (left.delta.id === right.delta.id) return 0;
  return left.delta.id < right.delta.id ? -1 : 1;
}
