import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildSceneTree } from "@/domain/continuation/scene-tree";
import {
  assertHeadOnTree,
  headFromReadingPosition,
  readingPositionFromHead,
} from "@/domain/continuation/reading-position";
import {
  SceneCharacterChangeSchema,
  StoryMapSchema,
  WorldlineBookmarkNameSchema,
  WorldlineBookmarkSchema,
  WorldlineDeltaSchema,
  WorldlineHeadSchema,
  WorldlineSchema,
} from "@/domain/schemas";
import { closeDatabase, getDatabase } from "@/server/db/client";
import { artifacts, sources, worldlines } from "@/server/db/schema";
import {
  createCharacterStatusOverride,
  listCharacterStatusOverrides,
} from "@/server/repositories/character-status-repository";
import { createGenerationRun } from "@/server/repositories/generation-run-repository";
import {
  createWorldlineBookmark,
  deleteWorldlineBookmark,
  ReadingPositionError,
  readingPositionErrorMessage,
  listWorldlineBookmarks,
  setWorldlineHeadNode,
} from "@/server/repositories/reading-position-repository";
import { createProject } from "@/server/repositories/project-repository";
import { getWorldline } from "@/server/repositories/ripple-repository";

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
  getDatabase()
    .insert(sources)
    .values({
      id: "source_test",
      projectId,
      title: "测试来源",
      originalText: "潮标站的灯在风里摇晃。",
      normalizedText: "潮标站的灯在风里摇晃。",
      contentHash: `sha256:${"e".repeat(64)}`,
      sectionsJson: JSON.stringify([
        { id: "section_1", title: "测试", start: 0, end: 11 },
      ]),
      createdAt: NOW,
    })
    .run();
});

afterAll(async () => {
  closeDatabase();
  delete process.env.DB_FILE_NAME;
  await rm(temporaryDirectory, { recursive: true });
});

function insertArtifact(input: {
  id: string;
  projectId: string;
  kind: typeof artifacts.$inferInsert.kind;
  sourceId?: string | null;
  worldlineId?: string | null;
  dataJson?: string;
  schemaVersion?: number;
  version?: number | null;
  basedOnArtifactId?: string | null;
  generationRunId?: string | null;
}): void {
  getDatabase()
    .insert(artifacts)
    .values({
      id: input.id,
      projectId: input.projectId,
      sourceId: input.sourceId ?? null,
      worldlineId: input.worldlineId ?? null,
      kind: input.kind,
      schemaVersion: input.schemaVersion ?? 1,
      version: input.version ?? null,
      dataJson: input.dataJson ?? "{}",
      reviewJson: '{"evidenceConfirmations":[]}',
      basedOnArtifactId: input.basedOnArtifactId ?? null,
      generationRunId: input.generationRunId ?? null,
      createdAt: NOW,
    })
    .run();
}

function createCanonicalWorldline(id: string, ownerProjectId = projectId): void {
  const baseArtifactId = `artifact_base_${id}`;
  insertArtifact({
    id: baseArtifactId,
    projectId: ownerProjectId,
    kind: "story_map",
  });

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
    head: null,
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
      headKind: null,
      headNodeId: null,
      idempotencyKey: worldline.idempotencyKey,
      status: worldline.status,
      createdAt: worldline.createdAt,
    })
    .run();
}

function createActiveWorldline(id: string): {
  impactArtifactId: string;
  baseArtifactId: string;
} {
  createCanonicalWorldline(`wl_parent_${id}`);
  const baseArtifactId = `artifact_base_wl_parent_${id}`;
  const impactArtifactId = `artifact_impact_${id}`;
  insertArtifact({
    id: impactArtifactId,
    projectId,
    kind: "impact_plan",
  });
  getDatabase()
    .insert(worldlines)
    .values({
      id,
      projectId,
      parentWorldlineId: `wl_parent_${id}`,
      baseStoryMapArtifactId: baseArtifactId,
      divergenceJson: JSON.stringify({
        id: "divergence_test",
        eventId: "event_1",
        type: "prevent",
        instruction: "测试分歧",
      }),
      mode: "open",
      anchorsJson: "[]",
      acceptedImpactPlanId: impactArtifactId,
      headKind: null,
      headNodeId: null,
      idempotencyKey: `active:${id}`,
      status: "active",
      createdAt: NOW,
    })
    .run();
  return { impactArtifactId, baseArtifactId };
}

