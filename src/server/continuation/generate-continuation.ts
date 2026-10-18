import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  assembleContext,
  RELATED_EVIDENCE_PRIORITY,
  STYLE_EVIDENCE_PRIORITY,
  type ContextAssemblerResult,
  type ContextEvidenceItem,
  type ContextSceneItem,
} from "@/domain/continuation/context-assembler";
import {
  buildCanonEventsSection,
  buildRelatedEvidenceItems,
  divergenceDependencyEventIds,
} from "@/domain/continuation/canon-context";
import { buildPathSummary } from "@/domain/continuation/path-summary";
import {
  buildSettingDeltaContextItems,
  deriveActiveSettingDeltas,
  isDirectionBatchStale,
  SETTING_DELTA_STALE_BATCH_MESSAGE,
  settingDeltaActiveFingerprint,
  type ActiveSettingDelta,
  type SettingDeltaContextItem,
} from "@/domain/continuation/setting-deltas";
import {
  buildSceneTree,
  derivePathState,
  getScenePath,
  type SceneNode,
  type SceneTree,
} from "@/domain/continuation/scene-tree";
import { selectContinuationContext } from "@/domain/continuation/select-continuation-context";
import { isUncertainImpact } from "@/domain/ripple/derive-uncertain-impact-ids";
import {
  deriveWorldlineDelta,
  validateAgainstPreDivergenceCanon,
  validateContinuationDirections,
  validateContinuationStatePatch,
  type ContinuationCanonHardRejection,
  type ContinuationCanonWarning,
} from "@/domain/invariants/validate-continuation";
import {
  assertValidImpactPlan,
  assertValidStoryMap,
} from "@/domain/invariants/validate-story-map";
import {
  ContinuationDirectionsModelOutputSchema,
  ContinuationSceneModelOutputV3Schema,
  type ContinuationDirection,
  type ContinuationDirectionsArtifact,
  type ContinuationSceneModelOutput,
  type ImpactPlanArtifact,
  type SettingDeltaLifecycleV1,
  type SettingDeltaV1,
  type Source,
  type StoryMapArtifact,
  type Worldline,
  type WorldlineDelta,
} from "@/domain/schemas";
import { generateStructured } from "@/server/ai/generate-structured";
import { runWithInFlightLock } from "@/server/ai/in-flight-generation";
import type { AIProvider, ModelConfig } from "@/server/ai/types";
import {
  readContinuationCanonGuardPolicy,
  runWithCanonGuard,
} from "@/server/continuation/canon-guard";
import { readContinuationContextMaxChars } from "@/server/continuation/continuation-limits";
import {
  createContinuationDirectionsArtifactV2,
  createContinuationSceneArtifactV2,
  getContinuationArtifact,
  getLatestDirectionsBatch,
  listContinuationArtifactsForWorldline,
  listScenesForDirection,
  stableDirectionsArtifactIdV2,
  stableSceneArtifactIdV2,
} from "@/server/repositories/continuation-repository";
import { getProjectSource } from "@/server/repositories/project-repository";
import {
  getImpactPlanArtifact,
  getWorldline,
} from "@/server/repositories/ripple-repository";
import { getStoryMapArtifact } from "@/server/repositories/story-map-artifact-repository";

const directionsPromptVersion = "continuation-directions.v4";
const scenePromptVersion = "continuation-scene.v5";

export {
  CONTINUATION_CONTEXT_MAX_CHARS_ENV,
  DEFAULT_CONTINUATION_CONTEXT_MAX_CHARS,
  readContinuationContextMaxChars,
} from "@/server/continuation/continuation-limits";

