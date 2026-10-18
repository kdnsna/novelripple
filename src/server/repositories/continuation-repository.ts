import { createHash } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";

import {
  ContinuationArtifactSchema,
  ContinuationDirectionsArtifactSchema,
  ContinuationDirectionsModelOutputSchema,
  ContinuationDirectionsSchema,
  ContinuationSceneArtifactSchema,
  ContinuationSceneModelOutputSchema,
  ContinuationSceneModelOutputV3Schema,
  ContinuationSchema,
  SettingDeltaArtifactSchema,
  SettingDeltaLifecycleArtifactSchema,
  SettingDeltaLifecycleStatusSchema,
  SettingDeltaLifecycleV1Schema,
  SettingDeltaSubjectSchema,
  SettingDeltaV1Schema,
  type ContinuationArtifact,
  type ContinuationDirectionsArtifact,
  type ContinuationDirectionsModelOutput,
  type ContinuationSceneArtifact,
  type ContinuationSceneModelOutput,
  type ContextManifest,
  type ImpactPlanArtifact,
  type SettingDeltaArtifact,
  type SettingDeltaLifecycleArtifact,
  type SettingDeltaLifecycleStatus,
  type SettingDeltaLifecycleV1,
  type SettingDeltaSubject,
  type SettingDeltaV1,
  type Worldline,
} from "@/domain/schemas";
import {
  SETTING_DELTA_CONTEXT_MAX_CHARS,
  SETTING_DELTA_MAX_ACTIVE,
  SETTING_DELTA_MAX_PER_WORLDLINE,
} from "@/domain/continuation/setting-delta-limits";
import {
  buildSceneTree,
  getScenePath,
  type SceneTree,
} from "@/domain/continuation/scene-tree";
import {
  buildSettingDeltaContextItems,
  derivePathSettingDeltas,
  normalizedContextChars,
  serializeSettingDeltasForContext,
  settingDeltaLifecycleStatuses,
  subjectKey,
  type ActiveSettingDelta,
} from "@/domain/continuation/setting-deltas";
import { getDatabase } from "@/server/db/client";
import { artifacts } from "@/server/db/schema";
import { getGenerationRun } from "@/server/repositories/generation-run-repository";
import { getWorldline } from "@/server/repositories/ripple-repository";
import { getStoryMapArtifact } from "@/server/repositories/story-map-artifact-repository";

export type ContinuationArtifactLists = {
  directions: ContinuationDirectionsArtifact[];
  scenes: ContinuationSceneArtifact[];
  settingDeltas: SettingDeltaArtifact[];
  settingDeltaLifecycles: SettingDeltaLifecycleArtifact[];
};

export function createContinuationDirectionsArtifact(input: {
  projectId: string;
  sourceId: string;
  worldline: Worldline;
  acceptedImpactPlanArtifact: ImpactPlanArtifact;
  output: ContinuationDirectionsModelOutput;
  generationRunId: string;
}): ContinuationDirectionsArtifact {
  const output = ContinuationDirectionsModelOutputSchema.parse(input.output);
  assertActiveBindings(input);
  assertGenerationRun({
    id: input.generationRunId,
    projectId: input.projectId,
    worldlineId: input.worldline.id,
    kind: "continuation_directions",
  });

  const id = stableDirectionsArtifactId(input.worldline.id);
  const createdAt = new Date().toISOString();
  const continuation = ContinuationDirectionsSchema.parse({
    schemaVersion: 1,
    id,
    worldlineId: input.worldline.id,
    acceptedImpactPlanId: input.acceptedImpactPlanArtifact.id,
    directions: output.directions.map((direction, index) => ({
      id: stableDirectionId(id, index),
      ...direction,
    })),
    createdAt,
  });
  const artifact = ContinuationDirectionsArtifactSchema.parse({
    id,
    projectId: input.projectId,
    sourceId: input.sourceId,
    worldlineId: input.worldline.id,
    kind: "continuation",
    artifactType: "directions",
    schemaVersion: 1,
    continuation,
    basedOnArtifactId: input.acceptedImpactPlanArtifact.id,
    generationRunId: input.generationRunId,
    createdAt,
  });

  insertContinuationArtifact(artifact);
  const stored = getContinuationArtifact(artifact.id);
  if (!stored || stored.artifactType !== "directions") {
    throw new Error("后续方向 Artifact 写入失败");
  }
  return stored;
}

/**
 * 场景节点树的方向批次（schemaVersion 2）。
 *
 * id 由 (worldlineId, parentSceneId ?? "root", batchIndex) 确定性派生：
 * 并发重复请求会命中同一 id，insert-or-return-existing，不产生重复批次。
 */
