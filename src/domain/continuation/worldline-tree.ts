import {
  derivePathState,
  getDefaultScenePath,
  getScenePath,
  mergeCharacterChange,
  type SceneNode,
  type SceneTree,
} from "@/domain/continuation/scene-tree";
import type {
  CharacterStatus,
  ContinuationCanonWarning,
  ContinuationDirection,
  WorldlineDelta,
} from "@/domain/schemas";

/**
 * 续写面板的方向批次视图模型。
 *
 * 场景正文不在批次里重复保存；这里只需要渲染方向选项和判断“已生成 n 版”。
 * 类型放在领域模块内，组件层与纯派生函数共用同一份定义。
 */
export type ContinuationDirectionBatchView = {
  id: string;
  parentSceneId: string | null;
  batchIndex: number;
  createdAt: string;
  directions: ContinuationDirection[];
  /** 组装上下文时生效集合的指纹；旧批次没有该字段。 */
  settingDeltaFingerprint?: string;
  /** 低置信 Canon 提示；不阻断继续选择方向。 */
  canonWarnings?: ContinuationCanonWarning[];
};

/**
 * 阅读位置：
 * - `default`：沿用既有行为，沿首选分支走到叶子；
 * - `root`：回到分歧点（空路径）；
 * - `scene`：从任意既有节点重开，包括路径中间节点。
 */
export type ReadingPosition =
  | { kind: "default" }
  | { kind: "root" }
  | { kind: "scene"; sceneId: string };

/** 解析阅读位置；`scene` 引用未知节点时与 `getScenePath` 一样 fail closed。 */
export function resolveReadingPath(
  tree: SceneTree,
  position: ReadingPosition,
): SceneNode[] {
  switch (position.kind) {
    case "default":
      return getDefaultScenePath(tree);
    case "root":
      return [];
    case "scene":
      return getScenePath(tree, position.sceneId);
  }
}

/**
 * 树视图的一行。根行表示分歧点（`id: null`），其余行对应场景节点。
 *
 * `level` 就是缩进层级：根为 0，场景与 `depth` 相同。
 * 根行没有 origin / attemptIndex，统一为 null；兄弟字段对根没有导航意义，
 * 固定为 0/1。
 */
export type WorldlineTreeRow = {
  id: string | null;
  level: number;
  title: string;
  depth: number;
  origin: SceneNode["origin"] | null;
  attemptIndex: number | null;
  siblingIndex: number;
  siblingCount: number;
  childCount: number;
  unexploredDirectionCount: number;
  onCurrentPath: boolean;
  isCurrent: boolean;
  expanded: boolean;
  hasChildren: boolean;
};

export type DirectionBatchOptions = {
  batch: ContinuationDirectionBatchView;
  directions: Array<{
    direction: ContinuationDirection;
    /** 该父节点下、由本批次本方向生成的全部场景，按树顺序（含重试）。 */
    sceneIds: string[];
  }>;
};

/**
 * 生成按先序排列的缩进树视图。
 *
 * 默认只展开分歧点与当前路径上的节点，因此当前路径、直接兄弟和当前节点的
 * 子节点可见；显式传入 `expandedIds` 时完全替换默认集合。折叠节点仍报告
 * `childCount`，只是不展开子行。
 *
 * 只读取给定 tree / directionBatches / currentPath，不访问树或批次以外的状态。
 */
export function buildWorldlineTreeOutline(input: {
  tree: SceneTree;
  directionBatches: readonly ContinuationDirectionBatchView[];
  currentPath: readonly SceneNode[];
  expandedIds?: ReadonlySet<string | null>;
}): WorldlineTreeRow[] {
  const { tree, directionBatches, currentPath } = input;
  assertCurrentPath(tree, currentPath);

  const expanded = input.expandedIds ?? defaultExpandedIds(currentPath);
  const currentIds = new Set(currentPath.map((node) => node.id));
  const currentId =
    currentPath.length === 0 ? null : currentPath[currentPath.length - 1]!.id;
  const exploredByParent = buildExploredDirectionIndex(tree);
  const batchesByParent = buildBatchIndex(directionBatches);
  const rows: WorldlineTreeRow[] = [];

  const rootChildren = tree.childrenByParent.get(null) ?? [];
  rows.push({
    id: null,
    level: 0,
    title: "分歧点",
    depth: 0,
    origin: null,
    attemptIndex: null,
    siblingIndex: 0,
    siblingCount: 1,
    childCount: rootChildren.length,
    unexploredDirectionCount: countUnexploredDirections(
      batchesByParent,
      exploredByParent,
      null,
    ),
    onCurrentPath: true,
    isCurrent: currentId === null,
    expanded: expanded.has(null),
    hasChildren: rootChildren.length > 0,
  });

  if (expanded.has(null)) appendChildren(null);

  return rows;

  function appendChildren(parentSceneId: string | null): void {
    const siblings = tree.childrenByParent.get(parentSceneId) ?? [];
    for (const [siblingIndex, scene] of siblings.entries()) {
      const childCount = tree.childrenByParent.get(scene.id)?.length ?? 0;
      rows.push({
        id: scene.id,
        level: scene.depth,
        title: scene.title,
        depth: scene.depth,
        origin: scene.origin,
        attemptIndex: scene.attemptIndex,
        siblingIndex,
        siblingCount: siblings.length,
        childCount,
        unexploredDirectionCount: countUnexploredDirections(
          batchesByParent,
          exploredByParent,
          scene.id,
        ),
        onCurrentPath: currentIds.has(scene.id),
        isCurrent: currentId === scene.id,
        expanded: expanded.has(scene.id),
        hasChildren: childCount > 0,
      });
      if (expanded.has(scene.id)) appendChildren(scene.id);
    }
  }
}