export async function generateContinuationDirections(input: {
  projectId: string;
  worldlineId: string;
  parentSceneId?: string | null;
  newBatch?: boolean;
  provider: AIProvider;
  modelConfig: ModelConfig;
}) {
  const parentSceneId = input.parentSceneId ?? null;
  const newBatch = input.newBatch ?? false;
  const context = loadContinuationContext(input);
  const canonGuardPolicy = readContinuationCanonGuardPolicy();
  const divergenceEventId = context.worldline.divergence?.eventId;
  if (!divergenceEventId) {
    throw new Error("Continuation Worldline 缺少 Divergence Event");
  }
  const resolvedPath = resolveScenePath({
    worldlineId: context.worldline.id,
    parentSceneId,
  });
  const { path, activeSettingDeltas } = resolvedPath;
  // 这里就是组装上下文时真正使用的 active 集合；把它冻结成指纹写进新批次，
  // 生成期间新增/改写/停用规则都能在落库后被识别为 stale。
  const settingDeltaFingerprint =
    settingDeltaActiveFingerprint(activeSettingDeltas);
  const settingDeltas = buildSettingDeltaContextItems({
    active: activeSettingDeltas,
    characters: context.storyMapArtifact.storyMap.characters,
  });

  const latestBatch = getLatestDirectionsBatch(
    context.worldline.id,
    parentSceneId,
  );
  if (!newBatch && latestBatch) {
    // 只复用“仍然最新”的批次；stale 批次绝不在用户未点「换一批」时自动重建。
    if (
      isDirectionBatchStale({
        batch: directionBatchDescriptor(latestBatch),
        tree: resolvedPath.tree,
        pathToParent: path,
        deltas: resolvedPath.deltas,
        lifecycles: resolvedPath.lifecycles,
      })
    ) {
      throw new Error(SETTING_DELTA_STALE_BATCH_MESSAGE);
    }
    return { artifact: latestBatch, generation: null };
  }
  const batchIndex =
    latestBatch === null ? 0 : directionsBatchIndex(latestBatch) + 1;
  const targetArtifactId = stableDirectionsArtifactIdV2(
    context.worldline.id,
    parentSceneId,
    batchIndex,
  );

  return runWithInFlightLock(targetArtifactId, async () => {
    const existing = getContinuationArtifact(targetArtifactId);
    if (existing && existing.artifactType === "directions") {
      return { artifact: existing, generation: null };
    }

    const pathState = derivePathState(context.baseState, path);
    const material = buildContextMaterial({
      context,
      path,
      pathState,
      settingDeltas,
      selectedDirection: null,
    });
    const prompt = await buildPrompt(directionsPromptVersion, material.prompt);
    let canonWarnings: ContinuationCanonWarning[] = [];
    let hardRejections: ContinuationCanonHardRejection[] = [];

    const generation = await runWithCanonGuard(
      () => generateStructured(
        {
          projectId: input.projectId,
          worldlineId: context.worldline.id,
          kind: "continuation_directions",
          promptVersion: directionsPromptVersion,
          prompt,
          schemaName: "continuation_directions",
          schema: ContinuationDirectionsModelOutputSchema,
          modelConfig: input.modelConfig,
          validate: (output) => {
            const canon = validateAgainstPreDivergenceCanon({
              textFields: output.directions.flatMap((direction, index) => [
                { field: `directions.${index}.title`, text: direction.title },
                { field: `directions.${index}.premise`, text: direction.premise },
                {
                  field: `directions.${index}.expectedConsequence`,
                  text: direction.expectedConsequence,
                },
              ]),
              storyMap: context.storyMapArtifact.storyMap,
              divergenceEventId,
              pathState,
              policy: canonGuardPolicy,
            });
            hardRejections = canon.hardRejections;
            if (canon.issues.length === 0) {
              canonWarnings = canon.warnings;
            }
            return [
              ...validateContinuationDirections(
                output,
                context.storyMapArtifact.storyMap,
              ),
              ...canon.issues,
            ];
          },
        },
        input.provider,
      ),
      () => hardRejections.map((rejection) => rejection.title),
    );
    const artifact = createContinuationDirectionsArtifactV2({
      projectId: input.projectId,
      sourceId: context.source.id,
      worldline: context.worldline,
      acceptedImpactPlanArtifact: context.acceptedImpactPlanArtifact,
      parentSceneId,
      batchIndex,
      output: generation.value,
      generationRunId: generation.generation.runId,
      settingDeltaFingerprint,
      ...(canonWarnings.length > 0 ? { canonWarnings } : {}),
    });

    return { artifact, generation: generation.generation };
  });
}