function createDirectionsArtifact(worldlineId: string): string {
  const impactArtifactId = `artifact_impact_${worldlineId}`;
  const run = createGenerationRun({
    projectId,
    worldlineId,
    kind: "continuation_directions",
    provider: "mock",
    model: "mock",
    promptVersion: "continuation-directions.v4",
    inputHash: "b".repeat(64),
  });
  const id = `artifact_directions_${worldlineId}`;
  const continuation = {
    schemaVersion: 1,
    id,
    worldlineId,
    acceptedImpactPlanId: impactArtifactId,
    directions: [0, 1, 2].map((index) => ({
      id: `direction_${index}`,
      title: `方向 ${index}`,
      premise: "测试方向",
      affectedCharacterIds: ["character_1"],
      expectedConsequence: "测试后果",
    })),
    createdAt: NOW,
  };
  insertArtifact({
    id,
    projectId,
    sourceId: "source_test",
    worldlineId,
    kind: "continuation",
    dataJson: JSON.stringify({
      artifactType: "directions",
      continuation,
    }),
    basedOnArtifactId: impactArtifactId,
    generationRunId: run.id,
  });
  return id;
}

function createSceneArtifact(worldlineId: string, id: string): string {
  const directionsArtifactId = createDirectionsArtifact(worldlineId);
  const run = createGenerationRun({
    projectId,
    worldlineId,
    kind: "continuation_scene",
    provider: "mock",
    model: "mock",
    promptVersion: "continuation-scene.v7",
    inputHash: "c".repeat(64),
  });
  const continuation = {
    schemaVersion: 1,
    sequence: 1,
    id,
    worldlineId,
    acceptedImpactPlanId: `artifact_impact_${worldlineId}`,
    directionsArtifactId,
    selectedDirectionId: "direction_0",
    title: "测试场景",
    prose: "潮标站的灯在风里摇晃。".repeat(130),
    statePatch: {
      factsAdded: [],
      factsRemoved: [],
      characterChanges: [],
      threadsOpened: [],
      threadsClosed: [],
    },
    contentKind: "generated",
    createdAt: NOW,
  };
  insertArtifact({
    id,
    projectId,
    sourceId: "source_test",
    worldlineId,
    kind: "continuation",
    dataJson: JSON.stringify({ artifactType: "scene", continuation }),
    basedOnArtifactId: directionsArtifactId,
    generationRunId: run.id,
  });
  return directionsArtifactId;
}

