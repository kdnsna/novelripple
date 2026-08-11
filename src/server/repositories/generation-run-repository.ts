import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import {
  GenerationRunSchema,
  type GenerationRun,
} from "@/domain/schemas";
import { getDatabase } from "@/server/db/client";
import { generationRuns } from "@/server/db/schema";

type CreateGenerationRunInput = Pick<
  GenerationRun,
  | "projectId"
  | "worldlineId"
  | "kind"
  | "provider"
  | "model"
  | "promptVersion"
  | "inputHash"
>;

export function createGenerationRun(
  input: CreateGenerationRunInput,
): GenerationRun {
  const run = GenerationRunSchema.parse({
    id: `generation_run_${randomUUID()}`,
    ...input,
    status: "pending",
    rawOutput: null,
    error: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  });

  getDatabase().insert(generationRuns).values(run).run();
  return run;
}

export function succeedGenerationRun(input: {
  id: string;
  rawOutput: string;
}): GenerationRun {
  const row = getDatabase()
    .update(generationRuns)
    .set({
      status: "succeeded",
      rawOutput: input.rawOutput,
      error: null,
      completedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(generationRuns.id, input.id),
        eq(generationRuns.status, "pending"),
      ),
    )
    .returning()
    .get();

  if (!row) throw new Error("Generation Run is not pending");
  return GenerationRunSchema.parse(row);
}

export function failGenerationRun(input: {
  id: string;
  rawOutput: string | null;
  error: string;
}): GenerationRun {
  const row = getDatabase()
    .update(generationRuns)
    .set({
      status: "failed",
      rawOutput: input.rawOutput,
      error: input.error,
      completedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(generationRuns.id, input.id),
        eq(generationRuns.status, "pending"),
      ),
    )
    .returning()
    .get();

  if (!row) throw new Error("Generation Run is not pending");
  return GenerationRunSchema.parse(row);
}

export function getGenerationRun(id: string): GenerationRun | null {
  const row = getDatabase()
    .select()
    .from(generationRuns)
    .where(eq(generationRuns.id, id))
    .get();

  return row ? GenerationRunSchema.parse(row) : null;
}

export function listProjectGenerationRuns(projectId: string): GenerationRun[] {
  return getDatabase()
    .select()
    .from(generationRuns)
    .where(eq(generationRuns.projectId, projectId))
    .orderBy(desc(generationRuns.createdAt), desc(generationRuns.id))
    .all()
    .map((row) => GenerationRunSchema.parse(row));
}
