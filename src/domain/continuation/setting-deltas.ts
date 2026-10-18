import {
  getScenePath,
  type SceneNode,
  type SceneTree,
} from "@/domain/continuation/scene-tree";
import type {
  SettingDeltaLifecycleStatus,
  SettingDeltaLifecycleV1,
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
  /** 分歧点 = 0；场景锚点 = 该场景深度。用于上下文裁剪顺序。 */
  anchorDepth: number;
};

/**
 * 当前路径可见的规则（含读者已停用的主体）。
 *
 * `status: "deactivated"` 的主体只在界面显示为停用，不进入生成上下文；
 * 软删除的主体完全不出现在结果里。
 */
export type PathSettingDelta = ActiveSettingDelta & {
  status: "active" | "deactivated";
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

/**
 * 上下文里的单条规则文本。
 *
 * 只包含读者可见语义（主体、作用域、说明），id 由数组条目单独携带，
 * 因此 manifest 记录 droppedItemIds 时不需要从正文反解。
 */
export function settingDeltaContextText(input: {
  delta: SettingDeltaV1;
  anchorDepth: number;
  characterNames: ReadonlyMap<string, string>;
}): string {
  return `- ${settingDeltaSubjectLabel(
    input.delta.subject,
    input.characterNames,
  )}（${settingDeltaAnchorLabel(
    input.delta.anchorSceneId,
    input.anchorDepth,
  )}）：${input.delta.statement}`;
}

export function settingDeltaSubjectLabel(
  subject: SettingDeltaSubject,
  characterNames: ReadonlyMap<string, string>,
): string {
  if (subject.kind === "character") {
    return characterNames.get(subject.characterId) ?? subject.characterId;
  }
  return subject.name;
}

export function settingDeltaAnchorLabel(
  anchorSceneId: string | null,
  anchorDepth: number,
): string {
  return anchorSceneId === null ? "自分歧点起" : `自第 ${anchorDepth} 幕起`;
}

/** 进入 `setting_deltas` 段的条目；id 始终是 delta id。 */
export type SettingDeltaContextItem = {
  id: string;
  text: string;
  /** 分歧点 = 0；场景锚点 = 该场景深度。裁剪时先丢最浅的。 */
  anchorDepth: number;
  createdAt: string;
};

/**
 * 把生效规则整理成可序列化的上下文条目。
 *
 * 顺序沿用 `deriveActiveSettingDeltas` 的稳定顺序；裁剪时由组装器按
 * (anchorDepth, createdAt, id) 从最浅/最旧开始整条丢弃。
 */
export function buildSettingDeltaContextItems(input: {
  active: readonly ActiveSettingDelta[];
  characters: readonly { id: string; name: string }[];
}): SettingDeltaContextItem[] {
  const characterNames = new Map(
    input.characters.map((character) => [character.id, character.name] as const),
  );
  return input.active.map(({ active, anchorDepth }) => ({
    id: active.id,
    text: settingDeltaContextText({
      delta: active,
      anchorDepth,
      characterNames,
    }),
    anchorDepth,
    createdAt: active.createdAt,
  }));
}

/** 写时上限与组装器共用同一种紧凑文本，而不是 JSON。 */
export function serializeSettingDeltasForContext(
  items: readonly Pick<SettingDeltaContextItem, "text">[],
): string {
  return items.map((item) => item.text).join("\n");
}

/**
 * 上下文长度按规范化后的 UTF-16 字符数计算。
 *
 * NFKC 统一全角/兼容字符；换行折叠为空格，其余 C0/C1 控制字符直接移除，
 * 连续空格合并。这样 `\u0000` 之类的填充既不能绕过上限，也不会被算成
 * 实际内容。
 */
export function normalizedContextChars(text: string): number {
  return normalizeContextText(text).length;
}

export function normalizeContextText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, "")
    .replace(/\n/gu, " ")
    .replace(/ {2,}/gu, " ")
    .trim();
}

type VisibleDelta = {
  delta: SettingDeltaV1;
  /** 分歧点 = 0；场景锚点 = 该场景深度。 */
  anchorDepth: number;
};

/**
 * 返回每个 targetDeltaId 最新一条生命周期状态（按 createdAt、id）。
 *
 * 没有生命周期事件的规则视为 active。重复的 lifecycle id fail closed；
 * 生命周期只是不可变事件，多个事件按固定顺序取最后一条。
 */
export function settingDeltaLifecycleStatuses(
  lifecycles: readonly SettingDeltaLifecycleV1[],
): ReadonlyMap<string, SettingDeltaLifecycleStatus> {
  const latest = latestSettingDeltaLifecycles(lifecycles);
  const statuses = new Map<string, SettingDeltaLifecycleStatus>();
  for (const [targetDeltaId, lifecycle] of latest) {
    statuses.set(targetDeltaId, lifecycle.status);
  }
  return statuses;
}

function latestSettingDeltaLifecycles(
  lifecycles: readonly SettingDeltaLifecycleV1[],
): Map<string, SettingDeltaLifecycleV1> {
  const latest = new Map<string, SettingDeltaLifecycleV1>();
  const seenIds = new Set<string>();
  for (const lifecycle of lifecycles) {
    if (seenIds.has(lifecycle.id)) {
      throw new Error(`设定增量生命周期存在重复 id：${lifecycle.id}`);
    }
    seenIds.add(lifecycle.id);
    const previous = latest.get(lifecycle.targetDeltaId);
    if (!previous || compareLifecycles(previous, lifecycle) <= 0) {
      latest.set(lifecycle.targetDeltaId, lifecycle);
    }
  }
  return latest;
}

