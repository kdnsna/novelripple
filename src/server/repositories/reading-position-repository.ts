import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";

import {
  WORLDLINE_BOOKMARK_MAX_PER_WORLDLINE,
  WorldlineBookmarkNameSchema,
  WorldlineBookmarkSchema,
  isBlankSceneId,
  type Worldline,
  type WorldlineBookmark,
  type WorldlineHead,
} from "@/domain/schemas";
import { getDatabase } from "@/server/db/client";
import { worldlineBookmarks, worldlines } from "@/server/db/schema";
import { getContinuationArtifact } from "@/server/repositories/continuation-repository";
import { getWorldline } from "@/server/repositories/ripple-repository";

/** 阅读游标校验失败：message 已面向读者，Action 只透传该类型。 */
export type ReadingPositionErrorCode =
  | "worldline_not_found"
  | "invalid_head"
  | "scene_not_found"
  | "invalid_name"
  | "duplicate_name"
  | "bookmark_limit"
  | "bookmark_not_found";

export class ReadingPositionError extends Error {
  readonly code: ReadingPositionErrorCode;

  constructor(code: ReadingPositionErrorCode, message: string) {
    super(message);
    this.name = "ReadingPositionError";
    this.code = code;
  }
}

export function isReadingPositionError(
  error: unknown,
): error is ReadingPositionError {
  return error instanceof ReadingPositionError;
}

/**
 * 只把仓储层类型化错误透传给读者；其它异常（数据库故障等）回退到
 * 调用方给定的通用文案，避免泄漏内部细节。
 */
export function readingPositionErrorMessage(
  error: unknown,
  fallback: string,
): string {
  return isReadingPositionError(error) ? error.message : fallback;
}

/**
 * 阅读游标（head + 命名书签）的唯一写入口。
 *
 * head 与书签都是阅读位置，不是叙事 Artifact；只有它们是可 UPDATE/
 * DELETE 的指针数据。所有非空场景引用都在写入前校验属于同一项目/
 * 世界线，失败即 fail closed，不写半条记录。见 docs/decisions/0012。
 */
export function setWorldlineHeadNode(input: {
  projectId: string;
  worldlineId: string;
  head: WorldlineHead | null;
}): Worldline {
  const worldline = requireWorldline(input.worldlineId, input.projectId);
  if (worldline.status === "canonical" && input.head !== null) {
    throw new ReadingPositionError(
      "invalid_head",
      "原著世界线没有可阅读的场景，阅读位置只能为空。",
    );
  }
  // DB CHECK 的 trim 集合已覆盖常见 Unicode 空白与零宽字符；这里复用
  // 同一个共享 helper 对齐仓储边界，让纯空白场景 id 在写库前就以
  // typed error fail closed。
  if (
    input.head?.kind === "scene" &&
    isBlankSceneId(input.head.sceneId)
  ) {
    throw new ReadingPositionError(
      "invalid_head",
      "阅读位置必须指向当前 Worldline 上已生成的场景。",
    );
  }
  assertSceneNodeOnWorldline({
    projectId: input.projectId,
    worldlineId: worldline.id,
    sceneNodeId: input.head?.kind === "scene" ? input.head.sceneId : null,
  });

  getDatabase()
    .update(worldlines)
    .set({
      headKind: input.head?.kind ?? null,
      headNodeId: input.head?.kind === "scene" ? input.head.sceneId : null,
    })
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
    const message = parsedName.error.issues[0]?.message ?? "";
    throw new ReadingPositionError(
      "invalid_name",
      message.includes("书签名称包含不允许的字符")
        ? message
        : "书签名称需为 1–40 个字符（NFC，去除首尾空白）。",
    );
  }
  const name = parsedName.data;
  const bookmark = WorldlineBookmarkSchema.parse({
    id: `worldline_bookmark_${randomUUID()}`,
    worldlineId: worldline.id,
    sceneNodeId: input.sceneNodeId,
    name,
    createdAt: new Date().toISOString(),
  });

  // 名称重复、条数上限与插入在同一个事务里检查，避免并发留下半条记录。
  getDatabase().transaction((tx) => {
    const existing = tx
      .select({ id: worldlineBookmarks.id })
      .from(worldlineBookmarks)
      .where(
        and(
          eq(worldlineBookmarks.worldlineId, worldline.id),
          eq(worldlineBookmarks.name, name),
        ),
      )
      .get();
    if (existing) {
      throw new ReadingPositionError(
        "duplicate_name",
        "同名书签已存在，请换一个名称。",
      );
    }

    const count = tx
      .select({ id: worldlineBookmarks.id })
      .from(worldlineBookmarks)
      .where(eq(worldlineBookmarks.worldlineId, worldline.id))
      .all().length;
    if (count >= WORLDLINE_BOOKMARK_MAX_PER_WORLDLINE) {
      throw new ReadingPositionError(
        "bookmark_limit",
        `每条世界线最多 ${WORLDLINE_BOOKMARK_MAX_PER_WORLDLINE} 个书签`,
      );
    }

    try {
      tx.insert(worldlineBookmarks)
        .values({
          id: bookmark.id,
          worldlineId: bookmark.worldlineId,
          sceneNodeId: bookmark.sceneNodeId,
          name: bookmark.name,
          createdAt: bookmark.createdAt,
        })
        .run();
    } catch (error) {
      // 只有 (worldline_id, name) 的唯一约束映射为同名书签；其它数据库
      // 异常保持原样，由 Action 统一回退到通用失败文案。
      if (isBookmarkNameUniqueViolation(error)) {
        throw new ReadingPositionError(
          "duplicate_name",
          "同名书签已存在，请换一个名称。",
        );
      }
      throw error;
    }
  });

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
  if (!existing) {
    throw new ReadingPositionError(
      "bookmark_not_found",
      "找不到要删除的 Worldline 书签。",
    );
  }

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
    throw new ReadingPositionError(
      "worldline_not_found",
      "找不到属于当前项目的 Worldline。",
    );
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
    throw new ReadingPositionError(
      "scene_not_found",
      "阅读位置必须指向当前 Worldline 上已生成的场景。",
    );
  }
}

function isBookmarkNameUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  if (code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  return (
    error.message.includes("UNIQUE constraint failed") &&
    error.message.includes("worldline_bookmarks.worldline_id") &&
    error.message.includes("worldline_bookmarks.name")
  );
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