describe("reading position helpers", () => {
  it("maps a persisted head to a reading position and back", () => {
    expect(readingPositionFromHead(null)).toEqual({ kind: "default" });
    expect(readingPositionFromHead({ kind: "root" })).toEqual({
      kind: "root",
    });
    expect(
      readingPositionFromHead({ kind: "scene", sceneId: "scene_1" }),
    ).toEqual({ kind: "scene", sceneId: "scene_1" });
    expect(headFromReadingPosition({ kind: "default" })).toBeNull();
    expect(headFromReadingPosition({ kind: "root" })).toEqual({
      kind: "root",
    });
    expect(
      headFromReadingPosition({ kind: "scene", sceneId: "scene_1" }),
    ).toEqual({ kind: "scene", sceneId: "scene_1" });
  });

  it("fails closed for a head that is not on the tree", () => {
    const tree = buildSceneTree([]);
    expect(() =>
      assertHeadOnTree(tree, { kind: "scene", sceneId: "scene_missing" }),
    ).toThrow("不存在节点");
    expect(() => assertHeadOnTree(tree, null)).not.toThrow();
    expect(() => assertHeadOnTree(tree, { kind: "root" })).not.toThrow();
  });

  it("defaults missing head to null and rejects it on canonical worldlines", () => {
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
    expect(WorldlineSchema.parse(base).head).toBeNull();
    expect(() =>
      WorldlineSchema.parse({ ...base, head: { kind: "root" } }),
    ).toThrow("原著世界线");
  });

  it("keeps Impact Plan changes status-free and scene changes status-aware", () => {
    const sceneChange = SceneCharacterChangeSchema.parse({
      characterId: "char_1",
      summary: "第二幕：被追捕",
      status: "dead",
    });
    expect(sceneChange.status).toBe("dead");
    expect(
      SceneCharacterChangeSchema.parse({
        characterId: "char_1",
        summary: "第三幕：没有新消息",
        status: null,
      }).status,
    ).toBeNull();
    expect(
      WorldlineDeltaSchema.parse({
        factsAdded: [],
        factsRemoved: [],
        characterChanges: [
          {
            characterId: "char_1",
            summary: "分歧点：保持沉默",
            status: "alive",
          },
        ],
        threadsOpened: [],
        threadsClosed: [],
      }).characterChanges[0]?.status,
    ).toBe("alive");
  });

  it("normalizes bookmark names and rejects invisible characters", () => {
    expect(WorldlineBookmarkNameSchema.parse("  灯塔对峙  ")).toBe("灯塔对峙");
    expect(() => WorldlineBookmarkNameSchema.parse("   ")).toThrow();
    expect(() => WorldlineBookmarkNameSchema.parse("签".repeat(41))).toThrow();
    for (const forbidden of ["灯\u200B塔", "灯\u202E塔", "灯\n塔"]) {
      expect(() => WorldlineBookmarkNameSchema.parse(forbidden)).toThrow(
        "书签名称包含不允许的字符",
      );
    }
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
  it("persists root and scene heads and restores them", () => {
    createActiveWorldline("wl_reading_head");
    const sceneId = "scene_reading_head";
    createSceneArtifact("wl_reading_head", sceneId);

    expect(
      setWorldlineHeadNode({
        projectId,
        worldlineId: "wl_reading_head",
        head: { kind: "root" },
      }).head,
    ).toEqual({ kind: "root" });
    expect(getWorldline("wl_reading_head")?.head).toEqual({ kind: "root" });

    expect(
      setWorldlineHeadNode({
        projectId,
        worldlineId: "wl_reading_head",
        head: { kind: "scene", sceneId },
      }).head,
    ).toEqual({ kind: "scene", sceneId });
    expect(getWorldline("wl_reading_head")?.head).toEqual({
      kind: "scene",
      sceneId,
    });
  });

  it("rejects scene heads that are empty after trim", () => {
    createActiveWorldline("wl_reading_whitespace");
    const whitespaceSceneIds = [
      "\u3000",
      "\u00A0",
      "\u2003",
      " \t\u3000\u00A0\u2003\n",
      // 零宽字符不能被当作非空场景 id。
      "\u200B",
      "\u200C\u200D",
      "\u2060",
      "\u200B\u3000\uFEFF",
    ];

    for (const sceneId of whitespaceSceneIds) {
      expect(() =>
        WorldlineHeadSchema.parse({ kind: "scene", sceneId }),
      ).toThrow();
      try {
        setWorldlineHeadNode({
          projectId,
          worldlineId: "wl_reading_whitespace",
          head: { kind: "scene", sceneId },
        });
        throw new Error("expected whitespace-only scene head to be rejected");
      } catch (error) {
        expect(error).toBeInstanceOf(ReadingPositionError);
        expect((error as ReadingPositionError).code).toBe("invalid_head");
      }
    }

    expect(
      WorldlineHeadSchema.parse({ kind: "scene", sceneId: "scene_valid" }),
    ).toEqual({ kind: "scene", sceneId: "scene_valid" });
  });

  it("rejects unknown scenes and heads on canonical worldlines", () => {
    createCanonicalWorldline("wl_reading_null");
    expect(() =>
      setWorldlineHeadNode({
        projectId,
        worldlineId: "wl_reading_null",
        head: { kind: "root" },
      }),
    ).toThrow("原著世界线没有可阅读的场景");

    createActiveWorldline("wl_reading_scene_missing");
    expect(() =>
      setWorldlineHeadNode({
        projectId,
        worldlineId: "wl_reading_scene_missing",
        head: { kind: "scene", sceneId: "scene_missing" },
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
        head: null,
      }),
    ).toThrow("找不到属于当前项目的 Worldline");
  });

  it("creates, lists, rejects duplicates and deletes bookmarks", () => {
    createActiveWorldline("wl_bookmarks");
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
        sceneNodeId: null,
        name: "灯\u200B塔",
      }),
    ).toThrow("书签名称包含不允许的字符");
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

  it("rejects a directions artifact or another worldline's scene as a bookmark target", () => {
    createActiveWorldline("wl_target_a");
    createActiveWorldline("wl_target_b");
    const otherWorldlineScene = "scene_on_wl_target_a";
    const directionsArtifactId = createSceneArtifact(
      "wl_target_a",
      otherWorldlineScene,
    );

    for (const sceneNodeId of [directionsArtifactId, otherWorldlineScene]) {
      expect(() =>
        createWorldlineBookmark({
          projectId,
          worldlineId: "wl_target_b",
          sceneNodeId,
          name: `目标 ${sceneNodeId}`,
        }),
      ).toThrow("阅读位置必须指向");
    }
  });

  it("caps bookmarks per worldline at 50", () => {
    createActiveWorldline("wl_bookmark_limit");
    for (let index = 0; index < 50; index += 1) {
      createWorldlineBookmark({
        projectId,
        worldlineId: "wl_bookmark_limit",
        sceneNodeId: null,
        name: `签 ${index}`,
      });
    }
    expect(() =>
      createWorldlineBookmark({
        projectId,
        worldlineId: "wl_bookmark_limit",
        sceneNodeId: null,
        name: "签 50",
      }),
    ).toThrow("每条世界线最多 50 个书签");
    expect(listWorldlineBookmarks("wl_bookmark_limit")).toHaveLength(50);
  });

  it("maps typed errors to messages and rethrows generic failures", () => {
    expect(
      readingPositionErrorMessage(
        new ReadingPositionError("duplicate_name", "同名书签已存在，请换一个名称。"),
        "书签保存失败，请重试。",
      ),
    ).toBe("同名书签已存在，请换一个名称。");
    expect(
      readingPositionErrorMessage(
        new Error("database is locked"),
        "书签保存失败，请重试。",
      ),
    ).toBe("书签保存失败，请重试。");
    expect(
      readingPositionErrorMessage(
        new ReadingPositionError(
          "bookmark_limit",
          "每条世界线最多 50 个书签",
        ),
        "书签保存失败，请重试。",
      ),
    ).toBe("每条世界线最多 50 个书签");
  });
});


describe("character status overrides", () => {
  function statusStoryMap(sourceId: string) {
    const reference = {
      sourceId,
      sectionId: "section_1",
      start: 0,
      end: 4,
      excerptHash: `sha256:${"d".repeat(64)}`,
    };
    return StoryMapSchema.parse({
      schemaVersion: 1,
      id: `story_map_status_${sourceId}`,
      sourceId,
      version: 1,
      status: "confirmed",
      title: "状态测试",
      logline: "自建短句",
      characters: [
        {
          id: "character_1",
          name: "沈砚",
          aliases: [],
          role: "protagonist",
          initialState: "看守灯塔",
        },
      ],
      events: [
        {
          id: "event_1",
          title: "守塔",
          summary: "沈砚留在灯塔",
          sequence: 1,
          participants: ["character_1"],
          stateChanges: ["灯塔仍亮"],
          evidenceKind: "fact",
          evidence: [reference],
        },
      ],
      edges: [],
      endingCandidates: [
        {
          id: "ending_1",
          targetEventId: "event_1",
          requirement: "灯塔仍亮",
          evidence: [reference],
        },
      ],
    });
  }

  function prepareOverrideWorldline(worldlineId: string): void {
    createActiveWorldline(worldlineId);
    const sourceId = `source_${worldlineId}`;
    getDatabase()
      .insert(sources)
      .values({
        id: sourceId,
        projectId,
        title: "状态来源",
        originalText: "沈砚留在灯塔。",
        normalizedText: "沈砚留在灯塔。",
        contentHash: `sha256:${"f".repeat(63)}${worldlineId.length % 10}`,
        sectionsJson: JSON.stringify([
          { id: "section_1", title: "测试", start: 0, end: 7 },
        ]),
        createdAt: NOW,
      })
      .run();
    const baseArtifactId = `artifact_status_base_${worldlineId}`;
    insertArtifact({
      id: baseArtifactId,
      projectId,
      kind: "story_map",
      sourceId,
      dataJson: JSON.stringify(statusStoryMap(sourceId)),
      schemaVersion: 2,
      version: 1,
    });
    getDatabase()
      .update(worldlines)
      .set({ baseStoryMapArtifactId: baseArtifactId })
      .where(eq(worldlines.id, worldlineId))
      .run();
  }

  it("appends idempotent overrides anchored at divergence or a scene", () => {
    prepareOverrideWorldline("wl_overrides");
    const sceneId = "scene_override";
    createSceneArtifact("wl_overrides", sceneId);

    const atDivergence = createCharacterStatusOverride({
      projectId,
      worldlineId: "wl_overrides",
      anchorSceneId: null,
      characterId: "character_1",
      status: "dead",
      idempotencyKey: "override-divergence",
    });
    expect(atDivergence.status).toBe("dead");

    const repeated = createCharacterStatusOverride({
      projectId,
      worldlineId: "wl_overrides",
      anchorSceneId: null,
      characterId: "character_1",
      status: "dead",
      idempotencyKey: "override-divergence",
    });
    expect(repeated.id).toBe(atDivergence.id);

    const atScene = createCharacterStatusOverride({
      projectId,
      worldlineId: "wl_overrides",
      anchorSceneId: sceneId,
      characterId: "character_1",
      status: "alive",
      idempotencyKey: "override-scene",
    });
    expect(listCharacterStatusOverrides("wl_overrides")).toEqual([
      atDivergence,
      atScene,
    ]);
  });

  it("rejects unknown characters, foreign scenes and foreign worldlines", () => {
    prepareOverrideWorldline("wl_overrides_invalid");
    createActiveWorldline("wl_overrides_other");
    const foreignScene = "scene_override_other";
    createSceneArtifact("wl_overrides_other", foreignScene);

    expect(() =>
      createCharacterStatusOverride({
        projectId,
        worldlineId: "wl_overrides_invalid",
        anchorSceneId: null,
        characterId: "character_missing",
        status: "dead",
        idempotencyKey: "bad-character",
      }),
    ).toThrow("人物不在当前 Worldline 的 Story Map 中");
    expect(() =>
      createCharacterStatusOverride({
        projectId,
        worldlineId: "wl_overrides_invalid",
        anchorSceneId: foreignScene,
        characterId: "character_1",
        status: "dead",
        idempotencyKey: "bad-scene",
      }),
    ).toThrow("锚点必须是当前 Worldline 上已生成的场景");
    expect(() =>
      createCharacterStatusOverride({
        projectId: "project_missing",
        worldlineId: "wl_overrides_invalid",
        anchorSceneId: null,
        characterId: "character_1",
        status: "dead",
        idempotencyKey: "bad-worldline",
      }),
    ).toThrow("找不到属于当前项目的 Worldline");
  });
});