export function createContinuationDirectionsArtifactV2(input: {
  projectId: string;
  sourceId: string;
  worldline: Worldline;
  acceptedImpactPlanArtifact: ImpactPlanArtifact;
  parentSceneId: string | null;
  batchIndex: number;
  output: ContinuationDirectionsModelOutput;
  generationRunId: string;
}): ContinuationDirectionsArtifact {
  const output = ContinuationDirectionsModelOutputSchema.parse(input.output);
  assertActiveBindings(input);
  if (input.parentSceneId !== null) {
    assertParentScene({
      parentSceneId: input.parentSceneId,
      projectId: input.projectId,
      worldlineId: input.worldline.id,
    });
  }
  if (!Number.isInteger(input.batchIndex) || input.batchIndex < 0) {
    throw new Error(`方向批次索引必须是非负整数：${input.batchIndex}`);
  }
  assertGenerationRun({
    id: input.generationRunId,
    projectId: input.projectId,
    worldlineId: input.worldline.id,
    kind: "continuation_directions",
  });

  const id = stableDirectionsArtifactIdV2(
    input.worldline.id,
    input.parentSceneId,
    input.batchIndex,
  );
  const createdAt = new Date().toISOString();
  const continuation = ContinuationDirectionsSchema.parse({
    schemaVersion: 2,
    id,
    worldlineId: input.worldline.id,
    acceptedImpactPlanId: input.acceptedImpactPlanArtifact.id,
    parentSceneId: input.parentSceneId,
    batchIndex: input.batchIndex,
    directions: output.directions.map((direction, index) => ({
      id: stableDirectionId(id, index),
      ...direction,
    })),
    createdAt,
  });
  const artifact = ContinuationDirectionsArtifactSchema.parse({
    id,
    projectId: input.projectId,
    sourceId: input.sourceId,
    worldlineId: input.worldline.id,
    kind: "continuation",
    artifactType: "directions",
    schemaVersion: 2,
    continuation,
    basedOnArtifactId: input.acceptedImpactPlanArtifact.id,
    generationRunId: input.generationRunId,
    createdAt,
  });

  insertContinuationArtifact(artifact);
  const stored = getContinuationArtifact(artifact.id);
  if (
    !stored ||
    stored.artifactType !== "directions" ||
    stored.continuation.schemaVersion !== 2 ||
    stored.continuation.parentSceneId !== input.parentSceneId ||
    stored.continuation.batchIndex !== input.batchIndex
  ) {
    throw new Error("后续方向 Artifact 写入失败");
  }
  return stored;
}

export function createContinuationSceneArtifact(input: {
  projectId: string;
  sourceId: string;
  worldline: Worldline;
  acceptedImpactPlanArtifact: ImpactPlanArtifact;
  directionsArtifact: ContinuationDirectionsArtifact;
  selectedDirectionId: string;
  output: ContinuationSceneModelOutput;
  generationRunId: string;
}): ContinuationSceneArtifact {
  const output = ContinuationSceneModelOutputSchema.parse(input.output);
  assertActiveBindings(input);
  assertDirectionsBinding({
    projectId: input.projectId,
    sourceId: input.sourceId,
    worldlineId: input.worldline.id,
    acceptedImpactPlanId: input.acceptedImpactPlanArtifact.id,
    directionsArtifact: input.directionsArtifact,
    selectedDirectionId: input.selectedDirectionId,
  });
  assertGenerationRun({
    id: input.generationRunId,
    projectId: input.projectId,
    worldlineId: input.worldline.id,
    kind: "continuation_scene",
  });

  const id = stableSceneArtifactId(input.worldline.id);
  const createdAt = new Date().toISOString();
  const continuation = ContinuationSchema.parse({
    schemaVersion: 1,
    id,
    worldlineId: input.worldline.id,
    acceptedImpactPlanId: input.acceptedImpactPlanArtifact.id,
    directionsArtifactId: input.directionsArtifact.id,
    selectedDirectionId: input.selectedDirectionId,
    sequence: 1,
    ...output,
    contentKind: "generated",
    createdAt,
  });
  const artifact = ContinuationSceneArtifactSchema.parse({
    id,
    projectId: input.projectId,
    sourceId: input.sourceId,
    worldlineId: input.worldline.id,
    kind: "continuation",
    artifactType: "scene",
    schemaVersion: 1,
    continuation,
    basedOnArtifactId: input.directionsArtifact.id,
    generationRunId: input.generationRunId,
    createdAt,
  });

  insertContinuationArtifact(artifact);
  const stored = getContinuationArtifact(artifact.id);
  if (!stored || stored.artifactType !== "scene") {
    throw new Error("后续场景 Artifact 写入失败");
  }
  if (
    stored.continuation.directionsArtifactId !== input.directionsArtifact.id ||
    stored.continuation.selectedDirectionId !== input.selectedDirectionId
  ) {
    throw new Error("v1 场景 Artifact 只支持一个后续场景，不能更换已生成方向");
  }
  return stored;
}

