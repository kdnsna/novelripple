import { createHash } from "node:crypto";

import {
  ImpactPlanSchema,
  StoryMapArtifactSchema,
  WorldlineSchema,
  type ImpactPlan,
  type StoryMapArtifact,
  type Worldline,
} from "@/domain/schemas";

export type CreateWorldlineInput = {
  projectId: string;
  parentWorldlineId: string;
  baseStoryMapArtifact: StoryMapArtifact;
  impactPlan: ImpactPlan;
  mode: "strict" | "open";
  createdAt?: string;
};

export type CreateCanonicalWorldlineInput = {
  projectId: string;
  baseStoryMapArtifact: StoryMapArtifact;
  createdAt?: string;
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function createCanonicalWorldline(
  input: CreateCanonicalWorldlineInput,
): Worldline {
  const baseStoryMapArtifact = StoryMapArtifactSchema.parse(
    input.baseStoryMapArtifact,
  );
  if (baseStoryMapArtifact.projectId !== input.projectId) {
    throw new Error("Canonical Worldline 与 Story Map Artifact 项目不匹配");
  }
  if (baseStoryMapArtifact.storyMap.status !== "confirmed") {
    throw new Error("Story Map 必须先由用户确认，才能进入 Ripple");
  }

  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        projectId: input.projectId,
        baseStoryMapArtifactId: baseStoryMapArtifact.id,
      }),
    )
    .digest("hex");

  return WorldlineSchema.parse({
    id: `wl_${digest.slice(0, 16)}`,
    projectId: input.projectId,
    parentWorldlineId: null,
    baseStoryMapArtifactId: baseStoryMapArtifact.id,
    divergence: null,
    mode: "open",
    anchors: [],
    acceptedImpactPlanId: null,
    idempotencyKey: `canonical:${baseStoryMapArtifact.id}`,
    status: "canonical",
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

export function createWorldline(input: CreateWorldlineInput): Worldline {
  const impactPlan = ImpactPlanSchema.parse(input.impactPlan);
  const baseStoryMapArtifact = StoryMapArtifactSchema.parse(
    input.baseStoryMapArtifact,
  );

  if (
    baseStoryMapArtifact.projectId !== input.projectId ||
    impactPlan.storyMapId !== baseStoryMapArtifact.storyMap.id
  ) {
    throw new Error("Impact Plan 与 Story Map Artifact 不匹配");
  }
  if (baseStoryMapArtifact.storyMap.status !== "confirmed") {
    throw new Error("Story Map 必须先由用户确认，才能进入 Ripple");
  }

  if (impactPlan.status !== "accepted") {
    throw new Error("Impact Plan 必须由用户接受后才能创建世界线");
  }
  if (impactPlan.mode !== input.mode) {
    throw new Error("Worldline 模式必须与已接受 Impact Plan 一致");
  }

  if (input.mode === "strict") {
    const incompatibleAnchor = impactPlan.anchorEvaluations.find(
      (evaluation) => evaluation.status === "incompatible",
    );

    if (incompatibleAnchor) {
      throw new Error(
        `严格模式锚点不兼容：${incompatibleAnchor.anchorId}`,
      );
    }
  }

  const anchors = input.mode === "open" ? [] : impactPlan.anchors;
  const idempotencyPayload = stableValue({
    projectId: input.projectId,
    parentWorldlineId: input.parentWorldlineId,
    baseStoryMapArtifactId: baseStoryMapArtifact.id,
    impactPlanId: impactPlan.id,
    divergence: impactPlan.divergence,
    mode: input.mode,
    anchors,
  });
  const digest = createHash("sha256")
    .update(JSON.stringify(idempotencyPayload))
    .digest("hex");

  return WorldlineSchema.parse({
    id: `wl_${digest.slice(0, 16)}`,
    projectId: input.projectId,
    parentWorldlineId: input.parentWorldlineId,
    baseStoryMapArtifactId: baseStoryMapArtifact.id,
    divergence: impactPlan.divergence,
    mode: input.mode,
    anchors,
    acceptedImpactPlanId: impactPlan.id,
    idempotencyKey: `sha256:${digest}`,
    status: "active",
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}
