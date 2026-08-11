import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SourceReference, StoryMapContent } from "@/domain/schemas";
import { closeDatabase, getDatabase } from "@/server/db/client";
import { loadRippleFixture } from "@/server/fixtures/load-ripple-fixture";
import {
  createGenerationRun,
  succeedGenerationRun,
} from "@/server/repositories/generation-run-repository";
import {
  createProject,
  importProjectSource,
} from "@/server/repositories/project-repository";
import {
  confirmStoryMapArtifact,
  createStoryMapArtifact,
  createStoryMapRevision,
  getStoryMapArtifact,
  listStoryMapArtifactsForSource,
} from "@/server/repositories/story-map-artifact-repository";

let temporaryDirectory: string;
let databasePath: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "novelripple-story-map-artifact-"),
  );
  databasePath = path.join(temporaryDirectory, "test.db");
  process.env.DB_FILE_NAME = databasePath;
  closeDatabase();
  migrate(getDatabase(), {
    migrationsFolder: path.join(process.cwd(), "drizzle"),
  });
});

afterAll(async () => {
  closeDatabase();
  delete process.env.DB_FILE_NAME;
  await rm(temporaryDirectory, { recursive: true });
});

function createSucceededReconcilerRun(projectId: string) {
  const run = createGenerationRun({
    projectId,
    worldlineId: null,
    kind: "story_map_reconcile",
    provider: "mock",
    model: "mock-model",
    promptVersion: "story-map-reconcile.v1",
    inputHash: "a".repeat(64),
  });
  return succeedGenerationRun({
    id: run.id,
    rawOutput: '{"attempts":[]}',
  });
}

async function createFixtureContext() {
  const fixture = await loadRippleFixture();
  const project = createProject({ title: "Story Map Artifact" });
  const imported = importProjectSource({
    projectId: project.id,
    fileName: "ripple-001.md",
    bytes: new TextEncoder().encode(fixture.source.originalText),
  });
  const remapReference = (reference: SourceReference): SourceReference => ({
    ...reference,
    sourceId: imported.source.id,
  });
  const content: StoryMapContent = {
    title: fixture.storyMap.title,
    logline: fixture.storyMap.logline,
    characters: fixture.storyMap.characters,
    events: fixture.storyMap.events.map((event) => ({
      ...event,
      evidence: event.evidence.map(remapReference),
    })),
    edges: fixture.storyMap.edges.map((edge) => ({
      ...edge,
      evidence: edge.evidence.map(remapReference),
    })),
    endingCandidates: fixture.storyMap.endingCandidates.map((ending) => ({
      ...ending,
      evidence: ending.evidence.map(remapReference),
    })),
  };

  return { project, source: imported.source, content };
}

async function createInitialArtifact() {
  const context = await createFixtureContext();
  const artifact = createStoryMapArtifact({
    projectId: context.project.id,
    sourceId: context.source.id,
    content: context.content,
    generationRunId: createSucceededReconcilerRun(context.project.id).id,
  });
  return { ...context, artifact };
}