/**
 * 场景树节点（schemaVersion 2）。
 *
 * id 由 (directionsArtifactId, selectedDirectionId, attemptIndex) 确定性派生：
 * 同一方向重试会得到递增 attemptIndex，从而获得新的兄弟节点；
 * 并发重复请求若撞上同一 attemptIndex，则幂等返回已有节点。
 */
export function createContinuationSceneArtifactV2(input: {
  projectId: string;
  sourceId: string;
  worldline: Worldline;
  acceptedImpactPlanArtifact: ImpactPlanArtifact;
  directionsArtifact: ContinuationDirectionsArtifact;
  selectedDirectionId: string;
  parentSceneId: string | null;
  depth: number;
  origin: "generated" | "retry";
  attemptIndex: number;
  summary: string;
  contextManifest: ContextManifest;
  output: ContinuationSceneModelOutput;
  generationRunId: string;
}): ContinuationSceneArtifact {
  const output = ContinuationSceneModelOutputV3Schema.parse({
    ...input.output,
    summary: input.summary,
  });
  assertActiveBindings(input);
  assertDirectionsBinding({
    projectId: input.projectId,
    sourceId: input.sourceId,
    worldlineId: input.worldline.id,
    acceptedImpactPlanId: input.acceptedImpactPlanArtifact.id,
    directionsArtifact: input.directionsArtifact,
    selectedDirectionId: input.selectedDirectionId,
  });
  const directionsParentSceneId =
    input.directionsArtifact.continuation.schemaVersion === 2
      ? input.directionsArtifact.continuation.parentSceneId
      : null;
  if (directionsParentSceneId !== input.parentSceneId) {
    throw new Error("后续场景父节点与方向批次不一致");
  }
  if (input.parentSceneId !== null) {
    const parent = assertParentScene({
      parentSceneId: input.parentSceneId,
      projectId: input.projectId,
      worldlineId: input.worldline.id,
    });
    const parentDepth =
      parent.continuation.schemaVersion === 1
        ? 1
        : parent.continuation.depth;
    if (input.depth !== parentDepth + 1) {
      throw new Error("后续场景深度必须等于父场景深度加一");
    }
  } else if (input.depth !== 1) {
    throw new Error("根场景深度必须为 1");
  }
  if (!Number.isInteger(input.attemptIndex) || input.attemptIndex < 0) {
    throw new Error(`场景尝试索引必须是非负整数：${input.attemptIndex}`);
  }
  assertGenerationRun({
    id: input.generationRunId,
    projectId: input.projectId,
    worldlineId: input.worldline.id,
    kind: "continuation_scene",
  });

  const id = stableSceneArtifactIdV2(
    input.directionsArtifact.id,
    input.selectedDirectionId,
    input.attemptIndex,
  );
  const createdAt = new Date().toISOString();
  const continuation = ContinuationSchema.parse({
    schemaVersion: 2,
    id,
    worldlineId: input.worldline.id,
    acceptedImpactPlanId: input.acceptedImpactPlanArtifact.id,
    directionsArtifactId: input.directionsArtifact.id,
    selectedDirectionId: input.selectedDirectionId,
    title: output.title,
    prose: output.prose,
    statePatch: output.statePatch,
    parentSceneId: input.parentSceneId,
    depth: input.depth,
    origin: input.origin,
    attemptIndex: input.attemptIndex,
    summary: output.summary,
    contextManifest: input.contextManifest,
    contentKind: "generated",
    createdAt,
  });
  const artifact = ContinuationSceneArtifactSchema.parse({
    id,
    projectId: input.projectId,
    sourceId: input.sourceId,
    worldlineId: input.worldline.id,
    kind: "continuation",
    artifactType: "scene",
    schemaVersion: 2,
    continuation,
    basedOnArtifactId: input.directionsArtifact.id,
    generationRunId: input.generationRunId,
    createdAt,
  });

  insertContinuationArtifact(artifact);
  const stored = getContinuationArtifact(artifact.id);
  if (
    !stored ||
    stored.artifactType !== "scene" ||
    stored.continuation.schemaVersion !== 2 ||
    stored.continuation.parentSceneId !== input.parentSceneId ||
    stored.continuation.depth !== input.depth ||
    stored.continuation.attemptIndex !== input.attemptIndex
  ) {
    throw new Error("后续场景 Artifact 写入失败");
  }
  return stored;
}

/**
 * 读者设定的路径作用域增量（`artifactType: "setting_delta"`）。
 *
 * 不调用模型，因此没有 Generation Run / basedOnArtifactId。id 由
 * (worldlineId, anchorSceneId ?? "root", idempotencyKey) 确定性派生；
 * 同一幂等键的重复/并发写入返回已有行。旧规则永不 UPDATE，修订 = 新行。
 */