export async function generateContinuationScene(input: {
  projectId: string;
  worldlineId: string;
  directionsArtifactId: string;
  selectedDirectionId: string;
  retry?: boolean;
  provider: AIProvider;
  modelConfig: ModelConfig;
}) {
  const context = loadContinuationContext(input);
  const canonGuardPolicy = readContinuationCanonGuardPolicy();
  const retry = input.retry ?? false;
  const directionsArtifact = getContinuationArtifact(
    input.directionsArtifactId,
  );
  if (
    !directionsArtifact ||
    directionsArtifact.artifactType !== "directions" ||
    directionsArtifact.projectId !== input.projectId ||
    directionsArtifact.worldlineId !== input.worldlineId ||
    directionsArtifact.continuation.acceptedImpactPlanId !==
      context.acceptedImpactPlanArtifact.id
  ) {
    throw new Error("找不到当前 Worldline 的后续方向 Artifact");
  }
  const selectedDirection = directionsArtifact.continuation.directions.find(
    (direction) => direction.id === input.selectedDirectionId,
  );
  if (!selectedDirection) throw new Error("找不到选中的后续方向");

  const parentSceneId =
    directionsArtifact.continuation.schemaVersion === 2
      ? directionsArtifact.continuation.parentSceneId
      : null;
  // 设定增量在该批次之后变化时，批次已不代表当前路径规则；fail closed，
  // 让用户显式「换一批」。已生成的场景是 confirmed 内容，不受影响。
  assertDirectionsBatchIsCurrent({
    worldlineId: context.worldline.id,
    directionsArtifact,
  });
  const siblings = listScenesForDirection(
    directionsArtifact.id,
    selectedDirection.id,
  );
  if (!retry) {
    const first = siblings.find(
      (scene) =>
        scene.continuation.schemaVersion === 1 ||
        scene.continuation.attemptIndex === 0,
    );
    if (first) {
      return { artifact: first, generation: null };
    }
  }
  const attemptIndex = retry
    ? siblings.reduce((max, scene) => {
        const attempt =
          scene.continuation.schemaVersion === 1
            ? 0
            : scene.continuation.attemptIndex;
        return Math.max(max, attempt);
      }, -1) + 1
    : 0;

  const targetArtifactId = stableSceneArtifactIdV2(
    directionsArtifact.id,
    selectedDirection.id,
    attemptIndex,
  );

  return runWithInFlightLock(targetArtifactId, async () => {
    const existing = getContinuationArtifact(targetArtifactId);
    if (existing && existing.artifactType === "scene") {
      return { artifact: existing, generation: null };
    }

    const { path, parent, activeSettingDeltas } = resolveScenePath({
      worldlineId: context.worldline.id,
      parentSceneId,
    });
    const depth = parent === null ? 1 : parent.depth + 1;
    const pathState = derivePathState(context.baseState, path);
    const settingDeltas = buildSettingDeltaContextItems({
      active: activeSettingDeltas,
      characters: context.storyMapArtifact.storyMap.characters,
    });
    const material = buildContextMaterial({
      context,
      path,
      pathState,
      settingDeltas,
      selectedDirection,
    });
    const prompt = await buildPrompt(scenePromptVersion, material.prompt);
    const divergenceEventId = context.worldline.divergence?.eventId;
    if (!divergenceEventId) {
      throw new Error("Continuation Worldline 缺少 Divergence Event");
    }

    let canonWarnings: ContinuationCanonWarning[] = [];
    let hardRejections: ContinuationCanonHardRejection[] = [];

    const generation = await runWithCanonGuard(
      () => generateStructured(
        {
          projectId: input.projectId,
          worldlineId: context.worldline.id,
          kind: "continuation_scene",
          promptVersion: scenePromptVersion,
          prompt,
          schemaName: "continuation_scene",
          schema: ContinuationSceneModelOutputV3Schema,
          modelConfig: input.modelConfig,
          validate: (output) => {
            const canon = validateAgainstPreDivergenceCanon({
              textFields: [
                { field: "title", text: output.title },
                { field: "prose", text: output.prose },
                { field: "summary", text: output.summary },
              ],
              storyMap: context.storyMapArtifact.storyMap,
              divergenceEventId,
              pathState,
              policy: canonGuardPolicy,
            });
            hardRejections = canon.hardRejections;
            if (canon.issues.length === 0) {
              canonWarnings = canon.warnings;
            }
            return [
              ...validateContinuationStatePatch(
                output.statePatch,
                pathState,
                context.storyMapArtifact.storyMap,
                divergenceEventId,
                context.worldline.anchors.map((anchor) => anchor.targetEventId),
              ),
              ...canon.issues,
            ];
          },
        },
        input.provider,
      ),
      () => hardRejections.map((rejection) => rejection.title),
    );
    const artifact = createContinuationSceneArtifactV2({
      projectId: input.projectId,
      sourceId: context.source.id,
      worldline: context.worldline,
      acceptedImpactPlanArtifact: context.acceptedImpactPlanArtifact,
      directionsArtifact,
      selectedDirectionId: selectedDirection.id,
      parentSceneId,
      depth,
      origin: retry ? "retry" : "generated",
      attemptIndex,
      summary: generation.value.summary,
      contextManifest: material.manifest,
      output: sceneOutputWithoutSummary(generation.value),
      generationRunId: generation.generation.runId,
      ...(canonWarnings.length > 0 ? { canonWarnings } : {}),
    });

    return { artifact, generation: generation.generation };
  });
}

