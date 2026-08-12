import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { validateImpactPlan } from "@/domain/invariants/validate-story-map";
import {
  DivergenceSchema,
  ImpactPlanModelOutputSchema,
  ImpactPlanSchema,
  type Anchor,
  type ImpactPlan,
  type ImpactPlanModelOutput,
} from "@/domain/schemas";
import { z } from "zod";
import { createCanonicalWorldline } from "@/domain/services/create-worldline";
import { generateStructured } from "@/server/ai/generate-structured";
import type {
  AIProvider,
  ModelConfig,
  StructuredValidationIssue,
} from "@/server/ai/types";
import {
  createImpactPlanArtifact,
  getImpactPlanArtifact,
} from "@/server/repositories/ripple-repository";
import { getStoryMapArtifact } from "@/server/repositories/story-map-artifact-repository";

const promptVersion = "impact-plan.v2";

export async function generateImpactPlan(input: {
  projectId: string;
  storyMapArtifactId: string;
  divergence: unknown;
  mode: "strict" | "open";
  endingCandidateIds: string[];
  provider: AIProvider;
  modelConfig: ModelConfig;
}) {
  const storyMapArtifact = getStoryMapArtifact(input.storyMapArtifactId);
  if (
    !storyMapArtifact ||
    storyMapArtifact.projectId !== input.projectId ||
    storyMapArtifact.storyMap.status !== "confirmed"
  ) {
    throw new Error("只有 confirmed Story Map 才能生成 Ripple Preview");
  }

  const divergence = DivergenceSchema.parse(input.divergence);
  const selectedEvent = storyMapArtifact.storyMap.events.find(
    (event) => event.id === divergence.eventId,
  );
  if (!selectedEvent) throw new Error("Divergence 引用了未知 Story Map Event");
  const anchors = buildAnchors(
    input.mode,
    input.endingCandidateIds,
    storyMapArtifact.storyMap.endingCandidates,
  );
  const currentWorldline = createCanonicalWorldline({
    projectId: input.projectId,
    baseStoryMapArtifact: storyMapArtifact,
    createdAt: storyMapArtifact.createdAt,
  });
  const template = await readFile(
    path.join(process.cwd(), "prompts", `${promptVersion}.md`),
    "utf8",
  );
  const prompt = [
    template,
    "<ripple_context>",
    JSON.stringify({
      confirmedStoryMap: storyMapArtifact.storyMap,
      selectedEvent,
      divergence,
      currentWorldline,
      anchors,
      mode: input.mode,
    }),
    "</ripple_context>",
  ].join("\n\n");

  const generation = await generateStructured(
    {
      projectId: input.projectId,
      worldlineId: null,
      kind: "impact_plan",
      promptVersion,
      prompt,
      schemaName: "impact_plan",
      schema: ImpactPlanModelOutputSchema,
      modelConfig: input.modelConfig,
      validate: (output) =>
        validateModelOutput({
          output,
          storyMapId: storyMapArtifact.storyMap.id,
          divergence,
          anchors,
          mode: input.mode,
          storyMap: storyMapArtifact.storyMap,
        }),
    },
    input.provider,
  );

  const impactPlan = ImpactPlanSchema.parse({
    id: `artifact_impact_plan_${randomUUID()}`,
    storyMapId: storyMapArtifact.storyMap.id,
    mode: input.mode,
    divergence,
    anchors,
    ...generation.value,
    status: "candidate",
  });
  const artifact = createImpactPlanArtifact({
    projectId: input.projectId,
    storyMapArtifact,
    impactPlan,
    generationRunId: generation.generation.runId,
  });

  return { artifact, generation: generation.generation };
}

