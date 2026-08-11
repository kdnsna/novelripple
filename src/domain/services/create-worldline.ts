import { createHash } from "node:crypto";

import {
  ImpactPlanSchema,
  WorldlineSchema,
  type ImpactPlan,
  type Worldline,
} from "@/domain/schemas";

export type CreateWorldlineInput = {
  projectId: string;
  parentWorldlineId: string;
  baseStoryMapArtifactId: string;
  impactPlan: ImpactPlan;
  mode: "strict" | "open";
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

export function createWorldline(input: CreateWorldlineInput): Worldline {
  const impactPlan = ImpactPlanSchema.parse(input.impactPlan);

  if (impactPlan.status !== "accepted") {
    throw new Error("Impact Plan 必须由用户接受后才能创建世界线");
  }

  if (input.mode === "strict") {
    const incompatibleHardAnchor = impactPlan.anchorEvaluations.find(
      (evaluation) =>
        evaluation.status === "incompatible" &&
        impactPlan.anchors.find((anchor) => anchor.id === evaluation.anchorId)
          ?.strength === "hard",
    );

    if (incompatibleHardAnchor) {
      throw new Error(
        `严格模式锚点不兼容：${incompatibleHardAnchor.anchorId}`,
      );
    }
  }

  const anchors = input.mode === "open" ? [] : impactPlan.anchors;
  const idempotencyPayload = stableValue({
    projectId: input.projectId,
    parentWorldlineId: input.parentWorldlineId,
    baseStoryMapArtifactId: input.baseStoryMapArtifactId,
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
    baseStoryMapArtifactId: input.baseStoryMapArtifactId,
    divergence: impactPlan.divergence,
    mode: input.mode,
    anchors,
    acceptedImpactPlanId: impactPlan.id,
    idempotencyKey: `sha256:${digest}`,
    status: "active",
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}