type ContinuationContext = {
  worldline: Worldline;
  acceptedImpactPlanArtifact: ImpactPlanArtifact;
  storyMapArtifact: StoryMapArtifact;
  source: Source;
  /** accepted Impact Plan 派生的基础 Delta，不包含任何场景。 */
  baseState: WorldlineDelta;
};

function loadContinuationContext(input: {
  projectId: string;
  worldlineId: string;
}): ContinuationContext {
  const worldline = getWorldline(input.worldlineId);
  if (
    !worldline ||
    worldline.projectId !== input.projectId ||
    worldline.status !== "active" ||
    worldline.acceptedImpactPlanId === null
  ) {
    throw new Error("Continuation 只能从 active Worldline 生成");
  }
  const acceptedImpactPlanArtifact = getImpactPlanArtifact(
    worldline.acceptedImpactPlanId,
  );
  if (
    !acceptedImpactPlanArtifact ||
    acceptedImpactPlanArtifact.projectId !== input.projectId ||
    acceptedImpactPlanArtifact.impactPlan.status !== "accepted"
  ) {
    throw new Error("Worldline 未绑定 accepted Impact Plan");
  }
  const storyMapArtifact = getStoryMapArtifact(
    worldline.baseStoryMapArtifactId,
  );
  if (
    !storyMapArtifact ||
    storyMapArtifact.projectId !== input.projectId ||
    storyMapArtifact.storyMap.status !== "confirmed" ||
    storyMapArtifact.id !== acceptedImpactPlanArtifact.storyMapArtifactId
  ) {
    throw new Error("Worldline 未绑定 confirmed Story Map 基线");
  }
  const source = getProjectSource(input.projectId, storyMapArtifact.sourceId);
  if (!source) throw new Error("找不到 Worldline 对应的不可变 Source");
  assertValidStoryMap(storyMapArtifact.storyMap, source);
  // 读取续写上下文时重新执行 Impact Plan 领域校验，防止历史或损坏的
  // 不确定 Edge 索引绕过接受时的检查。
  assertValidImpactPlan(
    acceptedImpactPlanArtifact.impactPlan,
    storyMapArtifact.storyMap,
  );
  const baseState = deriveWorldlineDelta({
    worldline,
    impactPlan: acceptedImpactPlanArtifact.impactPlan,
    storyMap: storyMapArtifact.storyMap,
  });

  return {
    worldline,
    acceptedImpactPlanArtifact,
    storyMapArtifact,
    source,
    baseState,
  };
}

/**
 * 解析父场景并返回 root→父节点路径与路径上生效的设定增量。
 *
 * 父节点必须属于当前 Worldline；树断裂、跨世界线或深度不连续时
 * `buildSceneTree` / `getScenePath` 会 fail closed。根批次路径为空，
 * 因此只读取 anchorSceneId = null（从分歧点生效）的设定增量。
 */
