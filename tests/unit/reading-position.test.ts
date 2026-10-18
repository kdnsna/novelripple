import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildSceneTree } from "@/domain/continuation/scene-tree";
import {
  assertHeadOnTree,
  headNodeIdFromReadingPosition,
  readingPositionFromHead,
} from "@/domain/continuation/reading-position";
import {
  CharacterChangeSchema,
  WorldlineBookmarkNameSchema,
  WorldlineBookmarkSchema,
  WorldlineSchema,
} from "@/domain/schemas";
import { closeDatabase, getDatabase } from "@/server/db/client";
import { artifacts, worldlines } from "@/server/db/schema";
import {
  createWorldlineBookmark,
  deleteWorldlineBookmark,
  listWorldlineBookmarks,
  setWorldlineHeadNode,
} from "@/server/repositories/reading-position-repository";
import { createProject } from "@/server/repositories/project-repository";

const NOW = "2026-10-18T00:00:00.000Z";
let temporaryDirectory: string;
let projectId: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "novelripple-reading-"));
  process.env.DB_FILE_NAME = path.join(temporaryDirectory, "test.db");
  closeDatabase();
  migrate(getDatabase(), {
    migrationsFolder: path.join(process.cwd(), "drizzle"),
  });
  projectId = createProject({ title: "Reading position" }).id;
});

afterAll(async () => {
  closeDatabase();
  delete process.env.DB_FILE_NAME;
  await rm(temporaryDirectory, { recursive: true });
});

function createCanonicalWorldline(id: string, ownerProjectId = projectId): void {
  const baseArtifactId = `artifact_base_${id}`;
  getDatabase()
    .insert(artifacts)
    .values({
      id: baseArtifactId,
      projectId: ownerProjectId,
      sourceId: null,
      worldlineId: null,
      kind: "story_map",
      schemaVersion: 1,
      version: null,
      dataJson: "{}",
      reviewJson: '{"evidenceConfirmations":[]}',
      basedOnArtifactId: null,
      generationRunId: null,
      createdAt: NOW,
    })
    .run();

  const worldline = WorldlineSchema.parse({
    id,
    projectId: ownerProjectId,
    parentWorldlineId: null,
    baseStoryMapArtifactId: baseArtifactId,
    divergence: null,
    mode: "open",
    anchors: [],
    acceptedImpactPlanId: null,
    idempotencyKey: `canonical:${id}`,
    status: "canonical",
    headNodeId: null,
    createdAt: NOW,
  });
  getDatabase()
    .insert(worldlines)
    .values({
      id: worldline.id,
      projectId: worldline.projectId,
      parentWorldlineId: null,
      baseStoryMapArtifactId: worldline.baseStoryMapArtifactId,
      divergenceJson: null,
      mode: worldline.mode,
      anchorsJson: "[]",
      acceptedImpactPlanId: null,
      headNodeId: worldline.headNodeId,
      idempotencyKey: worldline.idempotencyKey,
      status: worldline.status,
      createdAt: worldline.createdAt,
    })
    .run();
}

