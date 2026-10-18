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

import { SettingDeltaError } from "./setting-delta-error";
import {
  SETTING_DELTA_CONTEXT_MAX_CHARS,
  SETTING_DELTA_MAX_ACTIVE,
} from "./setting-delta-limits";

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

/**
 * `setting_deltas` 段标签内部的实际文本。
 *
 * 组装器渲染 Prompt 与写入时的 2k 上限检查都调用这一个函数，因此
 * “写时测量”与“真正进入 Prompt 的文本”逐字节一致，不会再出现
 * 去不可见字符/NFC 后的测量值与原始渲染值脱节。
 */
export function renderSettingDeltaContextText(
  items: readonly Pick<SettingDeltaContextItem, "text">[],
): string {
  return items.map((item) => item.text).join("\n");
}

/** 锚点子树里的每一条根→节点路径；锚点为 null 时额外包含空根路径。 */
export type SettingDeltaAffectedPath = {
  path: SceneNode[];
  /** 面向读者的路径名，例如「第 3 幕 · 灯塔熄灭」。 */
  label: string;
};

/**
 * 列出写入/重新启用会影响的全部路径。
 *
 * `anchorSceneId === null` 的规则整条世界线生效：空根路径加上树中每个节点；
 * 场景锚点的规则只在该场景及其后代生效。遍历 `childrenByParent`，顺序确定。
 */
export function settingDeltaAffectedPaths(
  tree: SceneTree,
  anchorSceneId: string | null,
): SettingDeltaAffectedPath[] {
  const paths: SettingDeltaAffectedPath[] = [];
  const appendSubtree = (node: SceneNode): void => {
    paths.push({
      path: getScenePath(tree, node.id),
      label: settingDeltaPathLabel(node),
    });
    for (const child of tree.childrenByParent.get(node.id) ?? []) {
      appendSubtree(child);
    }
  };

  if (anchorSceneId === null) {
    paths.push({ path: [], label: "分歧点" });
    for (const root of tree.childrenByParent.get(null) ?? []) {
      appendSubtree(root);
    }
    return paths;
  }

  const anchor = tree.nodes.get(anchorSceneId);
  if (!anchor) {
    throw new Error(`设定增量引用了场景树中不存在的锚点：${anchorSceneId}`);
  }
  appendSubtree(anchor);
  return paths;
}

function settingDeltaPathLabel(node: SceneNode): string {
  return `第 ${node.depth} 幕 · ${node.title}`;
}

/**
 * 写时上限：检查 anchor 子树里每条路径的 post-write 生效集合。
 *
 * 祖先规则对整棵子树生效，只检查锚点自身路径会让深层路径悄悄超过 20 条或
 * 2k，再在生成时被静默截断。这里对每条受影响路径分别派生 active 集合并用
 * 与 Prompt 完全相同的渲染函数测量；任一路径超限即 fail closed，错误信息
 * 指出具体路径。检查与插入之间没有 await（由仓储层保证同步）。
 */