function resolveScenePath(input: {
  worldlineId: string;
  parentSceneId: string | null;
}): {
  tree: SceneTree;
  path: SceneNode[];
  parent: SceneNode | null;
  activeSettingDeltas: ActiveSettingDelta[];
  deltas: SettingDeltaV1[];
  lifecycles: SettingDeltaLifecycleV1[];
} {
  const { scenes, settingDeltas, settingDeltaLifecycles } =
    listContinuationArtifactsForWorldline(input.worldlineId);
  const tree = buildSceneTree(scenes.map((scene) => scene.continuation));
  const deltas = settingDeltas.map((artifact) => artifact.settingDelta);
  const lifecycles = settingDeltaLifecycles.map(
    (artifact) => artifact.lifecycle,
  );
  let parent: SceneNode | null = null;
  let path: SceneNode[] = [];
  if (input.parentSceneId !== null) {
    parent = tree.nodes.get(input.parentSceneId) ?? null;
    if (!parent) {
      throw new Error("父场景不属于当前 Worldline");
    }
    path = getScenePath(tree, input.parentSceneId);
  }
  const activeSettingDeltas = deriveActiveSettingDeltas({
    tree,
    deltas,
    lifecycles,
    path,
  });
  return { tree, path, parent, activeSettingDeltas, deltas, lifecycles };
}

/** 方向批次的稳定元组；v1 批次视为根批次。 */
function directionBatchDescriptor(
  artifact: ContinuationDirectionsArtifact,
): {
  id: string;
  parentSceneId: string | null;
  createdAt: string;
  settingDeltaFingerprint?: string;
} {
  const continuation = artifact.continuation;
  return {
    id: artifact.id,
    parentSceneId:
      continuation.schemaVersion === 2 ? continuation.parentSceneId : null,
    createdAt: continuation.createdAt,
    ...(continuation.schemaVersion === 2 &&
    continuation.settingDeltaFingerprint !== undefined
      ? { settingDeltaFingerprint: continuation.settingDeltaFingerprint }
      : {}),
  };
}

/**
 * 重新读取该 Worldline 的场景树与设定增量，检查方向批次是否 stale。
 *
 * 与界面使用同一纯函数；服务端不信任客户端，stale 时拒绝继续生成场景。
 */
function assertDirectionsBatchIsCurrent(input: {
  worldlineId: string;
  directionsArtifact: ContinuationDirectionsArtifact;
}): void {
  const { scenes, settingDeltas, settingDeltaLifecycles } =
    listContinuationArtifactsForWorldline(input.worldlineId);
  const tree = buildSceneTree(scenes.map((scene) => scene.continuation));
  const batch = directionBatchDescriptor(input.directionsArtifact);
  const path =
    batch.parentSceneId === null
      ? []
      : getScenePath(tree, batch.parentSceneId);
  const stale = isDirectionBatchStale({
    batch,
    tree,
    pathToParent: path,
    deltas: settingDeltas.map((artifact) => artifact.settingDelta),
    lifecycles: settingDeltaLifecycles.map((artifact) => artifact.lifecycle),
  });
  if (stale) throw new Error(SETTING_DELTA_STALE_BATCH_MESSAGE);
}

