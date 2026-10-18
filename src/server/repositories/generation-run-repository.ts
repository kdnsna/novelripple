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
    modelCalls: 0,
    status: "pending",
    rawOutput: null,
    error: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  });

  getDatabase().insert(generationRuns).values(run).run();
  return run;
}

/**
 * 在真正发起下一次 provider 调用前，把本 run 的调用数自增并落库。
 *
 * 只有仍为 pending 的 run 才能计数：若写入返回空行（例如 run 已被其它
 * 路径结束）或抛错，调用方必须在发出 provider 请求前中止，保证不会产生
 * 未计入预算的真实调用。旧行没有 model_calls，不影响新 run 的自增。
 */
export function incrementGenerationRunModelCalls(id: string): number {
  const row = getDatabase()
    .update(generationRuns)
    .set({
      modelCalls: sql`coalesce(${generationRuns.modelCalls}, 0) + 1`,
    })
    .where(
      and(
        eq(generationRuns.id, id),
        eq(generationRuns.status, "pending"),
      ),
    )
    .returning({ modelCalls: generationRuns.modelCalls })
    .get();

  if (!row || row.modelCalls === null) {
    throw new Error("Generation Run is not pending; model call was not counted");
  }
  return row.modelCalls;
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
 * 统计某个 Story Map revision 上已发生的真实 Ripple Suggestions 模型调用数。
 *
 * 每次 provider 调用前都会自增当前 run 的 model_calls，所以成功、失败、
 * pending 的调用都被计入。迁移 0011 之前的旧行没有 model_calls（null），
 * 无法知道真实次数，按每个 run 1 次保守兜底；没有绑定 story_map_artifact_id
 * 的旧 run 无法归属到具体 revision，不参与计数。
 */
export function sumRippleSuggestionModelCallsForStoryMap(
  projectId: string,
  storyMapArtifactId: string,
): number {
  const row = getDatabase()
    .select({
      total: sql<number>`coalesce(sum(coalesce(${generationRuns.modelCalls}, 1)), 0)`,
    })
    .from(generationRuns)
    .where(
      and(
        eq(generationRuns.projectId, projectId),
        eq(generationRuns.kind, "ripple_suggestions"),
        eq(generationRuns.storyMapArtifactId, storyMapArtifactId),
      ),
    )
    .get();
  return row?.total ?? 0;
}