export function createSettingDeltaArtifact(input: {
  projectId: string;
  worldlineId: string;
  anchorSceneId: string | null;
  subject: SettingDeltaSubject;
  statement: string;
  idempotencyKey: string;
}): SettingDeltaArtifact {
  const subject = SettingDeltaSubjectSchema.parse(input.subject);
  const statement = input.statement.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  if (statement.length === 0 || statement.length > 200) {
    throw new Error("设定增量说明必须为 1–200 个字符");
  }
  if (idempotencyKey.length === 0 || idempotencyKey.length > 200) {
    throw new Error("设定增量幂等键必须为 1–200 个字符");
  }

  const worldline = getWorldline(input.worldlineId);
  if (!worldline || worldline.projectId !== input.projectId) {
    throw new Error("Worldline 不存在或不属于当前项目");
  }
  const storyMapArtifact = getStoryMapArtifact(
    worldline.baseStoryMapArtifactId,
  );
  if (
    !storyMapArtifact ||
    storyMapArtifact.projectId !== input.projectId ||
    storyMapArtifact.storyMap.status !== "confirmed"
  ) {
    throw new Error("设定增量必须绑定当前项目的 confirmed Story Map 基线");
  }
  if (input.anchorSceneId !== null) {
    const anchor = getContinuationArtifact(input.anchorSceneId);
    if (
      !anchor ||
      anchor.artifactType !== "scene" ||
      anchor.projectId !== input.projectId ||
      anchor.worldlineId !== worldline.id
    ) {
      throw new Error("锚点场景不属于当前 Worldline");
    }
  }
  if (subject.kind === "character") {
    if (
      !storyMapArtifact.storyMap.characters.some(
        (character) => character.id === subject.characterId,
      )
    ) {
      throw new Error("设定增量的人物不在当前 Worldline 的 Story Map 中");
    }
  }

  const id = stableSettingDeltaArtifactId(
    worldline.id,
    input.anchorSceneId,
    idempotencyKey,
  );
  const existing = getContinuationArtifact(id);
  if (existing) {
    if (
      existing.artifactType !== "setting_delta" ||
      existing.worldlineId !== worldline.id ||
      existing.settingDelta.anchorSceneId !== input.anchorSceneId
    ) {
      throw new Error("设定增量幂等键已被其他内容占用");
    }
    return existing;
  }

  const state = loadSettingDeltaState(worldline.id);
  const path =
    input.anchorSceneId === null
      ? []
      : getScenePath(state.tree, input.anchorSceneId);
  const statuses = settingDeltaLifecycleStatuses(state.lifecycles);
  const nonDeletedCount = state.deltas.filter(
    (delta) => statuses.get(delta.id) !== "deleted",
  ).length;
  if (nonDeletedCount >= SETTING_DELTA_MAX_PER_WORLDLINE) {
    throw new Error(
      `设定增量已达到每条世界线的上限（${SETTING_DELTA_MAX_PER_WORLDLINE} 条）`,
    );
  }

  const createdAt = new Date().toISOString();
  const settingDelta = SettingDeltaV1Schema.parse({
    id,
    worldlineId: worldline.id,
    anchorSceneId: input.anchorSceneId,
    subject,
    statement,
    contentKind: "user",
    createdAt,
  });

  // 写时按新规则所在的锚点路径检查：同一主体的替换不增加 active 数，
  // 新主体在已有 20 个生效主体时直接拒绝，而不是靠派生时静默截断。
  const activeBefore = derivePathSettingDeltas({
    tree: state.tree,
    deltas: state.deltas,
    lifecycles: state.lifecycles,
    path,
  }).filter((entry) => entry.status === "active");
  const replacesActiveSubject = activeBefore.some(
    (entry) => entry.subjectKey === subjectKey(subject),
  );
  const proposedActive = derivePathSettingDeltas({
    tree: state.tree,
    deltas: [...state.deltas, settingDelta],
    lifecycles: state.lifecycles,
    path,
  }).filter((entry) => entry.status === "active");
  if (
    proposedActive.length > SETTING_DELTA_MAX_ACTIVE &&
    !replacesActiveSubject
  ) {
    throw new Error(
      `当前路径最多保留 ${SETTING_DELTA_MAX_ACTIVE} 条生效设定增量：请先停用或删除本路径上的已有规则，或为已有主体改写说明`,
    );
  }
  assertSettingDeltaContextFits({
    active: proposedActive,
    characters: storyMapArtifact.storyMap.characters,
  });

  const artifact = SettingDeltaArtifactSchema.parse({
    id,
    projectId: input.projectId,
    sourceId: storyMapArtifact.sourceId,
    worldlineId: worldline.id,
    kind: "continuation",
    artifactType: "setting_delta",
    schemaVersion: 1,
    settingDelta,
    basedOnArtifactId: null,
    generationRunId: null,
    createdAt,
  });

  insertContinuationArtifact(artifact);
  const stored = getContinuationArtifact(artifact.id);
  if (
    !stored ||
    stored.artifactType !== "setting_delta" ||
    stored.settingDelta.anchorSceneId !== input.anchorSceneId ||
    stored.settingDelta.statement !== statement
  ) {
    throw new Error("设定增量 Artifact 写入失败");
  }
  return stored;
}

