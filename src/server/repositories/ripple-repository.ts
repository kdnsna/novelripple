import { createHash } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import { assertValidImpactPlan } from "@/domain/invariants/validate-story-map";
import { deriveWorldlineDelta } from "@/domain/invariants/validate-continuation";
import {
  ImpactPlanArtifactSchema,
  ImpactPlanSchema,
  WorldlineSchema,
  type ImpactPlan,
  type ImpactPlanArtifact,
  type StoryMapArtifact,
  type Worldline,
} from "@/domain/schemas";
import {
  createCanonicalWorldline,
  createWorldline,
} from "@/domain/services/create-worldline";
import { getDatabase } from "@/server/db/client";
import { artifacts, worldlines } from "@/server/db/schema";
import { getGenerationRun } from "@/server/repositories/generation-run-repository";
import { getStoryMapArtifact } from "@/server/repositories/story-map-artifact-repository";

export function createImpactPlanArtifact(input: {
  projectId: string;
  storyMapArtifact: StoryMapArtifact;
  impactPlan: ImpactPlan;
  generationRunId: string;
}): ImpactPlanArtifact {
  const impactPlan = ImpactPlanSchema.parse(input.impactPlan);
  if (
    input.storyMapArtifact.projectId !== input.projectId ||
    input.storyMapArtifact.storyMap.status !== "confirmed" ||
    input.storyMapArtifact.storyMap.id !== impactPlan.storyMapId ||
    impactPlan.status !== "candidate"
  ) {
    throw new Error(
      "候选 Impact Plan 必须绑定当前项目的 confirmed Story Map Artifact",
    );
  }
  assertValidImpactPlan(impactPlan, input.storyMapArtifact.storyMap);

  const run = getGenerationRun(input.generationRunId);
  if (
    !run ||
    run.projectId !== input.projectId ||
    run.worldlineId !== null ||
    run.kind !== "impact_plan" ||
    run.status !== "succeeded"
  ) {
    throw new Error("Impact Plan Artifact 必须绑定成功的 Generation Run");
  }

  const artifact = ImpactPlanArtifactSchema.parse({
    id: impactPlan.id,
    projectId: input.projectId,
    sourceId: input.storyMapArtifact.sourceId,
    storyMapArtifactId: input.storyMapArtifact.id,
    kind: "impact_plan",
    schemaVersion: 1,
    impactPlan,
    basedOnArtifactId: input.storyMapArtifact.id,
    generationRunId: run.id,
    createdAt: new Date().toISOString(),
  });

  getDatabase()
    .insert(artifacts)
    .values({
      id: artifact.id,
      projectId: artifact.projectId,
      sourceId: artifact.sourceId,
      worldlineId: null,
      kind: artifact.kind,
      schemaVersion: artifact.schemaVersion,
      version: null,
      dataJson: JSON.stringify({
        storyMapArtifactId: artifact.storyMapArtifactId,
        impactPlan: artifact.impactPlan,
      }),
      basedOnArtifactId: artifact.basedOnArtifactId,
      generationRunId: artifact.generationRunId,
      createdAt: artifact.createdAt,
    })
    .run();

  return artifact;
}

export function getImpactPlanArtifact(id: string): ImpactPlanArtifact | null {
  const row = getDatabase()
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, id), eq(artifacts.kind, "impact_plan")))
    .get();
  return row ? parseImpactPlanArtifact(row) : null;
}

export function listImpactPlanArtifactsForStoryMap(
  projectId: string,
  storyMapArtifactId: string,
): ImpactPlanArtifact[] {
  return getDatabase()
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.projectId, projectId),
        eq(artifacts.kind, "impact_plan"),
      ),
    )
    .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
    .all()
    .map(parseImpactPlanArtifact)
    .filter((artifact) => artifact.storyMapArtifactId === storyMapArtifactId);
}

export function listProjectWorldlines(projectId: string): Worldline[] {
  return getDatabase()
    .select()
    .from(worldlines)
    .where(eq(worldlines.projectId, projectId))
    .orderBy(desc(worldlines.createdAt), desc(worldlines.id))
    .all()
    .map(parseWorldline);
}

