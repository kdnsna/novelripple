import { createHash } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";

import {
  ContinuationArtifactSchema,
  ContinuationDirectionsArtifactSchema,
  ContinuationDirectionsModelOutputSchema,
  ContinuationDirectionsSchema,
  ContinuationSceneArtifactSchema,
  ContinuationSceneModelOutputSchema,
  ContinuationSchema,
  type ContinuationArtifact,
  type ContinuationDirectionsArtifact,
  type ContinuationDirectionsModelOutput,
  type ContinuationSceneArtifact,
  type ContinuationSceneModelOutput,
  type ImpactPlanArtifact,
  type Worldline,
} from "@/domain/schemas";
import { getDatabase } from "@/server/db/client";
import { artifacts } from "@/server/db/schema";
import { getGenerationRun } from "@/server/repositories/generation-run-repository";

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

  const id = stableArtifactId("directions", input.worldline.id);
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
  if (
    input.directionsArtifact.projectId !== input.projectId ||
    input.directionsArtifact.sourceId !== input.sourceId ||
    input.directionsArtifact.worldlineId !== input.worldline.id ||
    input.directionsArtifact.continuation.acceptedImpactPlanId !==
      input.acceptedImpactPlanArtifact.id ||
    !input.directionsArtifact.continuation.directions.some(
      (direction) => direction.id === input.selectedDirectionId,
    )
  ) {
    throw new Error("后续场景未绑定当前 Worldline 的有效方向");
  }
  assertGenerationRun({
    id: input.generationRunId,
    projectId: input.projectId,
    worldlineId: input.worldline.id,
    kind: "continuation_scene",
  });

  const id = stableArtifactId("scene", input.worldline.id);
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
    throw new Error("M0 只允许一个后续场景，不能更换已生成方向");
  }
  return stored;
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

export function getContinuationDirectionsForWorldline(
  worldlineId: string,
): ContinuationDirectionsArtifact | null {
  const artifact = listContinuationArtifactsForWorldline(worldlineId).find(
    (candidate) => candidate.artifactType === "directions",
  );
  return artifact?.artifactType === "directions" ? artifact : null;
}

export function getContinuationSceneForWorldline(
  worldlineId: string,
): ContinuationSceneArtifact | null {
  const artifact = listContinuationArtifactsForWorldline(worldlineId).find(
    (candidate) => candidate.artifactType === "scene",
  );
  return artifact?.artifactType === "scene" ? artifact : null;
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
    row.worldlineId === null ||
    row.basedOnArtifactId === null ||
    row.generationRunId === null
  ) {
    throw new Error(`Continuation Artifact 缺少必要引用：${row.id}`);
  }
  const packet = JSON.parse(row.dataJson) as {
    artifactType?: unknown;
    continuation?: unknown;
  };
  return ContinuationArtifactSchema.parse({
    id: row.id,
    projectId: row.projectId,
    sourceId: row.sourceId,
    worldlineId: row.worldlineId,
    kind: row.kind,
    artifactType: packet.artifactType,
    schemaVersion: row.schemaVersion,
    continuation: packet.continuation,
    basedOnArtifactId: row.basedOnArtifactId,
    generationRunId: row.generationRunId,
    createdAt: normalizeSqliteDate(row.createdAt),
  });
}

function stableArtifactId(
  type: "directions" | "scene",
  worldlineId: string,
): string {
  const digest = createHash("sha256")
    .update(`continuation:${type}:${worldlineId}`)
    .digest("hex");
  return `artifact_continuation_${type}_${digest.slice(0, 24)}`;
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