/**
 * 追加一条设定增量生命周期事件（停用 / 重新启用 / 软删除）。
 *
 * 原始 `setting_delta` 行永不 UPDATE；id 由 (worldlineId, targetDeltaId,
 * idempotencyKey) 确定性派生，重复/并发请求返回同一事件。
 * `reactivated` 会重新把规则算回生效集合，因此必须重新检查路径 active 数与
 * 序列化上限；停用和软删除只会释放名额。
 */
export function createSettingDeltaLifecycleArtifact(input: {
  projectId: string;
  worldlineId: string;
  targetDeltaId: string;
  status: SettingDeltaLifecycleStatus;
  idempotencyKey: string;
}): SettingDeltaLifecycleArtifact {
  const status = SettingDeltaLifecycleStatusSchema.parse(input.status);
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0 || idempotencyKey.length > 200) {
    throw new Error("设定增量生命周期幂等键必须为 1–200 个字符");
  }

  const worldline = getWorldline(input.worldlineId);
  if (!worldline || worldline.projectId !== input.projectId) {
    throw new Error("Worldline 不存在或不属于当前项目");
  }
  const target = getContinuationArtifact(input.targetDeltaId);
  if (
    !target ||
    target.artifactType !== "setting_delta" ||
    target.projectId !== input.projectId ||
    target.worldlineId !== worldline.id
  ) {
    throw new Error("设定增量不存在或不属于当前 Worldline");
  }
  const storyMapArtifact = getStoryMapArtifact(
    worldline.baseStoryMapArtifactId,
  );
  if (
    !storyMapArtifact ||
    storyMapArtifact.projectId !== input.projectId ||
    storyMapArtifact.storyMap.status !== "confirmed"
  ) {
    throw new Error("设定增量必须绑定当前项目的 confirmed Story Map 基线");
  }

  const id = stableSettingDeltaLifecycleArtifactId(
    worldline.id,
    target.id,
    idempotencyKey,
  );
  const existing = getContinuationArtifact(id);
  if (existing) {
    if (
      existing.artifactType !== "setting_delta_lifecycle" ||
      existing.lifecycle.targetDeltaId !== target.id ||
      existing.lifecycle.status !== status
    ) {
      throw new Error("设定增量生命周期幂等键已被其他内容占用");
    }
    return existing;
  }

  const createdAt = new Date().toISOString();
  const lifecycle = SettingDeltaLifecycleV1Schema.parse({
    id,
    worldlineId: worldline.id,
    targetDeltaId: target.id,
    status,
    contentKind: "user",
    createdAt,
  });

  if (status === "reactivated") {
    const state = loadSettingDeltaState(worldline.id);
    const targetDelta = state.deltas.find((delta) => delta.id === target.id);
    if (!targetDelta) {
      throw new Error("设定增量不存在或不属于当前 Worldline");
    }
    const path =
      targetDelta.anchorSceneId === null
        ? []
        : getScenePath(state.tree, targetDelta.anchorSceneId);
    const active = derivePathSettingDeltas({
      tree: state.tree,
      deltas: state.deltas,
      lifecycles: [...state.lifecycles, lifecycle],
      path,
    }).filter((entry) => entry.status === "active");
    if (active.length > SETTING_DELTA_MAX_ACTIVE) {
      throw new Error(
        `当前路径最多保留 ${SETTING_DELTA_MAX_ACTIVE} 条生效设定增量：请先停用或删除本路径上的其他规则后重试`,
      );
    }
    assertSettingDeltaContextFits({
      active,
      characters: storyMapArtifact.storyMap.characters,
    });
  }

  const artifact = SettingDeltaLifecycleArtifactSchema.parse({
    id,
    projectId: input.projectId,
    sourceId: target.sourceId,
    worldlineId: worldline.id,
    kind: "continuation",
    artifactType: "setting_delta_lifecycle",
    schemaVersion: 1,
    lifecycle,
    basedOnArtifactId: null,
    generationRunId: null,
    createdAt,
  });

  insertContinuationArtifact(artifact);
  const stored = getContinuationArtifact(artifact.id);
  if (
    !stored ||
    stored.artifactType !== "setting_delta_lifecycle" ||
    stored.lifecycle.targetDeltaId !== target.id ||
    stored.lifecycle.status !== status
  ) {
    throw new Error("设定增量生命周期 Artifact 写入失败");
  }
  return stored;
}

type SettingDeltaState = {
  tree: SceneTree;
  deltas: SettingDeltaV1[];
  lifecycles: SettingDeltaLifecycleV1[];
};