export function acceptImpactPlan(input: {
  projectId: string;
  candidateArtifactId: string;
}): {
  acceptedArtifact: ImpactPlanArtifact;
  canonicalWorldline: Worldline;
  worldline: Worldline;
} {
  const candidate = getImpactPlanArtifact(input.candidateArtifactId);
  if (
    !candidate ||
    candidate.projectId !== input.projectId ||
    candidate.impactPlan.status !== "candidate"
  ) {
    throw new Error("找不到可接受的候选 Impact Plan Artifact");
  }
  const storyMapArtifact = getStoryMapArtifact(candidate.storyMapArtifactId);
  if (
    !storyMapArtifact ||
    storyMapArtifact.projectId !== input.projectId ||
    storyMapArtifact.sourceId !== candidate.sourceId ||
    storyMapArtifact.storyMap.status !== "confirmed"
  ) {
    throw new Error("候选 Impact Plan 未绑定 confirmed Story Map Artifact");
  }

  const acceptedId = acceptedArtifactId(candidate.id);
  const createdAt = new Date().toISOString();
  const acceptedPlan = ImpactPlanSchema.parse({
    ...candidate.impactPlan,
    id: acceptedId,
    status: "accepted",
  });
  assertValidImpactPlan(acceptedPlan, storyMapArtifact.storyMap);
  const acceptedArtifact = ImpactPlanArtifactSchema.parse({
    id: acceptedId,
    projectId: input.projectId,
    sourceId: candidate.sourceId,
    storyMapArtifactId: storyMapArtifact.id,
    kind: "impact_plan",
    schemaVersion: 1,
    impactPlan: acceptedPlan,
    basedOnArtifactId: candidate.id,
    generationRunId: null,
    createdAt,
  });
  const canonicalWorldline = createCanonicalWorldline({
    projectId: input.projectId,
    baseStoryMapArtifact: storyMapArtifact,
    createdAt,
  });
  const childWorldline = createWorldline({
    projectId: input.projectId,
    parentWorldlineId: canonicalWorldline.id,
    baseStoryMapArtifact: storyMapArtifact,
    impactPlan: acceptedPlan,
    mode: acceptedPlan.mode,
    createdAt,
  });
  deriveWorldlineDelta({
    worldline: childWorldline,
    impactPlan: acceptedPlan,
    storyMap: storyMapArtifact.storyMap,
  });

  const database = getDatabase();
  database.transaction((transaction) => {
    transaction
      .insert(artifacts)
      .values({
        id: acceptedArtifact.id,
        projectId: acceptedArtifact.projectId,
        sourceId: acceptedArtifact.sourceId,
        worldlineId: null,
        kind: acceptedArtifact.kind,
        schemaVersion: acceptedArtifact.schemaVersion,
        version: null,
        dataJson: JSON.stringify({
          storyMapArtifactId: acceptedArtifact.storyMapArtifactId,
          impactPlan: acceptedArtifact.impactPlan,
        }),
        basedOnArtifactId: acceptedArtifact.basedOnArtifactId,
        generationRunId: null,
        createdAt: acceptedArtifact.createdAt,
      })
      .onConflictDoNothing()
      .run();

    transaction
      .insert(worldlines)
      .values(toWorldlineRow(canonicalWorldline))
      .onConflictDoNothing()
      .run();

    transaction
      .insert(worldlines)
      .values(toWorldlineRow(childWorldline))
      .onConflictDoNothing()
      .run();
  });

  const storedAccepted = getImpactPlanArtifact(acceptedArtifact.id);
  const storedCanonical = getWorldline(canonicalWorldline.id);
  const storedChild = getWorldline(childWorldline.id);
  if (
    !storedAccepted ||
    storedAccepted.basedOnArtifactId !== candidate.id ||
    !storedCanonical ||
    !storedChild
  ) {
    throw new Error("Impact Plan 接受事务未能恢复完整结果");
  }

  return {
    acceptedArtifact: storedAccepted,
    canonicalWorldline: storedCanonical,
    worldline: storedChild,
  };
}

function acceptedArtifactId(candidateArtifactId: string): string {
  const digest = createHash("sha256")
    .update(`accepted:${candidateArtifactId}`)
    .digest("hex");
  return `artifact_impact_plan_${digest.slice(0, 24)}`;
}

function toWorldlineRow(worldline: Worldline): typeof worldlines.$inferInsert {
  return {
    id: worldline.id,
    projectId: worldline.projectId,
    parentWorldlineId: worldline.parentWorldlineId,
    baseStoryMapArtifactId: worldline.baseStoryMapArtifactId,
    divergenceJson: worldline.divergence
      ? JSON.stringify(worldline.divergence)
      : null,
    mode: worldline.mode,
    anchorsJson: JSON.stringify(worldline.anchors),
    acceptedImpactPlanId: worldline.acceptedImpactPlanId,
    idempotencyKey: worldline.idempotencyKey,
    status: worldline.status,
    createdAt: worldline.createdAt,
  };
}

export function getWorldline(id: string): Worldline | null {
  const row = getDatabase()
    .select()
    .from(worldlines)
    .where(eq(worldlines.id, id))
    .get();
  return row ? parseWorldline(row) : null;
}

function parseImpactPlanArtifact(
  row: typeof artifacts.$inferSelect,
): ImpactPlanArtifact {
  if (row.sourceId === null || row.basedOnArtifactId === null) {
    throw new Error(`Impact Plan Artifact 缺少来源引用：${row.id}`);
  }
  const data = JSON.parse(row.dataJson) as unknown;
  if (!data || typeof data !== "object") {
    throw new Error(`Impact Plan Artifact 数据无效：${row.id}`);
  }
  const packet = data as {
    storyMapArtifactId?: unknown;
    impactPlan?: unknown;
  };

  return ImpactPlanArtifactSchema.parse({
    id: row.id,
    projectId: row.projectId,
    sourceId: row.sourceId,
    storyMapArtifactId: packet.storyMapArtifactId,
    kind: row.kind,
    schemaVersion: row.schemaVersion,
    impactPlan: packet.impactPlan,
    basedOnArtifactId: row.basedOnArtifactId,
    generationRunId: row.generationRunId,
    createdAt: normalizeSqliteDate(row.createdAt),
  });
}

function parseWorldline(row: typeof worldlines.$inferSelect): Worldline {
  return WorldlineSchema.parse({
    id: row.id,
    projectId: row.projectId,
    parentWorldlineId: row.parentWorldlineId,
    baseStoryMapArtifactId: row.baseStoryMapArtifactId,
    divergence: row.divergenceJson ? JSON.parse(row.divergenceJson) : null,
    mode: row.mode,
    anchors: JSON.parse(row.anchorsJson),
    acceptedImpactPlanId: row.acceptedImpactPlanId,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    createdAt: normalizeSqliteDate(row.createdAt),
  });
}

function normalizeSqliteDate(value: string): string {
  if (value.includes("T")) return value;
  return `${value.replace(" ", "T")}Z`;
}