function buildContextMaterial(input: {
  context: ContinuationContext;
  path: readonly SceneNode[];
  pathState: WorldlineDelta;
  settingDeltas: readonly SettingDeltaContextItem[];
  selectedDirection: ContinuationDirection | null;
}): ContextAssemblerResult {
  const storyMap = input.context.storyMapArtifact.storyMap;
  const plan = input.context.acceptedImpactPlanArtifact.impactPlan;
  const selectorDirection =
    input.selectedDirection ?? {
      id: "directions",
      title: "为当前路径生成后续方向",
      premise: "根据当前世界线状态提出三个彼此不同的后续方向。",
      affectedCharacterIds: storyMap.characters.map(
        (character) => character.id,
      ),
      expectedConsequence: "三个方向产生不同的分支路径。",
    };
  const selection = selectContinuationContext({
    storyMap,
    source: input.context.source,
    worldline: input.context.worldline,
    acceptedImpactPlan: input.context.acceptedImpactPlanArtifact,
    selectedDirection: selectorDirection,
  });
  // 分歧事件自身及其直接依赖的分歧前 Canon 证据永不裁剪：它们在
  // canon_evidence 中的位置不变，但 pinned 条目会进入必需下限。
  const pinnedEventIds = divergenceDependencyEventIds(
    storyMap,
    plan.divergence.eventId,
  );
  const relatedEvidence: ContextEvidenceItem[] =
    buildRelatedEvidenceItems({
      storyMap,
      source: input.context.source,
      impactPlan: plan,
    }).map((item) => ({
      ...item,
      priority: RELATED_EVIDENCE_PRIORITY,
      ...(pinnedEventIds.has(eventIdOfRelatedEvidenceId(item.id))
        ? { pinned: true }
        : {}),
    }));
  const canonEvidence: ContextEvidenceItem[] = [
    ...relatedEvidence,
    ...selection.representativeExcerpts.map((excerpt) => ({
      id: `excerpt:${excerpt.kind}:${excerpt.start}:${excerpt.end}`,
      text: `[${excerpt.kind} ${excerpt.sectionId} ${excerpt.start}-${excerpt.end}]\n${excerpt.excerpt}`,
      priority: STYLE_EVIDENCE_PRIORITY,
    })),
    ...selection.characterEvidence.map((evidence) => ({
      id: `character:${evidence.characterId}:${evidence.eventId}:${evidence.excerptHash.slice(0, 16)}`,
      text: `[人物 ${evidence.characterId} / 事件 ${evidence.eventId} / ${evidence.sectionId} ${evidence.start}-${evidence.end}]\n${evidence.excerpt}`,
      priority: STYLE_EVIDENCE_PRIORITY,
    })),
  ];
  const canonEvents = buildCanonEventsSection({
    storyMap,
    storyMapArtifactId: input.context.storyMapArtifact.id,
    source: input.context.source,
    impactPlan: plan,
    anchors: input.context.worldline.anchors,
  });
  const pathSummary = buildPathSummary({ pathNodes: input.path });
  const recentScenes: ContextSceneItem[] = input.path.slice(-2).map((node) => ({
    id: node.id,
    text: node.prose,
    ...(node.summary === null ? {} : { summary: node.summary }),
  }));
  const worldlineSetup = buildWorldlineSetup(input.context, input.pathState);
  const worldlineSetupCompact = buildWorldlineSetup(
    input.context,
    compactCurrentState(input.pathState),
  );
  const anchorReminder = buildAnchorReminder(input.context);
  const selectedDirection =
    input.selectedDirection === null
      ? ""
      : JSON.stringify(input.selectedDirection);

  return assembleContext({
    maxChars: readContinuationContextMaxChars(),
    sections: {
      worldlineSetup,
      worldlineSetupCompact,
      worldlineSetupCompactRemoved: [...WORLDLINE_SETUP_COMPACT_REMOVED],
      canonEvents,
      settingDeltas: input.settingDeltas,
      pathSummary: pathSummary.text,
      pathSummaryCoveredSceneIds: pathSummary.coveredSceneIds,
      pathSummaryWatermarkSceneId: pathSummary.watermarkSceneId,
      canonEvidence,
      recentScenes,
      selectedDirection,
      anchorReminder,
    },
  });
}

/** 从 `related:<eventId>:<n>` 提取事件 id；格式由 canon-context 固定。 */
function eventIdOfRelatedEvidenceId(id: string): string {
  const prefix = "related:";
  if (!id.startsWith(prefix)) return "";
  const separator = id.lastIndexOf(":");
  return separator > prefix.length ? id.slice(prefix.length, separator) : "";
}

/**
 * 紧凑 currentState 实际移除的字段：只保留 key/计数，不保留正文。
 * 线索文本仍以 key 形式保留，因此不在移除列表中。
 */