/**
 * 列出一个父节点（根或任意场景）的全部方向批次，按 batchIndex 升序。
 * 每个方向附带该批次该方向已经生成的场景 id，供界面区分
 * 「已生成 n 版 · 查看」与「选择此方向」。
 */
export function listDirectionOptions(input: {
  tree: SceneTree;
  directionBatches: readonly ContinuationDirectionBatchView[];
  parentSceneId: string | null;
}): DirectionBatchOptions[] {
  const { tree, directionBatches, parentSceneId } = input;
  const children = tree.childrenByParent.get(parentSceneId) ?? [];
  const batches = directionBatches
    .filter((batch) => batch.parentSceneId === parentSceneId)
    .sort(compareDirectionBatches);

  return batches.map((batch) => ({
    batch,
    directions: batch.directions.map((direction) => ({
      direction,
      sceneIds: children
        .filter(
          (child) =>
            child.directionsArtifactId === batch.id &&
            child.selectedDirectionId === direction.id,
        )
        .map((child) => child.id),
    })),
  }));
}

/**
 * 返回某个父节点最新的一批方向；没有批次时返回 null。
 * 依次比较 batchIndex、createdAt、id，保持确定性。
 */
export function latestBatchForParent(
  batches: readonly ContinuationDirectionBatchView[],
  parentSceneId: string | null,
): ContinuationDirectionBatchView | null {
  let latest: ContinuationDirectionBatchView | null = null;
  for (const batch of batches) {
    if (batch.parentSceneId !== parentSceneId) continue;
    if (
      !latest ||
      latest.batchIndex < batch.batchIndex ||
      (latest.batchIndex === batch.batchIndex &&
        (latest.createdAt < batch.createdAt ||
          (latest.createdAt === batch.createdAt && latest.id < batch.id)))
    ) {
      latest = batch;
    }
  }
  return latest;
}

export type PathCharacterHistoryEntry = {
  sourceKind: "divergence" | "scene";
  sceneId: string | null;
  depth: number;
  summary: string;
  /** 该条变化显式携带的状态；未改变状态时缺省。 */
  status?: CharacterStatus;
};

export type PathCharacterState = {
  characterId: string;
  name: string;
  /** 与 `derivePathState(baseDelta, path)` 中该人物的最后一条变化一致。 */
  current: string;
  /** 沿路径最后一次显式 status；从未出现则为 null，不从 Character.role 推断。 */
  currentStatus: CharacterStatus | null;
  history: PathCharacterHistoryEntry[];
};

/**
 * 按给定顺序折叠人物状态：只认显式非 null `status`，后出现的覆盖先出现的。
 *
 * 这是 `mergeCharacterChange` 的薄包装，供旧调用点与测试使用；真正的
 * 路径派生统一读取 `derivePathState` 的折叠结果。
 */
export function foldCharacterStatus(
  changes: readonly { status?: CharacterStatus | null }[],
): CharacterStatus | null {
  let status: CharacterStatus | null = null;
  for (const change of changes) {
    status = mergeCharacterChange(
      status === null ? undefined : { characterId: "", summary: "", status },
      { characterId: "", summary: "", status: change.status },
    ).status ?? null;
  }
  return status;
}

/**
 * 沿当前路径推导人物状态时间线（分歧点 → 路径上的每个场景）。
 *
 * 先调用 `derivePathState` 复用同一套 fail-closed 校验（跨世界线、断裂父子链、
 * 深度不连续、非法 statePatch 都会抛错），因此只读取给定路径，兄弟分支的人物
 * 变化不会泄漏。人物按 `characters` 输入顺序输出；不在输入中的未知人物按首次
 * 出现顺序排在已知人物之后，并以 id 作为名称。
 */