describe("Story Map Artifact persistence", () => {
  it("migrates explicit Story Map Source/version/review columns and uniqueness", () => {
    const sqlite = new Database(databasePath, { readonly: true });
    const columns = sqlite.prepare("PRAGMA table_info(artifacts)").all() as Array<{
      name: string;
    }>;
    const indexes = sqlite.prepare("PRAGMA index_list(artifacts)").all() as Array<{
      name: string;
      unique: 0 | 1;
    }>;
    sqlite.close();

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["source_id", "version", "review_json"]),
    );
    expect(indexes).toContainEqual(
      expect.objectContaining({
        name: "artifacts_story_map_source_version_unique",
        unique: 1,
      }),
    );
  });

  it("stores a draft Story Map explicitly bound to Source and Generation Run", async () => {
    const { project, source, content } = await createFixtureContext();
    const run = createSucceededReconcilerRun(project.id);

    const artifact = createStoryMapArtifact({
      projectId: project.id,
      sourceId: source.id,
      content,
      generationRunId: run.id,
    });

    expect(artifact).toMatchObject({
      projectId: project.id,
      sourceId: source.id,
      kind: "story_map",
      schemaVersion: 2,
      version: 1,
      basedOnArtifactId: null,
      generationRunId: run.id,
      review: { evidenceConfirmations: [] },
      storyMap: {
        sourceId: source.id,
        version: 1,
        status: "draft",
      },
    });
    expect(getStoryMapArtifact(artifact.id)).toEqual(artifact);

    const sqlite = new Database(databasePath, { readonly: true });
    const row = sqlite
      .prepare("SELECT source_id, version FROM artifacts WHERE id = ?")
      .get(artifact.id) as { source_id: string; version: number };
    sqlite.close();
    expect(row).toEqual({ source_id: source.id, version: 1 });
  });

  it("creates a new linked version on rerun without changing the old Artifact", async () => {
    const { project, source, content } = await createFixtureContext();
    const first = createStoryMapArtifact({
      projectId: project.id,
      sourceId: source.id,
      content,
      generationRunId: createSucceededReconcilerRun(project.id).id,
    });
    const second = createStoryMapArtifact({
      projectId: project.id,
      sourceId: source.id,
      content: { ...content, logline: `${content.logline}（第二版）` },
      generationRunId: createSucceededReconcilerRun(project.id).id,
    });

    expect(second).toMatchObject({
      kind: "story_map_revision",
      version: 2,
      basedOnArtifactId: first.id,
      storyMap: { version: 2, status: "draft" },
    });
    expect(second.id).not.toBe(first.id);
    expect(second.storyMap.id).not.toBe(first.storyMap.id);
    expect(getStoryMapArtifact(first.id)).toEqual(first);
    expect(listStoryMapArtifactsForSource(project.id, source.id)).toEqual([
      second,
      first,
    ]);
  });

  it("rejects an invalid Story Map and leaves no Artifact", async () => {
    const { project, source, content } = await createFixtureContext();
    const invalidContent = structuredClone(content);
    invalidContent.edges[0].to = "event_missing";

    expect(() =>
      createStoryMapArtifact({
        projectId: project.id,
        sourceId: source.id,
        content: invalidContent,
        generationRunId: createSucceededReconcilerRun(project.id).id,
      }),
    ).toThrow("Story Map 校验失败");
    expect(listStoryMapArtifactsForSource(project.id, source.id)).toEqual([]);
  });

  it("rejects a Generation Run that is not the successful Reconciler run", async () => {
    const { project, source, content } = await createFixtureContext();
    const pendingRun = createGenerationRun({
      projectId: project.id,
      worldlineId: null,
      kind: "story_map_extract",
      provider: "mock",
      model: "mock-model",
      promptVersion: "story-map.v1",
      inputHash: "b".repeat(64),
    });

    expect(() =>
      createStoryMapArtifact({
        projectId: project.id,
        sourceId: source.id,
        content,
        generationRunId: pendingRun.id,
      }),
    ).toThrow("Artifact 必须绑定成功的 Story Map Reconciler Run");
    expect(listStoryMapArtifactsForSource(project.id, source.id)).toEqual([]);
  });
});

