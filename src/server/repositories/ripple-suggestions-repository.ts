import { createHash, randomUUID } from "node:crypto";

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
  batchIndex?: number;
  refreshOf?: string | null;
  idempotencyKey?: string | null;
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
    run.storyMapArtifactId !== input.storyMapArtifact.id ||
    run.kind !== "ripple_suggestions" ||
    run.status !== "succeeded"
  ) {
    throw new Error("Ripple Suggestions Artifact 必须绑定成功的 Generation Run");
  }

  const batchIndex = input.batchIndex ?? 0;
  const refreshOf = input.refreshOf ?? null;
  const idempotencyKey = input.idempotencyKey ?? null;
  if (!Number.isInteger(batchIndex) || batchIndex < 0) {
    throw new Error(`Ripple Suggestions 批次索引必须是非负整数：${batchIndex}`);
  }
  if (batchIndex === 0) {
    if (refreshOf !== null || idempotencyKey !== null) {
      throw new Error("首批 Ripple Suggestions 不能引用旧批次或携带幂等键");
    }
  } else {
    if (refreshOf === null || idempotencyKey === null) {
      throw new Error("换一批必须引用上一批并携带幂等键");
    }
    // 同一 key 的重复/并发请求返回已有行，绝不追加第二批。
    const existingByKey = findRippleSuggestionsArtifactByIdempotencyKey(
      input.projectId,
      input.storyMapArtifact.id,
      idempotencyKey,
    );
    if (existingByKey) return existingByKey;
    const parent = getRippleSuggestionsArtifact(refreshOf);
    if (
      !parent ||
      parent.projectId !== input.projectId ||
      parent.storyMapArtifactId !== input.storyMapArtifact.id ||
      parent.batchIndex !== batchIndex - 1
    ) {
      throw new Error("换一批的父批次不属于当前 Story Map revision");
    }
    if (
      listRippleSuggestionsBatchesForStoryMap(
        input.projectId,
        input.storyMapArtifact.id,
      ).some((artifact) => artifact.batchIndex === batchIndex)
    ) {
      throw new Error(`Ripple Suggestions 批次 ${batchIndex} 已存在，不能覆盖`);
    }
  }

  const artifact = RippleSuggestionsArtifactSchema.parse({
    id:
      idempotencyKey === null
        ? `artifact_ripple_suggestions_${randomUUID()}`
        : stableRippleSuggestionsArtifactId(
            input.storyMapArtifact.id,
            batchIndex,
            idempotencyKey,
          ),
    projectId: input.projectId,
    sourceId: input.storyMapArtifact.sourceId,
    storyMapArtifactId: input.storyMapArtifact.id,
    kind: "ripple_suggestions",
    schemaVersion: 1,
    suggestions: input.suggestions,
    batchIndex,
    refreshOf,
    idempotencyKey,
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
        batchIndex: artifact.batchIndex,
        refreshOf: artifact.refreshOf,
        idempotencyKey: artifact.idempotencyKey,
      }),
      basedOnArtifactId: artifact.basedOnArtifactId,
      generationRunId: artifact.generationRunId,
      createdAt: artifact.createdAt,
    })
    .onConflictDoNothing()
    .run();

  const stored = getRippleSuggestionsArtifact(artifact.id);
  if (
    !stored ||
    stored.storyMapArtifactId !== artifact.storyMapArtifactId ||
    stored.batchIndex !== artifact.batchIndex ||
    stored.refreshOf !== artifact.refreshOf
  ) {
    throw new Error("Ripple Suggestions Artifact 写入失败");
  }
  return stored;
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

/** 按批次索引升序返回全部建议批次（0 为最初自动生成的一组）。 */
export function listRippleSuggestionsBatchesForStoryMap(
  projectId: string,
  storyMapArtifactId: string,
): RippleSuggestionsArtifact[] {
  return listRippleSuggestionsArtifactsForStoryMap(
    projectId,
    storyMapArtifactId,
  ).sort(compareBatchesAscending);
}

/** 面板自动加载只复用最新批次；旧批次仍可通过批次导航读取。 */
export function getLatestRippleSuggestionsArtifact(
  projectId: string,
  storyMapArtifactId: string,
): RippleSuggestionsArtifact | null {
  const batches = listRippleSuggestionsBatchesForStoryMap(
    projectId,
    storyMapArtifactId,
  );
  return batches[batches.length - 1] ?? null;
}

export function findRippleSuggestionsArtifactByIdempotencyKey(
  projectId: string,
  storyMapArtifactId: string,
  idempotencyKey: string,
): RippleSuggestionsArtifact | null {
  return (
    listRippleSuggestionsArtifactsForStoryMap(
      projectId,
      storyMapArtifactId,
    ).find((artifact) => artifact.idempotencyKey === idempotencyKey) ?? null
  );
}

/**
 * 换批 Artifact 的内容身份：(Story Map revision, batchIndex, 幂等键)。
 * 同一键的重复/并发请求得到同一 id；数据库行只插入一次。
 */
export function stableRippleSuggestionsArtifactId(
  storyMapArtifactId: string,
  batchIndex: number,
  idempotencyKey: string,
): string {
  const digest = createHash("sha256")
    .update(
      `ripple_suggestions:${storyMapArtifactId}:${batchIndex}:${idempotencyKey}`,
    )
    .digest("hex");
  return `artifact_ripple_suggestions_${digest.slice(0, 24)}`;
}

function compareBatchesAscending(
  left: RippleSuggestionsArtifact,
  right: RippleSuggestionsArtifact,
): number {
  const batchDifference = left.batchIndex - right.batchIndex;
  if (batchDifference !== 0) return batchDifference;
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
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
    batchIndex?: unknown;
    refreshOf?: unknown;
    idempotencyKey?: unknown;
  };
  return RippleSuggestionsArtifactSchema.parse({
    id: row.id,
    projectId: row.projectId,
    sourceId: row.sourceId,
    storyMapArtifactId: packet.storyMapArtifactId,
    kind: row.kind,
    schemaVersion: row.schemaVersion,
    suggestions: packet.suggestions,
    // 旧行没有这些字段：Schema default 将其解析为批次 0、无父批次、无幂等键。
    ...(packet.batchIndex === undefined
      ? {}
      : { batchIndex: packet.batchIndex }),
    ...(packet.refreshOf === undefined ? {} : { refreshOf: packet.refreshOf }),
    ...(packet.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: packet.idempotencyKey }),
    basedOnArtifactId: row.basedOnArtifactId,
    generationRunId: row.generationRunId,
    createdAt: normalizeSqliteDate(row.createdAt),
  });
}

function normalizeSqliteDate(value: string): string {
  if (value.includes("T")) return value;
  return `${value.replace(" ", "T")}Z`;
}
