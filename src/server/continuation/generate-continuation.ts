import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  deriveWorldlineDelta,
  validateContinuationDirections,
  validateContinuationStatePatch,
} from "@/domain/invariants/validate-continuation";
import { assertValidStoryMap } from "@/domain/invariants/validate-story-map";
import {
  ContinuationDirectionsModelOutputSchema,
  ContinuationSceneModelOutputSchema,
  type ContinuationDirection,
  type ImpactPlanArtifact,
  type Source,
  type StoryMapArtifact,
  type Worldline,
  type WorldlineDelta,
} from "@/domain/schemas";
import { generateStructured } from "@/server/ai/generate-structured";
import type { AIProvider, ModelConfig } from "@/server/ai/types";
import {
  createContinuationDirectionsArtifact,
  createContinuationSceneArtifact,
  getContinuationArtifact,
  getContinuationDirectionsForWorldline,
  getContinuationSceneForWorldline,
} from "@/server/repositories/continuation-repository";
import { getProjectSource } from "@/server/repositories/project-repository";
import {
  getImpactPlanArtifact,
  getWorldline,
} from "@/server/repositories/ripple-repository";
import { getStoryMapArtifact } from "@/server/repositories/story-map-artifact-repository";

const promptVersion = "continuation.v1";

export async function generateContinuationDirections(input: {
  projectId: string;
  worldlineId: string;
  provider: AIProvider;
  modelConfig: ModelConfig;
}) {
  const existing = getContinuationDirectionsForWorldline(input.worldlineId);
  if (existing) {
    if (existing.projectId !== input.projectId) {
      throw new Error("找不到当前 Project 的 Worldline");
    }
    return { artifact: existing, generation: null };
  }

  const context = loadContinuationContext(input);
  const prompt = await buildPrompt("directions", context);
  const generation = await generateStructured(
    {
      projectId: input.projectId,
      worldlineId: context.worldline.id,
      kind: "continuation_directions",
      promptVersion,
      prompt,
      schemaName: "continuation_directions",
      schema: ContinuationDirectionsModelOutputSchema,
      modelConfig: input.modelConfig,
      validate: (output) =>
        validateContinuationDirections(output, context.storyMapArtifact.storyMap),
    },
    input.provider,
  );
  const artifact = createContinuationDirectionsArtifact({
    projectId: input.projectId,
    sourceId: context.source.id,
    worldline: context.worldline,
    acceptedImpactPlanArtifact: context.acceptedImpactPlanArtifact,
    output: generation.value,
    generationRunId: generation.generation.runId,
  });

  return { artifact, generation: generation.generation };
}

export async function generateContinuationScene(input: {
  projectId: string;
  worldlineId: string;
  directionsArtifactId: string;
  selectedDirectionId: string;
  provider: AIProvider;
  modelConfig: ModelConfig;
}) {
  const existing = getContinuationSceneForWorldline(input.worldlineId);
  if (existing) {
    if (
      existing.projectId !== input.projectId ||
      existing.continuation.directionsArtifactId !==
        input.directionsArtifactId
    ) {
      throw new Error("找不到当前 Project 的 Continuation");
    }
    if (
      existing.continuation.selectedDirectionId !== input.selectedDirectionId
    ) {
      throw new Error("M0 只允许一个后续场景，不能更换已生成方向");
    }
    return { artifact: existing, generation: null };
  }

  const context = loadContinuationContext(input);
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
  const divergenceEventId = context.worldline.divergence?.eventId;
  if (!divergenceEventId) {
    throw new Error("Continuation Worldline 缺少 Divergence Event");
  }

  const prompt = await buildPrompt("scene", context, selectedDirection);
  const generation = await generateStructured(
    {
      projectId: input.projectId,
      worldlineId: context.worldline.id,
      kind: "continuation_scene",
      promptVersion,
      prompt,
      schemaName: "continuation_scene",
      schema: ContinuationSceneModelOutputSchema,
      modelConfig: input.modelConfig,
      validate: (output) =>
        validateContinuationStatePatch(
          output.statePatch,
          context.currentState,
          context.storyMapArtifact.storyMap,
          divergenceEventId,
          context.worldline.anchors.map((anchor) => anchor.targetEventId),
        ),
    },
    input.provider,
  );
  const artifact = createContinuationSceneArtifact({
    projectId: input.projectId,
    sourceId: context.source.id,
    worldline: context.worldline,
    acceptedImpactPlanArtifact: context.acceptedImpactPlanArtifact,
    directionsArtifact,
    selectedDirectionId: selectedDirection.id,
    output: generation.value,
    generationRunId: generation.generation.runId,
  });

  return { artifact, generation: generation.generation };
}