const WORLDLINE_SETUP_COMPACT_REMOVED = [
  "currentState.factsAdded[].statement",
  "currentState.characterChanges[].summary",
] as const;

function buildWorldlineSetup(
  context: ContinuationContext,
  currentState: unknown,
): string {
  const storyMap = context.storyMapArtifact.storyMap;
  const plan = context.acceptedImpactPlanArtifact.impactPlan;
  return JSON.stringify({
    worldlineId: context.worldline.id,
    mode: context.worldline.mode,
    divergence: context.worldline.divergence,
    anchors: context.worldline.anchors,
    storyMap: {
      id: storyMap.id,
      title: storyMap.title,
      logline: storyMap.logline,
    },
    characters: storyMap.characters.map((character) => ({
      id: character.id,
      name: character.name,
      aliases: character.aliases,
      role: character.role,
    })),
    acceptedImpactPlan: {
      id: plan.id,
      mode: plan.mode,
      divergence: plan.divergence,
      impacts: plan.impacts.map((impact) => ({
        id: impact.id,
        scope: impact.scope,
        changeType: impact.changeType,
        fromEventId: impact.fromEventId,
        affectedEventId: impact.affectedEventId,
        summary: impact.summary,
        ...(isUncertainImpact(plan, impact.id) ? { uncertain: true } : {}),
      })),
      characterChanges: plan.characterChanges,
      threadChanges: plan.threadChanges,
      anchorEvaluations: plan.anchorEvaluations,
      uncertainties: plan.uncertainties,
    },
    currentState,
  });
}

/**
 * 深层路径的紧凑 currentState：只有计数与 key，不包含任何 fact/人物正文。
 * 仅在必需段超预算时整体替换完整状态，不改变状态语义。
 */
function compactCurrentState(state: WorldlineDelta) {
  return {
    factsAddedCount: state.factsAdded.length,
    factsRemovedCount: state.factsRemoved.length,
    characterChangesCount: state.characterChanges.length,
    threadsOpenedCount: state.threadsOpened.length,
    threadsClosedCount: state.threadsClosed.length,
    factsAddedKeys: state.factsAdded.map((fact) => fact.key),
    factsRemovedKeys: state.factsRemoved,
    characterChangeKeys: state.characterChanges.map(
      (change) => change.characterId,
    ),
    threadsOpenedKeys: state.threadsOpened,
    threadsClosedKeys: state.threadsClosed,
  };
}

function buildAnchorReminder(context: ContinuationContext): string {
  const anchors = context.worldline.anchors;
  const lines =
    anchors.length === 0
      ? [
          "开放模式：没有结局 Anchor；分歧前历史、角色认知与未被修改的世界规则仍然有效。",
        ]
      : [
          "严格模式锁定以下 Anchor；不得删除或改写对应目标事件：",
          ...anchors.map(
            (anchor) =>
              `- ${anchor.requirement}（目标事件 ${anchor.targetEventId}）`,
          ),
        ];
  lines.push(
    "不得删除或改写分歧点之前的 Canon Event；不得占用 event: / impact: / divergence: 命名空间。",
    "statePatch.factsAdded 的 key 必须以 generated: 开头；不得恢复已删除事实，不得删除 accepted ImpactPlan 拥有的 Delta。",
  );
  return lines.join("\n");
}

async function buildPrompt(
  promptVersion: string,
  assembledContext: string,
): Promise<string> {
  const template = await readFile(
    path.join(process.cwd(), "prompts", `${promptVersion}.md`),
    "utf8",
  );
  return [
    template,
    "<continuation_context>",
    assembledContext,
    "</continuation_context>",
  ].join("\n\n");
}

function directionsBatchIndex(
  artifact: ContinuationDirectionsArtifact,
): number {
  return artifact.continuation.schemaVersion === 1
    ? 0
    : artifact.continuation.batchIndex;
}

function sceneOutputWithoutSummary(
  output: {
    title: string;
    prose: string;
    statePatch: ContinuationSceneModelOutput["statePatch"];
  },
): ContinuationSceneModelOutput {
  return {
    title: output.title,
    prose: output.prose,
    statePatch: output.statePatch,
  };
}