describe("reading position helpers", () => {
  it("maps a persisted head to a reading position and back", () => {
    expect(readingPositionFromHead(null)).toEqual({ kind: "default" });
    expect(readingPositionFromHead("scene_1")).toEqual({
      kind: "scene",
      sceneId: "scene_1",
    });
    expect(headNodeIdFromReadingPosition({ kind: "default" })).toBeNull();
    expect(headNodeIdFromReadingPosition({ kind: "root" })).toBeNull();
    expect(
      headNodeIdFromReadingPosition({ kind: "scene", sceneId: "scene_1" }),
    ).toBe("scene_1");
  });

  it("fails closed for a head that is not on the tree", () => {
    const tree = buildSceneTree([]);
    expect(() => assertHeadOnTree(tree, "scene_missing")).toThrow("不存在节点");
    expect(() => assertHeadOnTree(tree, null)).not.toThrow();
  });

  it("defaults missing headNodeId to null and rejects it on canonical worldlines", () => {
    const base = {
      id: "wl_1",
      projectId: "project_1",
      parentWorldlineId: null,
      baseStoryMapArtifactId: "artifact_1",
      divergence: null,
      mode: "open" as const,
      anchors: [],
      acceptedImpactPlanId: null,
      idempotencyKey: "canonical:1",
      status: "canonical" as const,
      createdAt: NOW,
    };
    expect(WorldlineSchema.parse(base).headNodeId).toBeNull();
    expect(() =>
      WorldlineSchema.parse({ ...base, headNodeId: "scene_1" }),
    ).toThrow("原著世界线");
  });

  it("keeps old character changes without status parseable", () => {
    expect(
      CharacterChangeSchema.parse({
        characterId: "char_1",
        summary: "分歧点：保持沉默",
      }),
    ).toEqual({
      characterId: "char_1",
      summary: "分歧点：保持沉默",
    });
    expect(
      CharacterChangeSchema.parse({
        characterId: "char_1",
        summary: "第二幕：被追捕",
        status: "dead",
      }).status,
    ).toBe("dead");
  });

  it("normalizes bookmark names with NFC and trim, bounded to 1–40 chars", () => {
    expect(WorldlineBookmarkNameSchema.parse("  灯塔对峙  ")).toBe("灯塔对峙");
    expect(() => WorldlineBookmarkNameSchema.parse("   ")).toThrow();
    expect(() => WorldlineBookmarkNameSchema.parse("签".repeat(41))).toThrow();
    expect(
      WorldlineBookmarkSchema.parse({
        id: "bookmark_1",
        worldlineId: "wl_1",
        sceneNodeId: null,
        name: "灯塔对峙",
        createdAt: NOW,
      }).sceneNodeId,
    ).toBeNull();
  });
});

describe("reading position repository", () => {
  it("round-trips a null head and rejects an unknown scene", () => {
    createCanonicalWorldline("wl_reading_null");
    expect(
      setWorldlineHeadNode({
        projectId,
        worldlineId: "wl_reading_null",
        headNodeId: null,
      }).headNodeId,
    ).toBeNull();

    expect(() =>
      setWorldlineHeadNode({
        projectId,
        worldlineId: "wl_reading_null",
        headNodeId: "scene_missing",
      }),
    ).toThrow("阅读位置必须指向");
  });

  it("rejects a worldline owned by another project", () => {
    const otherProject = createProject({ title: "Other project" }).id;
    createCanonicalWorldline("wl_other_project", otherProject);
    expect(() =>
      setWorldlineHeadNode({
        projectId,
        worldlineId: "wl_other_project",
        headNodeId: null,
      }),
    ).toThrow("找不到属于当前项目的 Worldline");
  });

  it("creates, lists, rejects duplicates and deletes bookmarks", () => {
    createCanonicalWorldline("wl_bookmarks");
    const bookmark = createWorldlineBookmark({
      projectId,
      worldlineId: "wl_bookmarks",
      sceneNodeId: null,
      name: "  灯塔对峙  ",
    });

    expect(bookmark.name).toBe("灯塔对峙");
    expect(listWorldlineBookmarks("wl_bookmarks")).toEqual([bookmark]);
    expect(() =>
      createWorldlineBookmark({
        projectId,
        worldlineId: "wl_bookmarks",
        sceneNodeId: null,
        name: "灯塔对峙",
      }),
    ).toThrow("同名书签已存在");
    expect(() =>
      createWorldlineBookmark({
        projectId,
        worldlineId: "wl_bookmarks",
        sceneNodeId: "scene_missing",
        name: "另一个书签",
      }),
    ).toThrow("阅读位置必须指向");
    expect(() =>
      deleteWorldlineBookmark({
        projectId,
        worldlineId: "wl_bookmarks",
        bookmarkId: "bookmark_missing",
      }),
    ).toThrow("找不到要删除的 Worldline 书签");

    deleteWorldlineBookmark({
      projectId,
      worldlineId: "wl_bookmarks",
      bookmarkId: bookmark.id,
    });
    expect(listWorldlineBookmarks("wl_bookmarks")).toEqual([]);
  });
});
