import type { ImpactPlan } from "@/domain/schemas";
import {
  createConfiguredAIProvider,
  readConfiguredAI,
} from "@/server/ai/configured-runtime";
import { MockAIProvider } from "@/server/ai/mock-provider";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import { getProjectSource } from "@/server/repositories/project-repository";
import { getStoryMapArtifact } from "@/server/repositories/story-map-artifact-repository";
import { getImpactPlanArtifact } from "@/server/repositories/ripple-repository";
import {
  generateImpactPlan,
  regenerateImpactPlanFromFeedback,
} from "@/server/ripple/generate-impact-plan";

export async function generateConfiguredImpactPlan(input: {
  projectId: string;
  storyMapArtifactId: string;
  divergence: ImpactPlan["divergence"];
  mode: "strict" | "open";
  endingCandidateIds: string[];
}) {
  const storyMapArtifact = getStoryMapArtifact(input.storyMapArtifactId);
  if (!storyMapArtifact || storyMapArtifact.projectId !== input.projectId) {
    throw new Error("找不到指定的 Story Map Artifact");
  }
  const source = getProjectSource(input.projectId, storyMapArtifact.sourceId);
  if (!source) throw new Error("找不到 Story Map 对应的 Source");

  const config = readConfiguredAI();
  const mockProvider =
    config.providerName === "mock"
      ? await createFixtureImpactPlanProvider({
          sourceHash: source.contentHash,
          divergence: input.divergence,
          mode: input.mode,
          endingCandidateIds: input.endingCandidateIds,
          endingCandidates: storyMapArtifact.storyMap.endingCandidates,
        })
      : undefined;

  return generateImpactPlan({
    ...input,
    provider: createConfiguredAIProvider(config, mockProvider),
    modelConfig: config.modelConfig,
  });
}

export async function regenerateConfiguredImpactPlanFromFeedback(input: {
  projectId: string;
  priorCandidateArtifactId: string;
  feedback: string;
}) {
  const priorCandidate = getImpactPlanArtifact(input.priorCandidateArtifactId);
  if (!priorCandidate || priorCandidate.projectId !== input.projectId) {
    throw new Error("找不到可反馈的候选 Impact Plan Artifact");
  }
  const storyMapArtifact = getStoryMapArtifact(
    priorCandidate.storyMapArtifactId,
  );
  if (!storyMapArtifact || storyMapArtifact.projectId !== input.projectId) {
    throw new Error("反馈候选未绑定 confirmed Story Map Artifact");
  }
  const source = getProjectSource(input.projectId, storyMapArtifact.sourceId);
  if (!source) throw new Error("找不到 Story Map 对应的 Source");

  const config = readConfiguredAI();
  const mockProvider =
    config.providerName === "mock"
      ? await createFixtureFeedbackProvider({
          sourceHash: source.contentHash,
          priorCandidate: priorCandidate.impactPlan,
        })
      : undefined;

  return regenerateImpactPlanFromFeedback({
    ...input,
    provider: createConfiguredAIProvider(config, mockProvider),
    modelConfig: config.modelConfig,
  });
}

async function createFixtureImpactPlanProvider(input: {
  sourceHash: string;
  divergence: ImpactPlan["divergence"];
  mode: "strict" | "open";
  endingCandidateIds: string[];
  endingCandidates: Array<{
    id: string;
    targetEventId: string;
    requirement: string;
  }>;
}): Promise<MockAIProvider> {
  const fixture = await loadRippleFixture();
  if (input.sourceHash !== fixture.source.contentHash) {
    throw new Error("Mock AI 只接受公开基准故事 ripple-001");
  }
  const plan = fixture.impactPlans.find(
    (candidate) =>
      candidate.mode === input.mode &&
      candidate.divergence.eventId === input.divergence.eventId &&
      candidate.divergence.type === input.divergence.type &&
      candidate.divergence.instruction === input.divergence.instruction,
  );
  if (!plan) throw new Error("Mock AI 找不到匹配的 ripple-001 标准分叉");

  const selectedEndings = input.endingCandidateIds.map((id) => {
    const ending = input.endingCandidates.find((item) => item.id === id);
    if (!ending) throw new Error(`找不到 Ending Candidate：${id}`);
    return ending;
  });
  const selectedRequirements = selectedEndings
    .map((ending) => ending.requirement)
    .toSorted();
  const expectedRequirements = plan.anchors
    .map((anchor) => anchor.requirement)
    .toSorted();
  if (JSON.stringify(selectedRequirements) !== JSON.stringify(expectedRequirements)) {
    throw new Error("Mock AI 的 Anchor 选择不匹配标准分叉");
  }

  const output = {
    impacts: plan.impacts,
    characterChanges: plan.characterChanges,
    threadChanges: plan.threadChanges,
    anchorEvaluations: plan.anchorEvaluations,
    uncertainties: plan.uncertainties,
  };
  return new MockAIProvider([JSON.stringify(output)]);
}

async function createFixtureFeedbackProvider(input: {
  sourceHash: string;
  priorCandidate: ImpactPlan;
}): Promise<MockAIProvider> {
  const fixture = await loadRippleFixture();
  if (input.sourceHash !== fixture.source.contentHash) {
    throw new Error("Mock AI 只接受公开基准故事 ripple-001");
  }
  const plan = fixture.impactPlans.find(
    (candidate) =>
      candidate.mode === input.priorCandidate.mode &&
      candidate.divergence.eventId === input.priorCandidate.divergence.eventId &&
      candidate.divergence.type === input.priorCandidate.divergence.type &&
      candidate.divergence.instruction ===
        input.priorCandidate.divergence.instruction,
  );
  if (!plan) throw new Error("Mock AI 找不到匹配的 ripple-001 标准分叉");
  const output = {
    ...toModelOutput(plan),
    impacts: plan.impacts.map((impact, index) =>
      index === 0
        ? {
            ...impact,
            explanation: `${impact.explanation} 已根据明确反馈重新判断人物仍掌握的信息。`,
          }
        : impact,
    ),
  };
  return new MockAIProvider([JSON.stringify(output)]);
}

function toModelOutput(plan: ImpactPlan) {
  return {
    impacts: plan.impacts,
    characterChanges: plan.characterChanges,
    threadChanges: plan.threadChanges,
    anchorEvaluations: plan.anchorEvaluations,
    uncertainties: plan.uncertainties,
  };
}
