import { randomUUID } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";

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
> & {
  /** 可选：把本次生成绑定到具体 Story Map revision；旧调用方无需传。 */
  storyMapArtifactId?: string | null;
};

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

/**
 * 统计某个 Story Map revision 上已发起的 Ripple Suggestions 生成尝试。
 *
 * 每行 Generation Run 在第一次 provider 调用前创建，失败时保留为 failed，
 * 因此 pending / succeeded / failed 都算一次尝试。批次 Artifact 只在成功时
 * 写入；只数批次会让失败重试绕过成本上限，所以上限必须按这里的尝试数检查。
 */
export function countRippleSuggestionGenerationRunsForStoryMap(
  projectId: string,
  storyMapArtifactId: string,
): number {
  const row = getDatabase()
    .select({ count: sql<number>`count(*)` })
    .from(generationRuns)
    .where(
      and(
        eq(generationRuns.projectId, projectId),
        eq(generationRuns.kind, "ripple_suggestions"),
        eq(generationRuns.storyMapArtifactId, storyMapArtifactId),
      ),
    )
    .get();
  return row?.count ?? 0;
}
