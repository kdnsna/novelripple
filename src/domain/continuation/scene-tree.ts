import {
  StatePatchSchema,
  WorldlineDeltaSchema,
  type ContextManifest,
  type ContinuationSceneV1,
  type ContinuationSceneV2,
  type StatePatch,
  type WorldlineDelta,
} from "@/domain/schemas";

/** v1 与 v2 场景领域对象的联合；节点树只读取不可变字段。 */
export type ScenePayload = ContinuationSceneV1 | ContinuationSceneV2;

/**
 * 归一化后的场景节点。
 *
 * v1 场景没有树字段，统一映射为“分歧点后的第一个节点”：
 * `parentSceneId: null`、`depth: 1`、`origin: "generated"`、
 * `attemptIndex: 0`、`summary: null`、`contextManifest: null`。
 */
export type SceneNode = {
  id: string;
  worldlineId: string;
  acceptedImpactPlanId: string;
  directionsArtifactId: string;
  selectedDirectionId: string;
  parentSceneId: string | null;
  depth: number;
  origin: "generated" | "retry";
  attemptIndex: number;
  summary: string | null;
  contextManifest: ContextManifest | null;
  title: string;
  prose: string;
  statePatch: StatePatch;
  contentKind: "generated";
  createdAt: string;
  schemaVersion: 1 | 2;
};

export type SceneTree = {
  nodes: ReadonlyMap<string, SceneNode>;
  /** null 键对应根节点（父场景为分歧点）。兄弟节点按 createdAt、id 排序。 */
  childrenByParent: ReadonlyMap<string | null, readonly SceneNode[]>;
};

/**
 * 从同一世界线的场景列表构建只读树。
 *
 * fail closed：重复 id、未知父节点、跨世界线父节点、深度不连续、
 * 根节点深度不是 1、循环引用都会抛错，不返回部分结果。
 */
