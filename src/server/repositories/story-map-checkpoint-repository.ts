import { randomUUID } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";

import type { EvidenceUnitChunk } from "@/domain/source/evidence-unit-chunks";
import { sha256 } from "@/domain/source/normalize-source";
import { getDatabase } from "@/server/db/client";
import { storyMapChunkCheckpoints } from "@/server/db/schema";

/**
 * Story Map 分块检查点只存“已验证的结构化中间候选”，不存 Prompt、原文或原始模型文本。
 *
 * 检查点粒度是单个分块的一个阶段（extract / glean）：阶段一完成就追加一行，
 * 崩溃后即使只完成了抽取、还没补抽，也能在下一次 attempt 复用抽取结果。
 * 每行记录产生该阶段结果的 `generation_run_id`，复用时可把原始 Run 带入生成结果；
 * 迁移 0009 之前写入的旧行该字段为 null。
 * 行永不被 UPDATE；key 不匹配的旧行只是不再命中。
 */
export const STORY_MAP_CHECKPOINT_STAGES = ["extract", "glean"] as const;

export type StoryMapCheckpointStage =
  (typeof STORY_MAP_CHECKPOINT_STAGES)[number];

export type StoredStoryMapChunkCheckpoint = {
  id: string;
  projectId: string;
  sourceId: string;
  sourceContentHash: string;
  runGroupId: string;
  checkpointKey: string;
  chunkIndex: number;
  stage: StoryMapCheckpointStage;
  resultJson: string;
  modelCalls: number;
  /** 产生该阶段结果的 Generation Run；迁移前写入的旧行为 null。 */
  generationRunId: string | null;
};

/**
 * 分块检查点的确定性 key。任何会改变该阶段输出的输入都进入 hash：
 * Source 身份与内容、分块计划（core + context Unit 顺序）、全部 Prompt 版本、
 * 模型与 provider 身份。Source 更新、Prompt 升级或分块计划变化都会自然失效。
 */
export function storyMapChunkCheckpointKey(input: {
  sourceId: string;
  sourceContentHash: string;
  chunk: Pick<
    EvidenceUnitChunk,
    "id" | "index" | "coreUnitIds" | "contextUnitIds"
  >;
  promptVersions: Readonly<Record<string, string>>;
  model: string;
  providerName: string;
}): string {
  const promptVersions = Object.fromEntries(
    Object.entries(input.promptVersions).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return sha256(
    JSON.stringify({
      sourceId: input.sourceId,
      sourceContentHash: input.sourceContentHash,
      chunk: {
        id: input.chunk.id,
        index: input.chunk.index,
        coreUnitIds: input.chunk.coreUnitIds,
        contextUnitIds: input.chunk.contextUnitIds,
      },
      promptVersions,
      model: input.model,
      providerName: input.providerName,
    }),
  );
}

/** 读取同一 run group 的全部检查点；新行在前，调用方按 key + stage 取第一条。 */
export function listStoryMapChunkCheckpoints(input: {
  projectId: string;
  runGroupId: string;
}): StoredStoryMapChunkCheckpoint[] {
  return getDatabase()
    .select()
    .from(storyMapChunkCheckpoints)
    .where(
      and(
        eq(storyMapChunkCheckpoints.projectId, input.projectId),
        eq(storyMapChunkCheckpoints.runGroupId, input.runGroupId),
      ),
    )
    .orderBy(desc(sql`rowid`))
    .all()
    .map((row) => ({
      id: row.id,
      projectId: row.projectId,
      sourceId: row.sourceId,
      sourceContentHash: row.sourceContentHash,
      runGroupId: row.runGroupId,
      checkpointKey: row.checkpointKey,
      chunkIndex: row.chunkIndex,
      stage: row.stage,
      resultJson: row.resultJson,
      modelCalls: row.modelCalls,
      generationRunId: row.generationRunId,
    }));
}

/**
 * 同一 run group 检查点已记录的单阶段调用数之和。
 *
 * 这只是直接调用管线且调用方没有提供任务级计数时的保守回退；后台 Runner
 * 使用 `jobs.model_calls` 求和，才能覆盖“调用已发生但结果尚未落检查点”的窗口。
 */
export function sumStoryMapCheckpointModelCalls(input: {
  projectId: string;
  runGroupId: string;
}): number {
  return listStoryMapChunkCheckpoints(input).reduce(
    (total, checkpoint) => total + checkpoint.modelCalls,
    0,
  );
}

/**
 * 追加一条已验证的分块阶段结果。只 INSERT，不 UPDATE；
 * 同一 key + stage 的旧行保持不变。
 */
export function saveStoryMapChunkCheckpoint(input: {
  projectId: string;
  sourceId: string;
  sourceContentHash: string;
  runGroupId: string;
  checkpointKey: string;
  chunkIndex: number;
  stage: StoryMapCheckpointStage;
  result: unknown;
  modelCalls: number;
  /** 产生该阶段结果的 Generation Run；重试复用时据此恢复来源。 */
  generationRunId: string;
  now?: string;
}): void {
  if (!Number.isInteger(input.modelCalls) || input.modelCalls < 0) {
    throw new Error("检查点 modelCalls 必须是非负整数");
  }
  getDatabase()
    .insert(storyMapChunkCheckpoints)
    .values({
      id: `ckpt_${randomUUID()}`,
      projectId: input.projectId,
      sourceId: input.sourceId,
      sourceContentHash: input.sourceContentHash,
      runGroupId: input.runGroupId,
      checkpointKey: input.checkpointKey,
      chunkIndex: input.chunkIndex,
      stage: input.stage,
      resultJson: JSON.stringify(input.result),
      modelCalls: input.modelCalls,
      generationRunId: input.generationRunId,
      createdAt: input.now ?? new Date().toISOString(),
    })
    .run();
}
