import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";

import {
  WorldlineBookmarkNameSchema,
  WorldlineBookmarkSchema,
  type Worldline,
  type WorldlineBookmark,
} from "@/domain/schemas";
import { getDatabase } from "@/server/db/client";
import { worldlineBookmarks, worldlines } from "@/server/db/schema";
import { getContinuationArtifact } from "@/server/repositories/continuation-repository";
import { getWorldline } from "@/server/repositories/ripple-repository";

/** 阅读游标校验失败：message 已面向读者，Action 只透传该类型。 */
export class ReadingPositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadingPositionError";
  }
}

export function isReadingPositionError(
  error: unknown,
): error is ReadingPositionError {
  return error instanceof ReadingPositionError;
}

/**
 * 阅读游标（head + 命名书签）的唯一写入口。
 *
 * headNodeId 与书签都是阅读位置，不是叙事 Artifact；只有它们是可 UPDATE
 * 的指针列。所有非空场景引用都在写入前校验属于同一项目/世界线，失败即
 * fail closed，不写半条记录。见 docs/decisions/0012。
 */
export function setWorldlineHeadNode(input: {
  projectId: string;
  worldlineId: string;
  headNodeId: string | null;
}): Worldline {
  const worldline = requireWorldline(input.worldlineId, input.projectId);
  assertSceneNodeOnWorldline({
    projectId: input.projectId,
    worldlineId: worldline.id,
    sceneNodeId: input.headNodeId,
  });

  getDatabase()
    .update(worldlines)
    .set({ headNodeId: input.headNodeId })
    .where(
      and(
        eq(worldlines.id, input.worldlineId),
        eq(worldlines.projectId, input.projectId),
      ),
    )
    .run();

  return requireWorldline(input.worldlineId, input.projectId);
}

export function listWorldlineBookmarks(
  worldlineId: string,
): WorldlineBookmark[] {
  return getDatabase()
    .select()
    .from(worldlineBookmarks)
    .where(eq(worldlineBookmarks.worldlineId, worldlineId))
    .orderBy(asc(worldlineBookmarks.createdAt), asc(worldlineBookmarks.id))
    .all()
    .map(parseBookmark);
}

export function createWorldlineBookmark(input: {
  projectId: string;
  worldlineId: string;
  sceneNodeId: string | null;
  name: string;
}): WorldlineBookmark {
  const worldline = requireWorldline(input.worldlineId, input.projectId);
  assertSceneNodeOnWorldline({
    projectId: input.projectId,
    worldlineId: worldline.id,
    sceneNodeId: input.sceneNodeId,
  });

  const parsedName = WorldlineBookmarkNameSchema.safeParse(input.name);
  if (!parsedName.success) {
    throw new ReadingPositionError("书签名称需为 1–40 个字符（NFC，去除首尾空白）。");
  }
  const name = parsedName.data;
  const existing = getDatabase()
    .select({ id: worldlineBookmarks.id })
    .from(worldlineBookmarks)
    .where(
      and(
        eq(worldlineBookmarks.worldlineId, worldline.id),
        eq(worldlineBookmarks.name, name),
      ),
    )
    .get();
  if (existing) throw new ReadingPositionError("同名书签已存在，请换一个名称。");

  const bookmark = WorldlineBookmarkSchema.parse({
    id: `worldline_bookmark_${randomUUID()}`,
    worldlineId: worldline.id,
    sceneNodeId: input.sceneNodeId,
    name,
    createdAt: new Date().toISOString(),
  });

  try {
    getDatabase()
      .insert(worldlineBookmarks)
      .values({
        id: bookmark.id,
        worldlineId: bookmark.worldlineId,
        sceneNodeId: bookmark.sceneNodeId,
        name: bookmark.name,
        createdAt: bookmark.createdAt,
      })
      .run();
  } catch {
    // 并发写入由唯一索引兜底；对外仍是同一个可执行提示。
    throw new ReadingPositionError("同名书签已存在，请换一个名称。");
  }

  return bookmark;
}

export function deleteWorldlineBookmark(input: {
  projectId: string;
  worldlineId: string;
  bookmarkId: string;
}): void {
  const worldline = requireWorldline(input.worldlineId, input.projectId);
  const existing = getDatabase()
    .select({ id: worldlineBookmarks.id })
    .from(worldlineBookmarks)
    .where(
      and(
        eq(worldlineBookmarks.id, input.bookmarkId),
        eq(worldlineBookmarks.worldlineId, worldline.id),
      ),
    )
    .get();
  if (!existing) throw new ReadingPositionError("找不到要删除的 Worldline 书签。");

  getDatabase()
    .delete(worldlineBookmarks)
    .where(
      and(
        eq(worldlineBookmarks.id, input.bookmarkId),
        eq(worldlineBookmarks.worldlineId, worldline.id),
      ),
    )
    .run();
}

function requireWorldline(worldlineId: string, projectId: string): Worldline {
  const worldline = getWorldline(worldlineId);
  if (!worldline || worldline.projectId !== projectId) {
    throw new ReadingPositionError("找不到属于当前项目的 Worldline。");
  }
  return worldline;
}

function assertSceneNodeOnWorldline(input: {
  projectId: string;
  worldlineId: string;
  sceneNodeId: string | null;
}): void {
  if (input.sceneNodeId === null) return;
  const artifact = getContinuationArtifact(input.sceneNodeId);
  if (
    !artifact ||
    artifact.artifactType !== "scene" ||
    artifact.projectId !== input.projectId ||
    artifact.worldlineId !== input.worldlineId
  ) {
    throw new ReadingPositionError("阅读位置必须指向当前 Worldline 上已生成的场景。");
  }
}

function parseBookmark(
  row: typeof worldlineBookmarks.$inferSelect,
): WorldlineBookmark {
  return WorldlineBookmarkSchema.parse({
    id: row.id,
    worldlineId: row.worldlineId,
    sceneNodeId: row.sceneNodeId ?? null,
    name: row.name,
    createdAt: normalizeSqliteDate(row.createdAt),
  });
}

function normalizeSqliteDate(value: string): string {
  if (value.includes("T")) return value;
  return `${value.replace(" ", "T")}Z`;
}