export function buildSceneTree(scenes: readonly ScenePayload[]): SceneTree {
  const nodes = new Map<string, SceneNode>();
  for (const scene of scenes) {
    const node = normalizeSceneNode(scene);
    if (nodes.has(node.id)) {
      throw new Error(`场景树包含重复节点：${node.id}`);
    }
    nodes.set(node.id, node);
  }

  for (const node of nodes.values()) {
    if (node.parentSceneId === null) continue;
    const parent = nodes.get(node.parentSceneId);
    if (!parent) {
      throw new Error(`场景引用了未知父节点：${node.parentSceneId}`);
    }
    if (parent.worldlineId !== node.worldlineId) {
      throw new Error(
        `场景父节点属于其他世界线：${node.id} -> ${parent.id}`,
      );
    }
  }

  assertNoCycles(nodes);

  for (const node of nodes.values()) {
    if (node.parentSceneId === null) {
      if (node.depth !== 1) {
        throw new Error(`根场景深度必须为 1：${node.id}`);
      }
      continue;
    }
    const parent = nodes.get(node.parentSceneId);
    if (!parent) throw new Error(`场景引用了未知父节点：${node.parentSceneId}`);
    if (node.depth !== parent.depth + 1) {
      throw new Error(
        `场景深度不连续：${node.id} 深度 ${node.depth}，父节点 ${parent.id} 深度 ${parent.depth}`,
      );
    }
  }

  const childrenByParent = new Map<string | null, SceneNode[]>();
  for (const node of nodes.values()) {
    const siblings = childrenByParent.get(node.parentSceneId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentSceneId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort(compareSceneNodes);
  }

  return { nodes, childrenByParent };
}

/**
 * 返回默认选中的最深路径。
 *
 * 从根开始，每一层优先选择 `attemptIndex === 0` 的节点（首次生成），
 * 没有首次生成时选择最早的兄弟节点。结果始终是当前树的一条真实路径。
 */
export function getDefaultScenePath(tree: SceneTree): SceneNode[] {
  const path: SceneNode[] = [];
  let siblings = tree.childrenByParent.get(null) ?? [];
  while (siblings.length > 0) {
    const next = siblings.find((node) => node.attemptIndex === 0) ?? siblings[0]!;
    path.push(next);
    siblings = tree.childrenByParent.get(next.id) ?? [];
  }
  return path;
}

/** 返回从根到目标节点的路径；未知节点 fail closed。 */
export function getScenePath(tree: SceneTree, nodeId: string): SceneNode[] {
  const target = tree.nodes.get(nodeId);
  if (!target) throw new Error(`场景树中不存在节点：${nodeId}`);

  const path: SceneNode[] = [];
  const seen = new Set<string>();
  let current: SceneNode | undefined = target;
  while (current) {
    if (seen.has(current.id)) {
      throw new Error(`场景树存在循环引用：${current.id}`);
    }
    seen.add(current.id);
    path.push(current);
    current =
      current.parentSceneId === null
        ? undefined
        : tree.nodes.get(current.parentSceneId);
  }
  return path.reverse();
}

/**
 * 把一个场景的 statePatch 折叠进当前路径状态。
 *
 * 语义与 `validateContinuationStatePatch` 对齐：
 * - 新增事实追加；删除事实进入 `factsRemoved`，并从 `factsAdded` 中移除；
 * - 线索保持 `open = threadsOpened − threadsClosed`，重新开启会从 closed 移除；
 * - 同一人物后来的变化替换先前变化。
 *
 * 结果始终通过 `WorldlineDeltaSchema`，因此不会产生重复 key。
 */
export function applyStatePatch(
  delta: WorldlineDelta,
  patch: StatePatch,
): WorldlineDelta {
  const current = WorldlineDeltaSchema.parse(delta);
  const parsedPatch = StatePatchSchema.parse(patch);

  const factsAdded = new Map(current.factsAdded.map((fact) => [fact.key, fact]));
  const factsRemoved = new Set(current.factsRemoved);

  for (const key of parsedPatch.factsRemoved) {
    if (factsRemoved.has(key)) {
      throw new Error(`路径状态补丁重复删除事实：${key}`);
    }
    factsRemoved.add(key);
    factsAdded.delete(key);
  }
  for (const fact of parsedPatch.factsAdded) {
    if (factsRemoved.has(fact.key)) {
      throw new Error(`路径状态补丁试图恢复已删除事实：${fact.key}`);
    }
    if (factsAdded.has(fact.key)) {
      throw new Error(`路径状态补丁重复新增事实：${fact.key}`);
    }
    factsAdded.set(fact.key, fact);
  }

  const threadsOpened = new Set(current.threadsOpened);
  const threadsClosed = new Set(current.threadsClosed);
  const isOpen = (thread: string) =>
    threadsOpened.has(thread) && !threadsClosed.has(thread);

  for (const thread of parsedPatch.threadsOpened) {
    if (isOpen(thread)) {
      throw new Error(`路径状态补丁重复开启线索：${thread}`);
    }
    threadsClosed.delete(thread);
    threadsOpened.add(thread);
  }
  for (const thread of parsedPatch.threadsClosed) {
    if (threadsClosed.has(thread)) {
      throw new Error(`路径状态补丁重复关闭线索：${thread}`);
    }
    if (!isOpen(thread)) {
      throw new Error(`路径状态补丁关闭了尚未开启的线索：${thread}`);
    }
    // WorldlineDeltaSchema 要求两个列表不相交；关闭时从 opened 移除，
    // open = threadsOpened − threadsClosed 仍然成立。
    threadsOpened.delete(thread);
    threadsClosed.add(thread);
  }

  const characterChanges = new Map(
    current.characterChanges.map((change) => [change.characterId, change]),
  );
  for (const change of parsedPatch.characterChanges) {
    characterChanges.set(change.characterId, change);
  }

  return WorldlineDeltaSchema.parse({
    factsAdded: [...factsAdded.values()],
    factsRemoved: [...factsRemoved],
    characterChanges: [...characterChanges.values()],
    threadsOpened: [...threadsOpened],
    threadsClosed: [...threadsClosed],
  });
}

/**
 * 只沿给定路径折叠状态。任何跨世界线、重复节点或断裂的父子链都会失败，
 * 从而保证兄弟分支的状态不会进入结果。
 */
export function derivePathState(
  baseDelta: WorldlineDelta,
  pathNodes: readonly SceneNode[],
): WorldlineDelta {
  let state = WorldlineDeltaSchema.parse(baseDelta);
  const worldlineId = pathNodes[0]?.worldlineId;
  const seen = new Set<string>();

  for (const [index, node] of pathNodes.entries()) {
    if (node.worldlineId !== worldlineId) {
      throw new Error("路径状态不能跨世界线折叠");
    }
    if (seen.has(node.id)) {
      throw new Error(`路径状态包含重复节点：${node.id}`);
    }
    seen.add(node.id);
    const expectedParentId = index === 0 ? null : pathNodes[index - 1]!.id;
    if (node.parentSceneId !== expectedParentId) {
      throw new Error(`路径状态包含断裂的父子链：${node.id}`);
    }
    if (node.depth !== index + 1) {
      throw new Error(`路径状态深度不连续：${node.id}`);
    }
    state = applyStatePatch(state, node.statePatch);
  }

  return state;
}

function normalizeSceneNode(scene: ScenePayload): SceneNode {
  const base = {
    id: scene.id,
    worldlineId: scene.worldlineId,
    acceptedImpactPlanId: scene.acceptedImpactPlanId,
    directionsArtifactId: scene.directionsArtifactId,
    selectedDirectionId: scene.selectedDirectionId,
    title: scene.title,
    prose: scene.prose,
    statePatch: scene.statePatch,
    contentKind: scene.contentKind,
    createdAt: scene.createdAt,
    schemaVersion: scene.schemaVersion,
  } as const;

  if (scene.schemaVersion === 1) {
    return {
      ...base,
      parentSceneId: null,
      depth: 1,
      origin: "generated",
      attemptIndex: 0,
      summary: null,
      contextManifest: null,
    };
  }

  return {
    ...base,
    parentSceneId: scene.parentSceneId,
    depth: scene.depth,
    origin: scene.origin,
    attemptIndex: scene.attemptIndex,
    summary: scene.summary,
    contextManifest: scene.contextManifest,
  };
}

function assertNoCycles(nodes: ReadonlyMap<string, SceneNode>): void {
  for (const start of nodes.values()) {
    const seen = new Set<string>();
    let current: SceneNode | undefined = start;
    while (current) {
      if (seen.has(current.id)) {
        throw new Error(`场景树存在循环引用：${start.id}`);
      }
      seen.add(current.id);
      current =
        current.parentSceneId === null
          ? undefined
          : nodes.get(current.parentSceneId);
    }
  }
}

function compareSceneNodes(left: SceneNode, right: SceneNode): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}