function loadSettingDeltaState(worldlineId: string): SettingDeltaState {
  const { scenes, settingDeltas, settingDeltaLifecycles } =
    listContinuationArtifactsForWorldline(worldlineId);
  return {
    tree: buildSceneTree(scenes.map((scene) => scene.continuation)),
    deltas: settingDeltas.map((artifact) => artifact.settingDelta),
    lifecycles: settingDeltaLifecycles.map(
      (artifact) => artifact.lifecycle,
    ),
  };
}

function assertSettingDeltaContextFits(input: {
  active: readonly ActiveSettingDelta[];
  characters: readonly { id: string; name: string }[];
}): void {
  const items = buildSettingDeltaContextItems({
    active: input.active,
    characters: input.characters,
  });
  const length = normalizedContextChars(
    serializeSettingDeltasForContext(items),
  );
  if (length > SETTING_DELTA_CONTEXT_MAX_CHARS) {
    throw new Error(
      `设定增量上下文最多 ${SETTING_DELTA_CONTEXT_MAX_CHARS} 字（当前约 ${length} 字）：请缩短规则说明，或停用/删除本路径上的其他规则`,
    );
  }
}

export function getContinuationArtifact(
  id: string,
): ContinuationArtifact | null {
  const row = getDatabase()
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, id), eq(artifacts.kind, "continuation")))
    .get();
  return row ? parseContinuationArtifact(row) : null;
}

export function listContinuationArtifactsForWorldline(
  worldlineId: string,
): ContinuationArtifactLists {
  const all = listAllContinuationArtifacts(worldlineId);
  return {
    directions: all.filter(
      (artifact): artifact is ContinuationDirectionsArtifact =>
        artifact.artifactType === "directions",
    ),
    scenes: all.filter(
      (artifact): artifact is ContinuationSceneArtifact =>
        artifact.artifactType === "scene",
    ),
    settingDeltas: all.filter(
      (artifact): artifact is SettingDeltaArtifact =>
        artifact.artifactType === "setting_delta",
    ),
    settingDeltaLifecycles: all.filter(
      (artifact): artifact is SettingDeltaLifecycleArtifact =>
        artifact.artifactType === "setting_delta_lifecycle",
    ),
  };
}

/** 当前世界线的设定增量生命周期 payload，按 createdAt、id 升序。 */
export function listSettingDeltaLifecyclesForWorldline(
  worldlineId: string,
): SettingDeltaLifecycleV1[] {
  return listContinuationArtifactsForWorldline(worldlineId)
    .settingDeltaLifecycles.map((artifact) => artifact.lifecycle);
}

/** 当前世界线的设定增量 payload，按 createdAt、id 升序。 */
export function listSettingDeltasForWorldline(
  worldlineId: string,
): SettingDeltaV1[] {
  return listSettingDeltaArtifactsForWorldline(worldlineId).map(
    (artifact) => artifact.settingDelta,
  );
}

function listSettingDeltaArtifactsForWorldline(
  worldlineId: string,
): SettingDeltaArtifact[] {
  return listContinuationArtifactsForWorldline(worldlineId).settingDeltas;
}

export function listProjectContinuationArtifacts(
  projectId: string,
): ContinuationArtifact[] {
  return getDatabase()
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.projectId, projectId),
        eq(artifacts.kind, "continuation"),
      ),
    )
    .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
    .all()
    .map(parseContinuationArtifact);
}

/**
 * 返回指定父场景下最新的方向批次。
 *
 * v1 方向没有树字段，视为根批次 0，因此仍可作为根节点的最新批次读取。
 */
export function getLatestDirectionsBatch(
  worldlineId: string,
  parentSceneId: string | null,
): ContinuationDirectionsArtifact | null {
  const { directions } = listContinuationArtifactsForWorldline(worldlineId);
  let latest: ContinuationDirectionsArtifact | null = null;
  for (const artifact of directions) {
    if (directionsParentSceneId(artifact) !== parentSceneId) continue;
    if (!latest || compareDirectionsBatches(latest, artifact) <= 0) {
      latest = artifact;
    }
  }
  return latest;
}

/** 同一方向下的全部场景（含原场景与 retry 兄弟节点），按创建顺序排序。 */
export function listScenesForDirection(
  directionsArtifactId: string,
  selectedDirectionId: string,
): ContinuationSceneArtifact[] {
  return getDatabase()
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.kind, "continuation"),
        eq(artifacts.basedOnArtifactId, directionsArtifactId),
      ),
    )
    .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
    .all()
    .map(parseContinuationArtifact)
    .filter(
      (artifact): artifact is ContinuationSceneArtifact =>
        artifact.artifactType === "scene" &&
        artifact.continuation.selectedDirectionId === selectedDirectionId,
    );
}

export function getContinuationDirectionsForWorldline(
  worldlineId: string,
): ContinuationDirectionsArtifact | null {
  const { directions } = listContinuationArtifactsForWorldline(worldlineId);
  return directions[0] ?? null;
}