export function assertSettingDeltaPathsFit(input: {
  tree: SceneTree;
  deltas: readonly SettingDeltaV1[];
  lifecycles?: readonly SettingDeltaLifecycleV1[];
  anchorSceneId: string | null;
  characters: readonly { id: string; name: string }[];
}): void {
  for (const affected of settingDeltaAffectedPaths(
    input.tree,
    input.anchorSceneId,
  )) {
    const active = derivePathSettingDeltas({
      tree: input.tree,
      deltas: input.deltas,
      lifecycles: input.lifecycles,
      path: affected.path,
    }).filter((entry) => entry.status === "active");

    if (active.length > SETTING_DELTA_MAX_ACTIVE) {
      throw new SettingDeltaError(
        "path_active_limit",
        `会使「${affected.label}」所在路径的生效设定增量超过 ${SETTING_DELTA_MAX_ACTIVE} 条：请先停用或删除该路径上的已有规则，或为已有主体改写说明`,
      );
    }

    const items = buildSettingDeltaContextItems({
      active,
      characters: input.characters,
    });
    const length = renderSettingDeltaContextText(items).length;
    if (length > SETTING_DELTA_CONTEXT_MAX_CHARS) {
      // 读者文案不显示 2000 / 当前长度等内部数字；具体数字只留在日志与
      // 稳定 code 中，文案给出可执行出路。
      throw new SettingDeltaError(
        "path_text_limit",
        `会使「${affected.label}」所在路径的设定增量过长：请缩短规则说明，或停用/删除该路径上的其他规则`,
      );
    }
  }
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

/**
 * 只回放 `createdAt <= asOfCreatedAt` 的规则与生命周期，得到“当时”的生效集合。
 *
 * 用于判断方向批次是否早于当前设定：批次创建时的 active 集合与当前不同即为
 * stale。未来才出现的生命周期不会提前生效；指向尚未回放规则的 lifecycle 会被
 * 忽略（正常只追加数据不会出现，历史/损坏数据也不应让回放直接抛“未知规则”
 * 而掩盖真正差异）。
 */
export function deriveActiveSettingDeltasAsOf(input: {
  tree: SceneTree;
  deltas: readonly SettingDeltaV1[];
  lifecycles?: readonly SettingDeltaLifecycleV1[];
  path: readonly SceneNode[];
  asOfCreatedAt: string;
}): ActiveSettingDelta[] {
  const deltas = input.deltas.filter(
    (delta) => delta.createdAt <= input.asOfCreatedAt,
  );
  const deltaIds = new Set(deltas.map((delta) => delta.id));
  const lifecycles = (input.lifecycles ?? []).filter(
    (lifecycle) =>
      lifecycle.createdAt <= input.asOfCreatedAt &&
      deltaIds.has(lifecycle.targetDeltaId),
  );
  return deriveActiveSettingDeltas({
    tree: input.tree,
    deltas,
    lifecycles,
    path: input.path,
  });
}

/**
 * 生效集合的稳定指纹。
 *
 * 只包含会进入生成上下文的语义（主体、说明、作用域）与稳定 delta id；排序后
 * 序列化，因此“停用后重新启用回同一条规则”与批次创建时完全相同，不会误报
 * stale。新增/改写/停用/软删除只要改变当前 active 集合就会得到不同指纹。
 */
export function settingDeltaActiveFingerprint(
  active: readonly ActiveSettingDelta[],
): string {
  return JSON.stringify(
    active
      .map(({ subjectKey: key, active: delta }) => [
        key,
        delta.id,
        delta.anchorSceneId,
        delta.statement,
      ])
      .sort((left, right) => {
        const leftKey = `${left[0]}\u0000${left[1]}`;
        const rightKey = `${right[0]}\u0000${right[1]}`;
        if (leftKey === rightKey) return 0;
        return leftKey < rightKey ? -1 : 1;
      }),
  );
}

/** 方向批次 stale 时统一使用的可展示中文错误/横幅文案。 */
export const SETTING_DELTA_STALE_BATCH_MESSAGE = "设定已更新，请换一批以生效";

/**
 * 方向批次是否早于当前设定增量（纯函数）。
 *
 * 回放批次 `createdAt` 时的 active 集合，与当前 active 集合比较：任何在批次
 * 之后新增、改写、停用、重新启用或软删除且影响该父路径的规则都会让两者不同。
 * 兄弟路径上的规则对 `pathToParent` 不可见，因此不会让批次变 stale。
 *
 * 不自动重新生成：stale 只阻止继续选择/重试方向，用户必须显式「换一批」。
 */
export function isDirectionBatchStale(input: {
  batch: {
    id: string;
    parentSceneId: string | null;
    createdAt: string;
    /** 新批次在生成开始时记录的 active 集合指纹；旧批次没有。 */
    settingDeltaFingerprint?: string;
  };
  tree: SceneTree;
  /** root→父节点；根批次为空数组。 */
  pathToParent: readonly SceneNode[];
  deltas: readonly SettingDeltaV1[];
  lifecycles?: readonly SettingDeltaLifecycleV1[];
}): boolean {
  assertBatchParentPath(input.batch.parentSceneId, input.pathToParent);
  const current = settingDeltaActiveFingerprint(
    deriveActiveSettingDeltas({
      tree: input.tree,
      deltas: input.deltas,
      lifecycles: input.lifecycles,
      path: input.pathToParent,
    }),
  );
  // 新批次以“组装上下文时”的指纹为准：生成期间新增规则会让当前指纹不同，
  // 即使该规则 createdAt 晚于批次落库时间也能识别。旧批次没有指纹时退回
  // 按 createdAt 回放，保持历史行为。
  if (input.batch.settingDeltaFingerprint !== undefined) {
    return current !== input.batch.settingDeltaFingerprint;
  }
  const asOf = settingDeltaActiveFingerprint(
    deriveActiveSettingDeltasAsOf({
      tree: input.tree,
      deltas: input.deltas,
      lifecycles: input.lifecycles,
      path: input.pathToParent,
      asOfCreatedAt: input.batch.createdAt,
    }),
  );
  return current !== asOf;
}

function assertBatchParentPath(
  parentSceneId: string | null,
  pathToParent: readonly SceneNode[],
): void {
  if (parentSceneId === null) {
    if (pathToParent.length !== 0) {
      throw new Error("根方向批次的父路径必须为空");
    }
    return;
  }
  if (pathToParent[pathToParent.length - 1]?.id !== parentSceneId) {
    throw new Error("方向批次的父路径与 parentSceneId 不一致");
  }
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