type ContinuationContext = {
  worldline: Worldline;
  acceptedImpactPlanArtifact: ImpactPlanArtifact;
  storyMapArtifact: StoryMapArtifact;
  source: Source;
  currentState: WorldlineDelta;
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
  const currentState = deriveWorldlineDelta({
    worldline,
    impactPlan: acceptedImpactPlanArtifact.impactPlan,
    storyMap: storyMapArtifact.storyMap,
  });

  return {
    worldline,
    acceptedImpactPlanArtifact,
    storyMapArtifact,
    source,
    currentState,
  };
}

async function buildPrompt(
  stage: "directions" | "scene",
  context: ContinuationContext,
  selectedDirection?: ContinuationDirection,
): Promise<string> {
  const template = await readFile(
    path.join(process.cwd(), "prompts", `${promptVersion}.md`),
    "utf8",
  );
  const relevantEventIds = collectRelevantEventIds(
    context.acceptedImpactPlanArtifact,
  );
  const storyMap = context.storyMapArtifact.storyMap;
  const relevantEvents = storyMap.events.filter((event) =>
    relevantEventIds.has(event.id),
  );
  const readonlyCanonical = {
    sourceId: context.source.id,
    storyMapArtifactId: context.storyMapArtifact.id,
    storyMapId: storyMap.id,
    characters: storyMap.characters,
    events: relevantEvents.map((event) => ({
      id: event.id,
      title: event.title,
      summary: event.summary,
      sequence: event.sequence,
      participants: event.participants,
      stateChanges: event.stateChanges,
    })),
    edges: storyMap.edges.filter(
      (edge) =>
        relevantEventIds.has(edge.from) && relevantEventIds.has(edge.to),
    ),
    endingCandidates: storyMap.endingCandidates.filter((ending) =>
      context.worldline.anchors.some(
        (anchor) => anchor.targetEventId === ending.targetEventId,
      ),
    ),
  };
  const relevantEvidence = relevantEvents.flatMap((event) =>
    event.evidence.map((reference) => ({
      eventId: event.id,
      eventTitle: event.title,
      sourceId: reference.sourceId,
      sectionId: reference.sectionId,
      start: reference.start,
      end: reference.end,
      excerptHash: reference.excerptHash,
      excerpt: context.source.normalizedText.slice(reference.start, reference.end),
    })),
  );
  const packet = {
    stage,
    readonlyCanonical,
    currentWorldline: context.worldline,
    divergence: context.worldline.divergence,
    acceptedImpactPlan: context.acceptedImpactPlanArtifact.impactPlan,
    relevantEvidence,
    currentState: context.currentState,
    ...(selectedDirection ? { selectedDirection } : {}),
  };

  return [
    template,
    "<continuation_context>",
    JSON.stringify(packet),
    "</continuation_context>",
  ].join("\n\n");
}

function collectRelevantEventIds(
  acceptedImpactPlanArtifact: ImpactPlanArtifact,
): Set<string> {
  const plan = acceptedImpactPlanArtifact.impactPlan;
  const ids = new Set<string>([plan.divergence.eventId]);
  for (const impact of plan.impacts) {
    ids.add(impact.fromEventId);
    if (impact.affectedEventId) ids.add(impact.affectedEventId);
    for (const id of impact.reasonPath) ids.add(id);
  }
  for (const evaluation of plan.anchorEvaluations) {
    for (const id of evaluation.reasonPath) ids.add(id);
  }
  for (const anchor of plan.anchors) ids.add(anchor.targetEventId);
  return ids;
}
