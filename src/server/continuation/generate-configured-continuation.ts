import {
  createConfiguredAIProvider,
  readConfiguredAI,
} from "@/server/ai/configured-runtime";
import { MockAIProvider } from "@/server/ai/mock-provider";
import {
  generateContinuationDirections,
  generateContinuationScene,
} from "@/server/continuation/generate-continuation";
import type {
  ContinuationSceneArtifact,
  ContinuationSceneModelOutputV3,
} from "@/domain/schemas";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import {
  getContinuationArtifact,
  listScenesForDirection,
} from "@/server/repositories/continuation-repository";
import { getProjectSource } from "@/server/repositories/project-repository";
import {
  getImpactPlanArtifact,
  getWorldline,
} from "@/server/repositories/ripple-repository";
import { getStoryMapArtifact } from "@/server/repositories/story-map-artifact-repository";

export async function generateConfiguredContinuationDirections(input: {
  projectId: string;
  worldlineId: string;
  parentSceneId?: string | null;
  newBatch?: boolean;
}) {
  const config = readConfiguredAI();
  const mockProvider =
    config.providerName === "mock"
      ? await createFixtureProvider(input, "directions")
      : undefined;
  return generateContinuationDirections({
    ...input,
    provider: createConfiguredAIProvider(config, mockProvider),
    modelConfig: config.modelConfig,
  });
}

export async function generateConfiguredContinuationScene(input: {
  projectId: string;
  worldlineId: string;
  directionsArtifactId: string;
  selectedDirectionId: string;
  retry?: boolean;
}) {
  const config = readConfiguredAI();
  const mockProvider =
    config.providerName === "mock"
      ? await createFixtureProvider(input, "scene")
      : undefined;
  return generateContinuationScene({
    ...input,
    provider: createConfiguredAIProvider(config, mockProvider),
    modelConfig: config.modelConfig,
  });
}

async function createFixtureProvider(
  input: {
    projectId: string;
    worldlineId: string;
    directionsArtifactId?: string;
    selectedDirectionId?: string;
    retry?: boolean;
  },
  stage: "directions" | "scene",
): Promise<MockAIProvider> {
  const worldline = getWorldline(input.worldlineId);
  if (
    !worldline ||
    worldline.projectId !== input.projectId ||
    worldline.acceptedImpactPlanId === null
  ) {
    throw new Error("Mock AI 找不到 active Worldline");
  }
  const acceptedPlan = getImpactPlanArtifact(worldline.acceptedImpactPlanId);
  const storyMapArtifact = getStoryMapArtifact(
    worldline.baseStoryMapArtifactId,
  );
  if (
    !acceptedPlan ||
    acceptedPlan.impactPlan.status !== "accepted" ||
    !storyMapArtifact ||
    storyMapArtifact.projectId !== input.projectId
  ) {
    throw new Error("Mock AI 找不到 accepted Impact Plan 或 Story Map");
  }
  const source = getProjectSource(input.projectId, storyMapArtifact.sourceId);
  const fixture = await loadRippleFixture();
  const expectedPlan = fixture.impactPlans.find(
    (plan) => plan.id === fixture.continuation.impactPlanFixtureId,
  );
  if (
    !source ||
    source.contentHash !== fixture.source.contentHash ||
    !expectedPlan ||
    acceptedPlan.impactPlan.mode !== expectedPlan.mode ||
    acceptedPlan.impactPlan.divergence.eventId !== expectedPlan.divergence.eventId ||
    acceptedPlan.impactPlan.divergence.type !== expectedPlan.divergence.type ||
    acceptedPlan.impactPlan.divergence.instruction !==
      expectedPlan.divergence.instruction
  ) {
    throw new Error("Mock AI 只支持 ripple-001 的标准 rerouted Worldline");
  }

  if (stage === "directions") {
    return new MockAIProvider([
      JSON.stringify(fixture.continuation.directions),
    ]);
  }
  const directionsArtifact = input.directionsArtifactId
    ? getContinuationArtifact(input.directionsArtifactId)
    : null;
  if (
    !directionsArtifact ||
    directionsArtifact.artifactType !== "directions" ||
    directionsArtifact.worldlineId !== worldline.id ||
    !directionsArtifact.continuation.directions.some(
      (direction) => direction.id === input.selectedDirectionId,
    )
  ) {
    throw new Error("Mock AI 找不到选中的 ripple-001 后续方向");
  }
  const parentSceneId =
    directionsArtifact.continuation.schemaVersion === 2
      ? directionsArtifact.continuation.parentSceneId
      : null;
  const selectedDirection = directionsArtifact.continuation.directions.find(
    (direction) => direction.id === input.selectedDirectionId,
  );
  if (!selectedDirection) {
    throw new Error("Mock AI 找不到选中的 ripple-001 后续方向");
  }
  const siblings = listScenesForDirection(
    directionsArtifact.id,
    selectedDirection.id,
  );
  const attemptIndex = input.retry
    ? siblings.reduce((max, scene) => {
        const attempt =
          scene.continuation.schemaVersion === 1
            ? 0
            : scene.continuation.attemptIndex;
        return Math.max(max, attempt);
      }, -1) + 1
    : 0;

  if (parentSceneId === null) {
    const canonicalFirstDirection =
      selectedDirection.id ===
      directionsArtifact.continuation.directions[0]?.id;
    const scene =
      attemptIndex === 0 && canonicalFirstDirection
        ? fixture.continuation.scene
        : buildFixtureRootScene(
            fixture.continuation.scene,
            selectedDirection.id,
            attemptIndex,
          );
    return new MockAIProvider([JSON.stringify(scene)]);
  }
  const parent = getContinuationArtifact(parentSceneId);
  if (!parent || parent.artifactType !== "scene") {
    throw new Error("Mock AI 找不到当前路径的父场景");
  }
  return new MockAIProvider([
    JSON.stringify(
      buildFixtureChildScene(
        parent,
        fixture.continuation.scene.prose,
        selectedDirection.id,
        attemptIndex,
      ),
    ),
  ]);
}

