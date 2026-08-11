import {
  createConfiguredAIProvider,
  readConfiguredAI,
} from "@/server/ai/configured-runtime";
import { MockAIProvider } from "@/server/ai/mock-provider";
import {
  generateContinuationDirections,
  generateContinuationScene,
} from "@/server/continuation/generate-continuation";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import { getContinuationArtifact } from "@/server/repositories/continuation-repository";
import { getProjectSource } from "@/server/repositories/project-repository";
import {
  getImpactPlanArtifact,
  getWorldline,
} from "@/server/repositories/ripple-repository";
import { getStoryMapArtifact } from "@/server/repositories/story-map-artifact-repository";

export async function generateConfiguredContinuationDirections(input: {
  projectId: string;
  worldlineId: string;
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
  return new MockAIProvider([JSON.stringify(fixture.continuation.scene)]);
}
