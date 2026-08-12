import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import {
  RippleSuggestionsArtifactSchema,
  type RippleSuggestion,
  type RippleSuggestionsArtifact,
  type StoryMapArtifact,
} from "@/domain/schemas";
import { getDatabase } from "@/server/db/client";
import { artifacts } from "@/server/db/schema";
import { getGenerationRun } from "@/server/repositories/generation-run-repository";

export function createRippleSuggestionsArtifact(input: {
  projectId: string;
  storyMapArtifact: StoryMapArtifact;
  suggestions: RippleSuggestion[];
  generationRunId: string;
}): RippleSuggestionsArtifact {
  if (
    input.storyMapArtifact.projectId !== input.projectId ||
    input.storyMapArtifact.storyMap.status !== "confirmed"
  ) {
    throw new Error(
      "Ripple Suggestions 必须绑定当前项目的 confirmed Story Map Artifact",
    );
  }
  const run = getGenerationRun(input.generationRunId);
  if (
    !run ||
    run.projectId !== input.projectId ||
    run.worldlineId !== null ||
    run.kind !== "ripple_suggestions" ||
    run.status !== "succeeded"
  ) {
    throw new Error("Ripple Suggestions Artifact 必须绑定成功的 Generation Run");
  }

  const artifact = RippleSuggestionsArtifactSchema.parse({
    id: `artifact_ripple_suggestions_${randomUUID()}`,
    projectId: input.projectId,
    sourceId: input.storyMapArtifact.sourceId,
    storyMapArtifactId: input.storyMapArtifact.id,
    kind: "ripple_suggestions",
    schemaVersion: 1,
    suggestions: input.suggestions,
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
        suggestions: artifact.suggestions,
      }),
      basedOnArtifactId: artifact.basedOnArtifactId,
      generationRunId: artifact.generationRunId,
      createdAt: artifact.createdAt,
    })
    .run();

  return artifact;
}

export function getRippleSuggestionsArtifact(
  id: string,
): RippleSuggestionsArtifact | null {
  const row = getDatabase()
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, id), eq(artifacts.kind, "ripple_suggestions")))
    .get();
  return row ? parseRippleSuggestionsArtifact(row) : null;
}

export function listRippleSuggestionsArtifactsForStoryMap(
  projectId: string,
  storyMapArtifactId: string,
): RippleSuggestionsArtifact[] {
  return getDatabase()
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.projectId, projectId),
        eq(artifacts.kind, "ripple_suggestions"),
      ),
    )
    .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
    .all()
    .map(parseRippleSuggestionsArtifact)
    .filter((artifact) => artifact.storyMapArtifactId === storyMapArtifactId);
}

function parseRippleSuggestionsArtifact(
  row: typeof artifacts.$inferSelect,
): RippleSuggestionsArtifact {
  if (
    row.sourceId === null ||
    row.basedOnArtifactId === null ||
    row.generationRunId === null
  ) {
    throw new Error(`Ripple Suggestions Artifact 缺少来源引用：${row.id}`);
  }
  const packet = JSON.parse(row.dataJson) as {
    storyMapArtifactId?: unknown;
    suggestions?: unknown;
  };
  return RippleSuggestionsArtifactSchema.parse({
    id: row.id,
    projectId: row.projectId,
    sourceId: row.sourceId,
    storyMapArtifactId: packet.storyMapArtifactId,
    kind: row.kind,
    schemaVersion: row.schemaVersion,
    suggestions: packet.suggestions,
    basedOnArtifactId: row.basedOnArtifactId,
    generationRunId: row.generationRunId,
    createdAt: normalizeSqliteDate(row.createdAt),
  });
}

function normalizeSqliteDate(value: string): string {
  if (value.includes("T")) return value;
  return `${value.replace(" ", "T")}Z`;
}