/**
 * 沿给定路径派生可见的设定增量（纯函数）。
 *
 * 可见性：`anchorSceneId === null` 的规则从分歧点起整条世界线生效；否则只有
 * 锚点位于当前路径（祖先或当前节点）时才可见。兄弟分支的规则永不出现。
 * 多个可见版本按（锚点深度、createdAt、id）排序；同一主体只保留最后一条为
 * active，之前的版本进入 history。结果按主体首次出现顺序输出。
 *
 * 生命周期在分组后应用：软删除的规则不进入列表（也不伪装成 history 回到
 * 可见列表）；生效版本被停用时主体以 `deactivated` 返回，供界面显示但不能
 * 进入生成上下文。
 *
 * fail closed：跨世界线 delta / lifecycle、未知锚点、未知生命周期目标、
 * 断裂路径、重复 delta id 都会抛错。
 */
export function derivePathSettingDeltas(input: {
  tree: SceneTree;
  deltas: readonly SettingDeltaV1[];
  lifecycles?: readonly SettingDeltaLifecycleV1[];
  path: readonly SceneNode[];
}): PathSettingDelta[] {
  const { tree, path } = input;
  const lifecycles = input.lifecycles ?? [];
  assertPath(tree, path);
  const expectedWorldlineId = assertTreeWorldline(tree, path);
  assertDeltaWorldlines(input.deltas, expectedWorldlineId);
  assertLifecycleWorldlines(lifecycles, expectedWorldlineId);

  const deltaIds = new Set(input.deltas.map((delta) => delta.id));
  for (const lifecycle of lifecycles) {
    if (!deltaIds.has(lifecycle.targetDeltaId)) {
      throw new Error(
        `设定增量生命周期引用了未知规则：${lifecycle.targetDeltaId}`,
      );
    }
  }
  const statuses = settingDeltaLifecycleStatuses(lifecycles);

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
    { active: VisibleDelta; history: VisibleDelta[] }
  >();
  for (const item of visible) {
    const key = subjectKey(item.delta.subject);
    const existing = bySubject.get(key);
    if (!existing) {
      firstAppearance.push(key);
      bySubject.set(key, { active: item, history: [] });
      continue;
    }
    existing.history.push(existing.active);
    existing.active = item;
  }

  const result: PathSettingDelta[] = [];
  for (const key of firstAppearance) {
    const entry = bySubject.get(key)!;
    const winningStatus = statuses.get(entry.active.delta.id);
    // 软删除的生效版本让整个主体从界面与上下文中消失，不回退到更早版本。
    if (winningStatus === "deleted") continue;
    result.push({
      subjectKey: key,
      active: entry.active.delta,
      history: entry.history
        .filter((item) => statuses.get(item.delta.id) !== "deleted")
        .map((item) => item.delta),
      anchorDepth: entry.active.anchorDepth,
      status: winningStatus === "deactivated" ? "deactivated" : "active",
    });
  }
  return result;
}

/**
 * 进入生成上下文的生效设定增量（纯函数）。
 *
 * 在 `derivePathSettingDeltas` 基础上过滤掉停用/软删除主体；超过
 * `SETTING_DELTA_MAX_ACTIVE` 时仍保留最深/最新的主体（写时已按路径拦截，
 * 这里只防御历史数据）。写时上限使用未截断的可见派生结果，避免被静默截断
 * 掩盖超限。
 */
export function deriveActiveSettingDeltas(input: {
  tree: SceneTree;
  deltas: readonly SettingDeltaV1[];
  lifecycles?: readonly SettingDeltaLifecycleV1[];
  path: readonly SceneNode[];
}): ActiveSettingDelta[] {
  const activeItems = derivePathSettingDeltas(input).filter(
    (item) => item.status === "active",
  );

  let kept = activeItems;
  if (activeItems.length > SETTING_DELTA_MAX_ACTIVE) {
    // 主体过多时保留最深/最新的若干条 active；history 随 active 一起保留。
    const keep = new Set(
      [...activeItems]
        .sort((left, right) => compareActiveEntries(right, left))
        .slice(0, SETTING_DELTA_MAX_ACTIVE)
        .map((item) => item.subjectKey),
    );
    kept = activeItems.filter((item) => keep.has(item.subjectKey));
  }

  return kept.map(({ subjectKey: key, active, history, anchorDepth }) => ({
    subjectKey: key,
    active,
    history,
    anchorDepth,
  }));
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

function assertLifecycleWorldlines(
  lifecycles: readonly SettingDeltaLifecycleV1[],
  expectedWorldlineId: string | null,
): void {
  if (expectedWorldlineId !== null) {
    for (const lifecycle of lifecycles) {
      if (lifecycle.worldlineId !== expectedWorldlineId) {
        throw new Error(
          `设定增量生命周期属于其他世界线：${lifecycle.worldlineId} != ${expectedWorldlineId}`,
        );
      }
    }
    return;
  }
  const worldlineIds = new Set(
    lifecycles.map((lifecycle) => lifecycle.worldlineId),
  );
  if (worldlineIds.size > 1) {
    throw new Error("设定增量生命周期来自多个世界线，无法派生");
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

function compareActiveEntries(
  left: PathSettingDelta,
  right: PathSettingDelta,
): number {
  if (left.anchorDepth !== right.anchorDepth) {
    return left.anchorDepth - right.anchorDepth;
  }
  if (left.active.createdAt !== right.active.createdAt) {
    return left.active.createdAt < right.active.createdAt ? -1 : 1;
  }
  if (left.active.id === right.active.id) return 0;
  return left.active.id < right.active.id ? -1 : 1;
}

function compareLifecycles(
  left: SettingDeltaLifecycleV1,
  right: SettingDeltaLifecycleV1,
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}