export function derivePathCharacterTimeline(input: {
  baseDelta: WorldlineDelta;
  path: readonly SceneNode[];
  characters: readonly { id: string; name: string }[];
}): PathCharacterState[] {
  const { baseDelta, path, characters } = input;
  // 先完整校验路径与补丁，再派生时间线。
  const finalState = derivePathState(baseDelta, path);

  const historyByCharacter = new Map<string, PathCharacterHistoryEntry[]>();
  const append = (
    characterId: string,
    entry: PathCharacterHistoryEntry,
  ) => {
    const history = historyByCharacter.get(characterId) ?? [];
    history.push(entry);
    historyByCharacter.set(characterId, history);
  };

  for (const change of baseDelta.characterChanges) {
    append(change.characterId, {
      sourceKind: "divergence",
      sceneId: null,
      depth: 0,
      summary: change.summary,
      ...(change.status === null || change.status === undefined
        ? {}
        : { status: change.status }),
    });
  }
  for (const node of path) {
    for (const change of node.statePatch.characterChanges) {
      append(change.characterId, {
        sourceKind: "scene",
        sceneId: node.id,
        depth: node.depth,
        summary: change.summary,
        ...(change.status === null || change.status === undefined
        ? {}
        : { status: change.status }),
      });
    }
  }

  const currentById = new Map(
    finalState.characterChanges.map((change) => [
      change.characterId,
      change.summary,
    ]),
  );
  // 状态直接取 derivePathState 的折叠结果；这里不再独立 fold 一次。
  const statusById = new Map(
    finalState.characterChanges
      .filter((change) => change.status !== undefined)
      .map((change) => [change.characterId, change.status!]),
  );
  const knownIds = new Set(characters.map((character) => character.id));
  const result: PathCharacterState[] = [];

  const statusFor = (characterId: string): CharacterStatus | null =>
    statusById.get(characterId) ?? null;

  for (const character of characters) {
    const history = historyByCharacter.get(character.id);
    if (!history) continue;
    result.push({
      characterId: character.id,
      name: character.name,
      current: currentById.get(character.id) ?? history[history.length - 1]!.summary,
      currentStatus: statusFor(character.id),
      history,
    });
  }
  for (const [characterId, history] of historyByCharacter) {
    if (knownIds.has(characterId)) continue;
    result.push({
      characterId,
      name: characterId,
      current: currentById.get(characterId) ?? history[history.length - 1]!.summary,
      currentStatus: statusFor(characterId),
      history,
    });
  }

  return result;
}

function assertCurrentPath(
  tree: SceneTree,
  currentPath: readonly SceneNode[],
): void {
  if (currentPath.length === 0) return;
  const target = currentPath[currentPath.length - 1]!;
  const expected = getScenePath(tree, target.id);
  if (
    expected.length !== currentPath.length ||
    expected.some((node, index) => node.id !== currentPath[index]!.id)
  ) {
    throw new Error("世界线树视图的当前路径不属于给定场景树");
  }
}

function defaultExpandedIds(
  currentPath: readonly SceneNode[],
): Set<string | null> {
  const expanded = new Set<string | null>([null]);
  for (const node of currentPath) expanded.add(node.id);
  return expanded;
}

function buildBatchIndex(
  batches: readonly ContinuationDirectionBatchView[],
): Map<string | null, ContinuationDirectionBatchView[]> {
  const byParent = new Map<string | null, ContinuationDirectionBatchView[]>();
  for (const batch of batches) {
    const siblings = byParent.get(batch.parentSceneId) ?? [];
    siblings.push(batch);
    byParent.set(batch.parentSceneId, siblings);
  }
  return byParent;
}

function buildExploredDirectionIndex(
  tree: SceneTree,
): Map<string | null, Set<string>> {
  const byParent = new Map<string | null, Set<string>>();
  for (const node of tree.nodes.values()) {
    const explored = byParent.get(node.parentSceneId) ?? new Set<string>();
    explored.add(directionKey(node.directionsArtifactId, node.selectedDirectionId));
    byParent.set(node.parentSceneId, explored);
  }
  return byParent;
}

function countUnexploredDirections(
  batchesByParent: ReadonlyMap<
    string | null,
    readonly ContinuationDirectionBatchView[]
  >,
  exploredByParent: ReadonlyMap<string | null, ReadonlySet<string>>,
  parentSceneId: string | null,
): number {
  const explored = exploredByParent.get(parentSceneId);
  let count = 0;
  for (const batch of batchesByParent.get(parentSceneId) ?? []) {
    for (const direction of batch.directions) {
      if (!explored?.has(directionKey(batch.id, direction.id))) count += 1;
    }
  }
  return count;
}

function directionKey(batchId: string, directionId: string): string {
  return `${batchId}\u0000${directionId}`;
}

function compareDirectionBatches(
  left: ContinuationDirectionBatchView,
  right: ContinuationDirectionBatchView,
): number {
  if (left.batchIndex !== right.batchIndex) {
    return left.batchIndex - right.batchIndex;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}
