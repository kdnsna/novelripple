import { and, eq } from "drizzle-orm";

import {
  WorldlineSchema,
  type ImpactPlan,
  type Worldline,
} from "@/domain/schemas";
import { createWorldline } from "@/domain/services/create-worldline";
import { getDatabase } from "@/server/db/client";
import {
  artifacts,
  projects,
  sources,
  worldlines,
} from "@/server/db/schema";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";

const projectId = "project_ripple_001";
const canonicalWorldlineId = "wl_ripple_001_canonical";
const storyMapArtifactId = "artifact_story_map_ripple_001_v1";

export async function ensureDemoProject(): Promise<void> {
  const database = getDatabase();
  const { source, storyMap } = await loadRippleFixture();

  database.transaction((transaction) => {
    transaction
      .insert(projects)
      .values({
        id: projectId,
        title: source.title,
        createdAt: source.createdAt,
        updatedAt: source.createdAt,
      })
      .onConflictDoNothing()
      .run();

    transaction
      .insert(sources)
      .values({
        id: source.id,
        projectId,
        title: source.title,
        originalText: source.originalText,
        normalizedText: source.normalizedText,
        contentHash: source.contentHash,
        sectionsJson: JSON.stringify(source.sections),
        createdAt: source.createdAt,
      })
      .onConflictDoNothing()
      .run();

    transaction
      .insert(artifacts)
      .values({
        id: storyMapArtifactId,
        projectId,
        worldlineId: canonicalWorldlineId,
        kind: "story_map",
        schemaVersion: 1,
        dataJson: JSON.stringify(storyMap),
        createdAt: source.createdAt,
      })
      .onConflictDoNothing()
      .run();

    transaction
      .insert(worldlines)
      .values({
        id: canonicalWorldlineId,
        projectId,
        parentWorldlineId: null,
        baseStoryMapArtifactId: storyMapArtifactId,
        divergenceJson: null,
        mode: "open",
        anchorsJson: "[]",
        acceptedImpactPlanId: null,
        idempotencyKey: `canonical:${projectId}`,
        status: "canonical",
        createdAt: source.createdAt,
      })
      .onConflictDoNothing()
      .run();
  });
}

export async function listDemoWorldlines(): Promise<Worldline[]> {
  await ensureDemoProject();
  const rows = getDatabase()
    .select()
    .from(worldlines)
    .where(eq(worldlines.projectId, projectId))
    .all();

  return rows.map((row) =>
    WorldlineSchema.parse({
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
    }),
  );
}

export async function acceptDemoImpactPlan(
  impactPlanId: string,
  mode: "strict" | "open",
): Promise<Worldline> {
  await ensureDemoProject();
  const { impactPlans } = await loadRippleFixture();
  const candidate = impactPlans.find((item) => item.id === impactPlanId);
  if (!candidate) throw new Error("找不到指定的 Impact Plan");

  const acceptedPlan: ImpactPlan = { ...candidate, status: "accepted" };
  const worldline = createWorldline({
    projectId,
    parentWorldlineId: canonicalWorldlineId,
    baseStoryMapArtifactId: storyMapArtifactId,
    impactPlan: acceptedPlan,
    mode,
  });
  const database = getDatabase();

  database.transaction((transaction) => {
    transaction
      .insert(artifacts)
      .values({
        id: acceptedPlan.id,
        projectId,
        worldlineId: null,
        kind: "impact_plan",
        schemaVersion: 1,
        dataJson: JSON.stringify(acceptedPlan),
        basedOnArtifactId: storyMapArtifactId,
        generationRunId: null,
        createdAt: worldline.createdAt,
      })
      .onConflictDoNothing()
      .run();

    transaction
      .insert(worldlines)
      .values({
        id: worldline.id,
        projectId: worldline.projectId,
        parentWorldlineId: worldline.parentWorldlineId,
        baseStoryMapArtifactId: worldline.baseStoryMapArtifactId,
        divergenceJson: JSON.stringify(worldline.divergence),
        mode: worldline.mode,
        anchorsJson: JSON.stringify(worldline.anchors),
        acceptedImpactPlanId: worldline.acceptedImpactPlanId,
        idempotencyKey: worldline.idempotencyKey,
        status: worldline.status,
        createdAt: worldline.createdAt,
      })
      .onConflictDoNothing()
      .run();
  });

  const stored = database
    .select()
    .from(worldlines)
    .where(
      and(
        eq(worldlines.projectId, projectId),
        eq(worldlines.idempotencyKey, worldline.idempotencyKey),
      ),
    )
    .get();

  if (!stored) throw new Error("世界线写入失败");
  return WorldlineSchema.parse({
    ...worldline,
    id: stored.id,
    createdAt: normalizeSqliteDate(stored.createdAt),
  });
}

function normalizeSqliteDate(value: string): string {
  if (value.includes("T")) return value;
  return `${value.replace(" ", "T")}Z`;
}
