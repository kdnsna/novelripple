import {
  buildSceneTree,
  type ScenePayload,
} from "@/domain/continuation/scene-tree";
import type { ContinuationDirectionBatchView } from "@/domain/continuation/worldline-tree";
import type {
  ContinuationArtifact,
  SettingDeltaV1,
} from "@/domain/schemas";

/**
 * 续写面板的序列化视图模型。
 *
 * 只保存面板真正需要展示的不可变内容：场景正文各保存一次，方向批次只保存
 * 三个方向，设定增量保存读者输入的短规则。世界线、ImpactPlan 等绑定信息
 * 已经由外层面板持有，不在这里重复。
 */
export type { ContinuationDirectionBatchView };

export type ContinuationTreeView = {
  worldlineId: string;
  scenes: ScenePayload[];
  directionBatches: ContinuationDirectionBatchView[];
  settingDeltas: SettingDeltaV1[];
};

export function emptyContinuationTreeView(
  worldlineId: string,
): ContinuationTreeView {
  return {
    worldlineId,
    scenes: [],
    directionBatches: [],
    settingDeltas: [],
  };
}

/**
 * 从同一世界线的全部 continuation Artifact 构建视图模型。
 *
 * 场景树由 `buildSceneTree` 完整校验（父节点、深度、跨世界线、循环）；
 * 任何不一致都 fail closed，不返回部分视图。
 */
export function buildContinuationTreeView(
  worldlineId: string,
  artifacts: readonly ContinuationArtifact[],
): ContinuationTreeView {
  const scenes: ScenePayload[] = [];
  const directionBatches: ContinuationDirectionBatchView[] = [];
  const settingDeltas: SettingDeltaV1[] = [];

  for (const artifact of artifacts) {
    if (artifact.worldlineId !== worldlineId) {
      throw new Error("Continuation Artifact 属于其他世界线");
    }
    if (artifact.artifactType === "scene") {
      scenes.push(artifact.continuation);
      continue;
    }
    if (artifact.artifactType === "setting_delta") {
      settingDeltas.push(artifact.settingDelta);
      continue;
    }
    directionBatches.push(directionBatchView(artifact));
  }

  buildSceneTree(scenes);
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  for (const batch of directionBatches) {
    if (batch.parentSceneId !== null && !sceneIds.has(batch.parentSceneId)) {
      throw new Error("方向批次引用了未知父场景");
    }
  }
  for (const delta of settingDeltas) {
    if (delta.anchorSceneId !== null && !sceneIds.has(delta.anchorSceneId)) {
      throw new Error("设定增量引用了未知锚点场景");
    }
  }
  directionBatches.sort(compareDirectionBatches);
  settingDeltas.sort(compareSettingDeltas);

  return { worldlineId, scenes, directionBatches, settingDeltas };
}

/** 把新生成的方向/场景 Artifact 合并进视图；同 id 幂等。 */
export function appendContinuationArtifact(
  view: ContinuationTreeView,
  artifact: ContinuationArtifact,
): ContinuationTreeView {
  if (artifact.worldlineId !== view.worldlineId) {
    throw new Error("Continuation Artifact 属于其他世界线");
  }
  if (artifact.artifactType === "scene") {
    if (view.scenes.some((scene) => scene.id === artifact.continuation.id)) {
      return view;
    }
    return { ...view, scenes: [...view.scenes, artifact.continuation] };
  }

  if (artifact.artifactType === "setting_delta") {
    if (
      view.settingDeltas.some(
        (delta) => delta.id === artifact.settingDelta.id,
      )
    ) {
      return view;
    }
    return {
      ...view,
      settingDeltas: [...view.settingDeltas, artifact.settingDelta].sort(
        compareSettingDeltas,
      ),
    };
  }

  if (
    view.directionBatches.some((batch) => batch.id === artifact.continuation.id)
  ) {
    return view;
  }
  return {
    ...view,
    directionBatches: [...view.directionBatches, directionBatchView(artifact)].sort(
      compareDirectionBatches,
    ),
  };
}

function directionBatchView(
  artifact: Extract<ContinuationArtifact, { artifactType: "directions" }>,
): ContinuationDirectionBatchView {
  const continuation = artifact.continuation;
  return {
    id: continuation.id,
    parentSceneId:
      continuation.schemaVersion === 1 ? null : continuation.parentSceneId,
    batchIndex: continuation.schemaVersion === 1 ? 0 : continuation.batchIndex,
    createdAt: continuation.createdAt,
    directions: continuation.directions,
  };
}

function compareDirectionBatches(
  left: ContinuationDirectionBatchView,
  right: ContinuationDirectionBatchView,
): number {
  const leftParent = left.parentSceneId ?? "";
  const rightParent = right.parentSceneId ?? "";
  if (leftParent !== rightParent) return leftParent < rightParent ? -1 : 1;
  if (left.batchIndex !== right.batchIndex) {
    return left.batchIndex - right.batchIndex;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function compareSettingDeltas(
  left: SettingDeltaV1,
  right: SettingDeltaV1,
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}