export async function regenerateImpactPlanFromFeedback(input: {
  projectId: string;
  priorCandidateArtifactId: string;
  feedback: string;
  provider: AIProvider;
  modelConfig: ModelConfig;
}) {
  const feedback = z.string().trim().min(1).max(2_000).parse(input.feedback);
  const priorCandidate = getImpactPlanArtifact(input.priorCandidateArtifactId);
  if (
    !priorCandidate ||
    priorCandidate.projectId !== input.projectId ||
    priorCandidate.impactPlan.status !== "candidate"
  ) {
    throw new Error("找不到可反馈的候选 Impact Plan Artifact");
  }
  const storyMapArtifact = getStoryMapArtifact(
    priorCandidate.storyMapArtifactId,
  );
  if (
    !storyMapArtifact ||
    storyMapArtifact.projectId !== input.projectId ||
    storyMapArtifact.sourceId !== priorCandidate.sourceId ||
    storyMapArtifact.storyMap.status !== "confirmed"
  ) {
    throw new Error("反馈候选未绑定 confirmed Story Map Artifact");
  }

  const promptVersion = "impact-plan-feedback.v1";
  const template = await readFile(
    path.join(process.cwd(), "prompts", `${promptVersion}.md`),
    "utf8",
  );
  const prompt = [
    template,
    "<feedback_context>",
    JSON.stringify({
      confirmedStoryMap: storyMapArtifact.storyMap,
      priorCandidate: priorCandidate.impactPlan,
      feedback,
      frozenContract: {
        storyMapArtifactId: storyMapArtifact.id,
        divergence: priorCandidate.impactPlan.divergence,
        mode: priorCandidate.impactPlan.mode,
        anchors: priorCandidate.impactPlan.anchors,
      },
    }),
    "</feedback_context>",
  ].join("\n\n");
  const generation = await generateStructured(
    {
      projectId: input.projectId,
      worldlineId: null,
      kind: "impact_plan",
      promptVersion,
      prompt,
      schemaName: "impact_plan_feedback",
      schema: ImpactPlanModelOutputSchema,
      modelConfig: input.modelConfig,
      validate: (output) =>
        validateModelOutput({
          output,
          storyMapId: storyMapArtifact.storyMap.id,
          divergence: priorCandidate.impactPlan.divergence,
          anchors: priorCandidate.impactPlan.anchors,
          mode: priorCandidate.impactPlan.mode,
          storyMap: storyMapArtifact.storyMap,
        }),
    },
    input.provider,
  );
  const impactPlan = ImpactPlanSchema.parse({
    id: `artifact_impact_plan_${randomUUID()}`,
    storyMapId: storyMapArtifact.storyMap.id,
    mode: priorCandidate.impactPlan.mode,
    divergence: priorCandidate.impactPlan.divergence,
    anchors: priorCandidate.impactPlan.anchors,
    ...generation.value,
    status: "candidate",
  });
  const artifact = createImpactPlanArtifact({
    projectId: input.projectId,
    storyMapArtifact,
    impactPlan,
    generationRunId: generation.generation.runId,
    priorCandidate,
    feedback,
  });
  return { artifact, generation: generation.generation };
}

function buildAnchors(
  mode: "strict" | "open",
  requestedIds: string[],
  endingCandidates: Array<{
    id: string;
    targetEventId: string;
    requirement: string;
  }>,
): Anchor[] {
  const uniqueIds = new Set(requestedIds);
  if (uniqueIds.size !== requestedIds.length) {
    throw new Error("Anchor 选择包含重复 Ending Candidate");
  }
  if (mode === "open") {
    if (requestedIds.length > 0) {
      throw new Error("开放模式不能选择结局 Anchor");
    }
    return [];
  }
  if (requestedIds.length === 0) {
    throw new Error("严格模式必须至少选择一个结局 Anchor");
  }

  return requestedIds.map((id) => {
    const ending = endingCandidates.find((candidate) => candidate.id === id);
    if (!ending) throw new Error(`找不到 Ending Candidate：${id}`);
    return {
      id: ending.id.startsWith("ending_")
        ? `anchor_${ending.id.slice("ending_".length)}`
        : `anchor_${ending.id}`,
      targetEventId: ending.targetEventId,
      requirement: ending.requirement,
      strength: "hard" as const,
    };
  });
}

function validateModelOutput(input: {
  output: ImpactPlanModelOutput;
  storyMapId: string;
  divergence: ImpactPlan["divergence"];
  anchors: Anchor[];
  mode: "strict" | "open";
  storyMap: Parameters<typeof validateImpactPlan>[1];
}): StructuredValidationIssue[] {
  const parsed = ImpactPlanSchema.safeParse({
    id: "impact_plan_candidate",
    storyMapId: input.storyMapId,
    mode: input.mode,
    divergence: input.divergence,
    anchors: input.anchors,
    ...input.output,
    status: "candidate",
  });
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "$",
      message: issue.message,
    }));
  }
  return validateImpactPlan(parsed.data, input.storyMap);
}