export function getContinuationSceneForWorldline(
  worldlineId: string,
): ContinuationSceneArtifact | null {
  const { scenes } = listContinuationArtifactsForWorldline(worldlineId);
  return scenes[0] ?? null;
}

function listAllContinuationArtifacts(
  worldlineId: string,
): ContinuationArtifact[] {
  return getDatabase()
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.worldlineId, worldlineId),
        eq(artifacts.kind, "continuation"),
      ),
    )
    .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
    .all()
    .map(parseContinuationArtifact);
}

function directionsParentSceneId(
  artifact: ContinuationDirectionsArtifact,
): string | null {
  return artifact.continuation.schemaVersion === 1
    ? null
    : artifact.continuation.parentSceneId;
}

function directionsBatchIndex(
  artifact: ContinuationDirectionsArtifact,
): number {
  return artifact.continuation.schemaVersion === 1
    ? 0
    : artifact.continuation.batchIndex;
}

function compareDirectionsBatches(
  left: ContinuationDirectionsArtifact,
  right: ContinuationDirectionsArtifact,
): number {
  const batchDifference =
    directionsBatchIndex(left) - directionsBatchIndex(right);
  if (batchDifference !== 0) return batchDifference;
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function assertActiveBindings(input: {
  projectId: string;
  sourceId: string;
  worldline: Worldline;
  acceptedImpactPlanArtifact: ImpactPlanArtifact;
}): void {
  if (
    input.worldline.projectId !== input.projectId ||
    input.worldline.status !== "active" ||
    input.worldline.acceptedImpactPlanId !== input.acceptedImpactPlanArtifact.id ||
    input.acceptedImpactPlanArtifact.projectId !== input.projectId ||
    input.acceptedImpactPlanArtifact.sourceId !== input.sourceId ||
    input.acceptedImpactPlanArtifact.storyMapArtifactId !==
      input.worldline.baseStoryMapArtifactId ||
    input.acceptedImpactPlanArtifact.impactPlan.status !== "accepted"
  ) {
    throw new Error(
      "Continuation 必须绑定 active Worldline 与 accepted Impact Plan",
    );
  }
}

function assertDirectionsBinding(input: {
  projectId: string;
  sourceId: string;
  worldlineId: string;
  acceptedImpactPlanId: string;
  directionsArtifact: ContinuationDirectionsArtifact;
  selectedDirectionId: string;
}): void {
  if (
    input.directionsArtifact.projectId !== input.projectId ||
    input.directionsArtifact.sourceId !== input.sourceId ||
    input.directionsArtifact.worldlineId !== input.worldlineId ||
    input.directionsArtifact.continuation.acceptedImpactPlanId !==
      input.acceptedImpactPlanId ||
    !input.directionsArtifact.continuation.directions.some(
      (direction) => direction.id === input.selectedDirectionId,
    )
  ) {
    throw new Error("后续场景未绑定当前 Worldline 的有效方向");
  }
}

function assertParentScene(input: {
  parentSceneId: string;
  projectId: string;
  worldlineId: string;
}): ContinuationSceneArtifact {
  const parent = getContinuationArtifact(input.parentSceneId);
  if (
    !parent ||
    parent.artifactType !== "scene" ||
    parent.projectId !== input.projectId ||
    parent.worldlineId !== input.worldlineId
  ) {
    throw new Error("父场景不属于当前 Worldline");
  }
  return parent;
}

function assertGenerationRun(input: {
  id: string;
  projectId: string;
  worldlineId: string;
  kind: "continuation_directions" | "continuation_scene";
}): void {
  const run = getGenerationRun(input.id);
  if (
    !run ||
    run.projectId !== input.projectId ||
    run.worldlineId !== input.worldlineId ||
    run.kind !== input.kind ||
    run.status !== "succeeded"
  ) {
    throw new Error("Continuation Artifact 必须绑定成功的 Generation Run");
  }
}

function insertContinuationArtifact(artifact: ContinuationArtifact): void {
  if (
    artifact.artifactType === "setting_delta" ||
    artifact.artifactType === "setting_delta_lifecycle"
  ) {
    const packet =
      artifact.artifactType === "setting_delta"
        ? {
            artifactType: artifact.artifactType,
            settingDelta: artifact.settingDelta,
          }
        : {
            artifactType: artifact.artifactType,
            lifecycle: artifact.lifecycle,
          };
    getDatabase()
      .insert(artifacts)
      .values({
        id: artifact.id,
        projectId: artifact.projectId,
        sourceId: artifact.sourceId,
        worldlineId: artifact.worldlineId,
        kind: artifact.kind,
        schemaVersion: artifact.schemaVersion,
        version: null,
        dataJson: JSON.stringify(packet),
        basedOnArtifactId: null,
        generationRunId: null,
        createdAt: artifact.createdAt,
      })
      .onConflictDoNothing()
      .run();
    return;
  }

  getDatabase()
    .insert(artifacts)
    .values({
      id: artifact.id,
      projectId: artifact.projectId,
      sourceId: artifact.sourceId,
      worldlineId: artifact.worldlineId,
      kind: artifact.kind,
      schemaVersion: artifact.schemaVersion,
      version: null,
      dataJson: JSON.stringify({
        artifactType: artifact.artifactType,
        continuation: artifact.continuation,
      }),
      basedOnArtifactId: artifact.basedOnArtifactId,
      generationRunId: artifact.generationRunId,
      createdAt: artifact.createdAt,
    })
    .onConflictDoNothing()
    .run();
}

function parseContinuationArtifact(
  row: typeof artifacts.$inferSelect,
): ContinuationArtifact {
  if (
    row.sourceId === null ||
    row.worldlineId === null
  ) {
    throw new Error(`Continuation Artifact 缺少必要引用：${row.id}`);
  }
  const packet = JSON.parse(row.dataJson) as {
    artifactType?: unknown;
    continuation?: unknown;
    settingDelta?: unknown;
    lifecycle?: unknown;
  };
  const base = {
    id: row.id,
    projectId: row.projectId,
    sourceId: row.sourceId,
    worldlineId: row.worldlineId,
    kind: row.kind,
    artifactType: packet.artifactType,
    schemaVersion: row.schemaVersion,
    basedOnArtifactId: row.basedOnArtifactId,
    generationRunId: row.generationRunId,
    createdAt: normalizeSqliteDate(row.createdAt),
  };
  if (packet.artifactType === "setting_delta") {
    return ContinuationArtifactSchema.parse({
      ...base,
      settingDelta: packet.settingDelta,
    });
  }
  if (packet.artifactType === "setting_delta_lifecycle") {
    return ContinuationArtifactSchema.parse({
      ...base,
      lifecycle: packet.lifecycle,
    });
  }
  if (row.basedOnArtifactId === null || row.generationRunId === null) {
    throw new Error(`Continuation Artifact 缺少必要引用：${row.id}`);
  }
  return ContinuationArtifactSchema.parse({
    ...base,
    continuation: packet.continuation,
  });
}

function stableDirectionsArtifactId(worldlineId: string): string {
  const digest = createHash("sha256")
    .update(`continuation:directions:${worldlineId}`)
    .digest("hex");
  return `artifact_continuation_directions_${digest.slice(0, 24)}`;
}

export function stableDirectionsArtifactIdV2(
  worldlineId: string,
  parentSceneId: string | null,
  batchIndex: number,
): string {
  const digest = createHash("sha256")
    .update(
      `continuation:directions:v2:${worldlineId}:${
        parentSceneId ?? "root"
      }:${batchIndex}`,
    )
    .digest("hex");
  return `artifact_continuation_directions_${digest.slice(0, 24)}`;
}

function stableSceneArtifactId(worldlineId: string): string {
  const digest = createHash("sha256")
    .update(`continuation:scene:${worldlineId}`)
    .digest("hex");
  return `artifact_continuation_scene_${digest.slice(0, 24)}`;
}

export function stableSceneArtifactIdV2(
  directionsArtifactId: string,
  selectedDirectionId: string,
  attemptIndex: number,
): string {
  const digest = createHash("sha256")
    .update(
      `continuation:scene:v2:${directionsArtifactId}:${selectedDirectionId}:${attemptIndex}`,
    )
    .digest("hex");
  return `artifact_continuation_scene_${digest.slice(0, 24)}`;
}

export function stableSettingDeltaArtifactId(
  worldlineId: string,
  anchorSceneId: string | null,
  idempotencyKey: string,
): string {
  const digest = createHash("sha256")
    .update(
      `setting_delta:${worldlineId}:${anchorSceneId ?? "root"}:${idempotencyKey}`,
    )
    .digest("hex");
  return `artifact_setting_delta_${digest.slice(0, 24)}`;
}

export function stableSettingDeltaLifecycleArtifactId(
  worldlineId: string,
  targetDeltaId: string,
  idempotencyKey: string,
): string {
  const digest = createHash("sha256")
    .update(
      `setting_delta_lifecycle:${worldlineId}:${targetDeltaId}:${idempotencyKey}`,
    )
    .digest("hex");
  return `artifact_setting_delta_lifecycle_${digest.slice(0, 24)}`;
}

function stableDirectionId(artifactId: string, index: number): string {
  const digest = createHash("sha256")
    .update(`${artifactId}:direction:${index}`)
    .digest("hex");
  return `direction_${digest.slice(0, 24)}`;
}

function normalizeSqliteDate(value: string): string {
  if (value.includes("T")) return value;
  return `${value.replace(" ", "T")}Z`;
}