describe("immutable Story Map review revisions", () => {
  it("creates a linked draft revision for an allowed event correction", async () => {
    const { project, source, artifact } = await createInitialArtifact();
    const original = structuredClone(artifact);
    const event = artifact.storyMap.events[0];

    const revision = createStoryMapRevision({
      projectId: project.id,
      artifactId: artifact.id,
      change: {
        type: "update_event",
        eventId: event.id,
        title: `${event.title}（人工校正）`,
        summary: `${event.summary} 已由读者核对。`,
        participants: event.participants,
      },
    });

    expect(revision).toMatchObject({
      projectId: project.id,
      sourceId: source.id,
      kind: "story_map_revision",
      schemaVersion: 2,
      version: 2,
      basedOnArtifactId: artifact.id,
      generationRunId: null,
      storyMap: {
        version: 2,
        status: "draft",
      },
    });
    expect(revision.storyMap.events[0]).toMatchObject({
      title: `${event.title}（人工校正）`,
      summary: `${event.summary} 已由读者核对。`,
    });
    expect(getStoryMapArtifact(artifact.id)).toEqual(original);
  });

  it("deletes only the requested erroneous edge in a new revision", async () => {
    const { project, artifact } = await createInitialArtifact();
    const removedEdge = artifact.storyMap.edges[0];

    const revision = createStoryMapRevision({
      projectId: project.id,
      artifactId: artifact.id,
      change: { type: "delete_edge", edgeId: removedEdge.id },
    });

    expect(revision.storyMap.edges).toHaveLength(
      artifact.storyMap.edges.length - 1,
    );
    expect(revision.storyMap.edges).not.toContainEqual(removedEdge);
    expect(getStoryMapArtifact(artifact.id)?.storyMap.edges).toContainEqual(
      removedEdge,
    );
  });

  it("records an exact event Evidence confirmation without copying source text", async () => {
    const { project, artifact } = await createInitialArtifact();
    const event = artifact.storyMap.events[0];
    const evidence = event.evidence[0];

    const revision = createStoryMapRevision({
      projectId: project.id,
      artifactId: artifact.id,
      change: {
        type: "confirm_evidence",
        eventId: event.id,
        evidence,
      },
    });

    expect(revision.review.evidenceConfirmations).toEqual([
      { eventId: event.id, evidence },
    ]);
    expect(JSON.stringify(revision.review)).not.toContain("渡船靠上");
    expect(artifact.review.evidenceConfirmations).toEqual([]);
  });

  it("fails closed for an unknown participant and leaves no revision", async () => {
    const { project, source, artifact } = await createInitialArtifact();

    expect(() =>
      createStoryMapRevision({
        projectId: project.id,
        artifactId: artifact.id,
        change: {
          type: "update_event",
          eventId: artifact.storyMap.events[0].id,
          participants: ["char_missing"],
        },
      }),
    ).toThrow("Story Map 校验失败");
    expect(listStoryMapArtifactsForSource(project.id, source.id)).toEqual([
      artifact,
    ]);
  });

  it("rejects Evidence that is not attached to the selected event", async () => {
    const { project, artifact } = await createInitialArtifact();
    const event = artifact.storyMap.events[0];
    const unrelatedEvidence = artifact.storyMap.events[1].evidence[0];

    expect(() =>
      createStoryMapRevision({
        projectId: project.id,
        artifactId: artifact.id,
        change: {
          type: "confirm_evidence",
          eventId: event.id,
          evidence: unrelatedEvidence,
        },
      }),
    ).toThrow("Evidence 不属于指定事件");
  });

  it("rejects edits based on a stale revision", async () => {
    const { project, artifact } = await createInitialArtifact();
    createStoryMapRevision({
      projectId: project.id,
      artifactId: artifact.id,
      change: {
        type: "update_event",
        eventId: artifact.storyMap.events[0].id,
        title: "较新的标题",
      },
    });

    expect(() =>
      createStoryMapRevision({
        projectId: project.id,
        artifactId: artifact.id,
        change: {
          type: "update_event",
          eventId: artifact.storyMap.events[0].id,
          title: "从旧版本提交的标题",
        },
      }),
    ).toThrow("Story Map 版本已更新");
  });

  it("confirms by creating one immutable revision and is idempotent", async () => {
    const { project, artifact } = await createInitialArtifact();

    const confirmed = confirmStoryMapArtifact({
      projectId: project.id,
      artifactId: artifact.id,
    });
    const repeated = confirmStoryMapArtifact({
      projectId: project.id,
      artifactId: confirmed.id,
    });

    expect(confirmed).toMatchObject({
      version: 2,
      basedOnArtifactId: artifact.id,
      generationRunId: null,
      storyMap: { version: 2, status: "confirmed" },
    });
    expect(repeated).toEqual(confirmed);
    expect(getStoryMapArtifact(artifact.id)?.storyMap.status).toBe("draft");
  });
});