/**
 * Mock 续写只用于公开夹具 ripple-001。
 *
 * 每个生成结果都返回与当前路径不同的确定性 statePatch：新事实 key 由父节点、
 * 方向和 attempt 派生。这样同一夹具可以服务根节点、多个方向、重试兄弟节点与
 * 更深场景，而不会让折叠当前路径时出现重复 key。
 */
function buildFixtureRootScene(
  scene: ContinuationSceneModelOutputV3,
  selectedDirectionId: string,
  attemptIndex: number,
): ContinuationSceneModelOutputV3 {
  const directionSuffix = selectedDirectionId.slice(-8);
  const key =
    attemptIndex === 0
      ? `generated:fixture_root_${directionSuffix}`
      : `generated:fixture_root_${directionSuffix}_retry_${attemptIndex}`;
  return {
    ...scene,
    title:
      attemptIndex === 0 ? scene.title : `${scene.title}（重试 ${attemptIndex}）`,
    statePatch: withFirstFactKey(scene.statePatch, key),
  };
}

function buildFixtureChildScene(
  parent: ContinuationSceneArtifact,
  prose: string,
  selectedDirectionId: string,
  attemptIndex: number,
): ContinuationSceneModelOutputV3 {
  const parentDepth =
    parent.continuation.schemaVersion === 1 ? 1 : parent.continuation.depth;
  const parentSuffix = parent.id.slice(-8);
  const directionSuffix = selectedDirectionId.slice(-8);
  return {
    title:
      attemptIndex === 0
        ? "潮标站之后"
        : `潮标站之后（重试 ${attemptIndex}）`,
    prose,
    summary: `第 ${parentDepth + 1} 幕：许澄与沈砚离开潮标站，沿北侧石阶前往旧灯塔，继续核对封条与交接安排。`,
    statePatch: {
      factsAdded: [
        {
          key: `generated:fixture_child_${parentSuffix}_${directionSuffix}_${attemptIndex}`,
          statement: "许澄与沈砚离开潮标站，前往旧灯塔继续核对封条与交接安排。",
        },
      ],
      factsRemoved: [],
      characterChanges: parent.continuation.statePatch.characterChanges,
      threadsOpened: [],
      threadsClosed: [],
    },
  };
}

function withFirstFactKey(
  patch: ContinuationSceneModelOutputV3["statePatch"],
  key: string,
): ContinuationSceneModelOutputV3["statePatch"] {
  return {
    ...patch,
    factsAdded: patch.factsAdded.map((fact, index) =>
      index === 0 ? { ...fact, key } : fact,
    ),
  };
}
