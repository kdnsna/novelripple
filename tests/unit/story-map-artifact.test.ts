import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SourceReference, StoryMapContent } from "@/domain/schemas";
import { deriveStoryMapReview } from "@/domain/review/derive-story-map-review";
import {
  deriveEvidenceUnits,
  sourceReferenceForUnit,
} from "@/domain/source/evidence-units";
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
      review: {
        evidenceConfirmations: [],
        edgeEvidenceConfirmations: [],
        characterConfirmations: [],
        endingCandidateConfirmations: [],
        operation: null,
      },
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
    expect(revision.review.operation).toMatchObject({
      type: "update_event",
      storyMapVersion: 2,
    });
    expect(revision.review.operation?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(getStoryMapArtifact(artifact.id)).toEqual(original);
  });

  it("updates a Character and invalidates its review and affected Event Evidence", async () => {
    const { project, artifact } = await createInitialArtifact();
    const character = artifact.storyMap.characters[0];
    const affectedEvent = artifact.storyMap.events.find((event) =>
      event.participants.includes(character.id),
    )!;
    let latest = createStoryMapRevision({
      projectId: project.id,
      artifactId: artifact.id,
      change: { type: "confirm_character", characterId: character.id },
    });
    latest = createStoryMapRevision({
      projectId: project.id,
      artifactId: latest.id,
      change: {
        type: "confirm_evidence",
        eventId: affectedEvent.id,
        evidence: affectedEvent.evidence[0],
      },
    });

    const revision = createStoryMapRevision({
      projectId: project.id,
      artifactId: latest.id,
      change: {
        type: "update_character",
        characterId: character.id,
        name: `${character.name}（核对）`,
        aliases: [character.name],
        role: "supporting",
      },
    });

    expect(
      revision.storyMap.characters.find((item) => item.id === character.id),
    ).toMatchObject({
      name: `${character.name}（核对）`,
      aliases: [character.name],
      role: "supporting",
    });
    expect(revision.review.characterConfirmations).not.toContain(character.id);
    expect(revision.review.evidenceConfirmations).not.toContainEqual({
      eventId: affectedEvent.id,
      evidence: affectedEvent.evidence[0],
    });
    expect(revision.review.operation?.type).toBe("update_character");
  });

  it("merges Characters, rewrites every participant reference, and preserves the old Artifact", async () => {
    const { project, artifact } = await createInitialArtifact();
    const targetId = "char_xuchuan";
    const mergedId = "char_shenyan";
    const original = structuredClone(artifact);
    const affectedEventIds = artifact.storyMap.events
      .filter((event) => event.participants.includes(mergedId))
      .map((event) => event.id);
    let latest = createStoryMapRevision({
      projectId: project.id,
      artifactId: artifact.id,
      change: { type: "confirm_character", characterId: targetId },
    });
    latest = createStoryMapRevision({
      projectId: project.id,
      artifactId: latest.id,
      change: { type: "confirm_character", characterId: mergedId },
    });
    const evidenceEvent = artifact.storyMap.events.find((event) =>
      event.participants.includes(mergedId),
    )!;
    latest = createStoryMapRevision({
      projectId: project.id,
      artifactId: latest.id,
      change: {
        type: "confirm_evidence",
        eventId: evidenceEvent.id,
        evidence: evidenceEvent.evidence[0],
      },
    });

    const revision = createStoryMapRevision({
      projectId: project.id,
      artifactId: latest.id,
      change: {
        type: "merge_characters",
        targetCharacterId: targetId,
        mergedCharacterIds: [mergedId],
      },
    });

    expect(revision.storyMap.characters.some((item) => item.id === mergedId)).toBe(
      false,
    );
    expect(
      revision.storyMap.characters.find((item) => item.id === targetId)?.aliases,
    ).toEqual(expect.arrayContaining(["沈砚", "沈叔"]));
    for (const event of revision.storyMap.events) {
      expect(event.participants).not.toContain(mergedId);
      expect(new Set(event.participants).size).toBe(event.participants.length);
    }
    expect(revision.review.characterConfirmations).not.toContain(targetId);
    expect(revision.review.characterConfirmations).not.toContain(mergedId);
    expect(
      revision.review.evidenceConfirmations.some((confirmation) =>
        affectedEventIds.includes(confirmation.eventId),
      ),
    ).toBe(false);
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

  it("adds, confirms, updates, and deletes an Edge through immutable revisions", async () => {
    const { project, source, artifact } = await createInitialArtifact();
    const evidence = sourceReferenceForUnit(deriveEvidenceUnits(source)[0]!);
    const added = createStoryMapRevision({
      projectId: project.id,
      artifactId: artifact.id,
      change: {
        type: "add_edge",
        from: "event_01",
        to: "event_03",
        edgeType: "enables",
        explanation: "人工核对的新关系",
        evidence: [evidence],
      },
    });
    const edge = added.storyMap.edges.find(
      (candidate) => candidate.explanation === "人工核对的新关系",
    )!;
    expect(edge).toMatchObject({
      from: "event_01",
      to: "event_03",
      type: "enables",
      confidence: 1,
      confirmed: false,
      evidence: [evidence],
    });
    expect(edge.id).toMatch(/^edge_manual_/);

    const confirmed = createStoryMapRevision({
      projectId: project.id,
      artifactId: added.id,
      change: {
        type: "confirm_edge_evidence",
        edgeId: edge.id,
        evidence,
      },
    });
    expect(confirmed.review.edgeEvidenceConfirmations).toEqual([
      { edgeId: edge.id, evidence },
    ]);

    const updated = createStoryMapRevision({
      projectId: project.id,
      artifactId: confirmed.id,
      change: {
        type: "update_edge",
        edgeId: edge.id,
        edgeType: "causes",
        explanation: "人工核对后的直接因果",
      },
    });
    expect(updated.storyMap.edges.find((candidate) => candidate.id === edge.id)).toMatchObject({
      type: "causes",
      explanation: "人工核对后的直接因果",
    });
    expect(updated.review.edgeEvidenceConfirmations).toEqual([]);

    const removed = createStoryMapRevision({
      projectId: project.id,
      artifactId: updated.id,
      change: { type: "delete_edge", edgeId: edge.id },
    });
    expect(removed.storyMap.edges.some((candidate) => candidate.id === edge.id)).toBe(
      false,
    );
    expect(getStoryMapArtifact(added.id)?.storyMap.edges).toContainEqual(edge);
  });

  it("adds a missing Event only with valid selected Source Evidence", async () => {
    const { project, source, artifact } = await createInitialArtifact();
    const evidence = sourceReferenceForUnit(deriveEvidenceUnits(source)[0]!);

    const revision = createStoryMapRevision({
      projectId: project.id,
      artifactId: artifact.id,
      change: {
        type: "add_event",
        title: "人工补充事件",
        summary: "读者从所选原文证据补充一个遗漏事件。",
        participants: ["char_xucheng"],
        stateChanges: ["遗漏事实进入故事地图"],
        evidenceKind: "fact",
        evidence: [evidence],
      },
    });

    expect(revision.storyMap.events.at(-1)).toMatchObject({
      id: expect.stringMatching(/^event_manual_/),
      title: "人工补充事件",
      sequence: artifact.storyMap.events.length + 1,
      evidence: [evidence],
    });
    expect(revision.review.operation?.type).toBe("add_event");
    expect(getStoryMapArtifact(artifact.id)?.storyMap.events).toHaveLength(
      artifact.storyMap.events.length,
    );
  });

  it("rejects an added Event with foreign Evidence and rolls back the revision", async () => {
    const { project, source, artifact } = await createInitialArtifact();
    const evidence = sourceReferenceForUnit(deriveEvidenceUnits(source)[0]!);

    expect(() =>
      createStoryMapRevision({
        projectId: project.id,
        artifactId: artifact.id,
        change: {
          type: "add_event",
          title: "非法补充",
          summary: "这条事件使用了不属于当前 Source 的 Evidence。",
          participants: ["char_xucheng"],
          stateChanges: [],
          evidenceKind: "fact",
          evidence: [{ ...evidence, sourceId: "source_foreign" }],
        },
      }),
    ).toThrow("必须选择由 Source 确定性派生的 Evidence Unit");
    expect(listStoryMapArtifactsForSource(project.id, source.id)).toEqual([
      artifact,
    ]);
  });

  it("rejects an added Event whose Evidence is not an exact derived Evidence Unit", async () => {
    const { project, source, artifact } = await createInitialArtifact();
    const unit = deriveEvidenceUnits(source)[0]!;
    const half = Math.max(1, Math.floor((unit.end - unit.start) / 2));
    // 合法引用（offset/hash 正确）但不是派生 Unit 边界：不允许绕过选择器。
    const subRange = sourceReferenceForUnit({
      ...unit,
      end: unit.start + half,
      text: source.normalizedText.slice(unit.start, unit.start + half),
    });

    expect(() =>
      createStoryMapRevision({
        projectId: project.id,
        artifactId: artifact.id,
        change: {
          type: "add_event",
          title: "非法补充",
          summary: "这条事件使用了非 Unit 边界的 Evidence。",
          participants: ["char_xucheng"],
          stateChanges: [],
          evidenceKind: "fact",
          evidence: [subRange],
        },
      }),
    ).toThrow("必须选择由 Source 确定性派生的 Evidence Unit");
    expect(listStoryMapArtifactsForSource(project.id, source.id)).toEqual([
      artifact,
    ]);
  });

  it("deletes an erroneous Event and cascades incident Edges, Endings, and confirmations", async () => {
    const { project, artifact } = await createInitialArtifact();
    const removedEvent = artifact.storyMap.events.at(-1)!;
    let latest = createStoryMapRevision({
      projectId: project.id,
      artifactId: artifact.id,
      change: {
        type: "confirm_evidence",
        eventId: removedEvent.id,
        evidence: removedEvent.evidence[0],
      },
    });
    for (const ending of artifact.storyMap.endingCandidates.filter(
      (candidate) => candidate.targetEventId === removedEvent.id,
    )) {
      latest = createStoryMapRevision({
        projectId: project.id,
        artifactId: latest.id,
        change: {
          type: "confirm_ending_candidate",
          endingCandidateId: ending.id,
        },
      });
    }

    const revision = createStoryMapRevision({
      projectId: project.id,
      artifactId: latest.id,
      change: { type: "delete_event", eventId: removedEvent.id },
    });

    expect(revision.storyMap.events.some((event) => event.id === removedEvent.id)).toBe(
      false,
    );
    expect(
      revision.storyMap.edges.some(
        (edge) => edge.from === removedEvent.id || edge.to === removedEvent.id,
      ),
    ).toBe(false);
    expect(
      revision.storyMap.endingCandidates.some(
        (ending) => ending.targetEventId === removedEvent.id,
      ),
    ).toBe(false);
    expect(
      revision.review.evidenceConfirmations.some(
        (confirmation) => confirmation.eventId === removedEvent.id,
      ),
    ).toBe(false);
    expect(revision.storyMap.events.map((event) => event.sequence)).toEqual(
      revision.storyMap.events.map((_, index) => index + 1),
    );
  });

  it("reorders every Event exactly once and rejects partial or unchanged order", async () => {
    const { project, source, artifact } = await createInitialArtifact();
    const reversedIds = artifact.storyMap.events.map((event) => event.id).reverse();

    const revision = createStoryMapRevision({
      projectId: project.id,
      artifactId: artifact.id,
      change: { type: "reorder_events", eventIds: reversedIds },
    });
    expect(
      [...revision.storyMap.events]
        .sort((left, right) => left.sequence - right.sequence)
        .map((event) => event.id),
    ).toEqual(reversedIds);

    expect(() =>
      createStoryMapRevision({
        projectId: project.id,
        artifactId: revision.id,
        change: { type: "reorder_events", eventIds: reversedIds },
      }),
    ).toThrow("修改没有产生变化");
    expect(() =>
      createStoryMapRevision({
        projectId: project.id,
        artifactId: revision.id,
        change: { type: "reorder_events", eventIds: reversedIds.slice(1) },
      }),
    ).toThrow("事件重排必须包含当前全部 Event");
    expect(listStoryMapArtifactsForSource(project.id, source.id)[0]).toEqual(
      revision,
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

  it("invalidates every confirmation for a summarized Event while preserving other Events and the prior Artifact", async () => {
    const { project, artifact } = await createInitialArtifact();
    const targetEvent = artifact.storyMap.events[1];
    const otherEvent = artifact.storyMap.events[0];
    let latest = artifact;

    for (const evidence of targetEvent.evidence) {
      latest = createStoryMapRevision({
        projectId: project.id,
        artifactId: latest.id,
        change: {
          type: "confirm_evidence",
          eventId: targetEvent.id,
          evidence,
        },
      });
    }
    latest = createStoryMapRevision({
      projectId: project.id,
      artifactId: latest.id,
      change: {
        type: "confirm_evidence",
        eventId: otherEvent.id,
        evidence: otherEvent.evidence[0],
      },
    });
    const priorArtifact = structuredClone(latest);

    const revision = createStoryMapRevision({
      projectId: project.id,
      artifactId: latest.id,
      change: {
        type: "update_event",
        eventId: targetEvent.id,
        summary: `${targetEvent.summary}（人工修正）`,
      },
    });

    expect(revision.storyMap.status).toBe("draft");
    expect(
      revision.review.evidenceConfirmations.filter(
        (confirmation) => confirmation.eventId === targetEvent.id,
      ),
    ).toEqual([]);
    expect(revision.review.evidenceConfirmations).toContainEqual({
      eventId: otherEvent.id,
      evidence: otherEvent.evidence[0],
    });
    expect(getStoryMapArtifact(latest.id)).toEqual(priorArtifact);
  });

  it("invalidates the edited Event confirmations when participants change", async () => {
    const { project, artifact } = await createInitialArtifact();
    const targetEvent = artifact.storyMap.events[1];
    const confirmed = createStoryMapRevision({
      projectId: project.id,
      artifactId: artifact.id,
      change: {
        type: "confirm_evidence",
        eventId: targetEvent.id,
        evidence: targetEvent.evidence[0],
      },
    });

    const revision = createStoryMapRevision({
      projectId: project.id,
      artifactId: confirmed.id,
      change: {
        type: "update_event",
        eventId: targetEvent.id,
        participants: targetEvent.participants.filter(
          (participant) => participant !== "char_xuchuan",
        ),
      },
    });

    expect(revision.storyMap.status).toBe("draft");
    expect(
      revision.review.evidenceConfirmations.filter(
        (confirmation) => confirmation.eventId === targetEvent.id,
      ),
    ).toEqual([]);
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

  it("refuses premature confirmation, then confirms a ready map immutably and idempotently", async () => {
    const { project, source, artifact } = await createInitialArtifact();

    expect(() =>
      confirmStoryMapArtifact({
        projectId: project.id,
        artifactId: artifact.id,
      }),
    ).toThrow("Story Map 尚未完成必要核对");

    let latest = artifact;
    const initialReview = deriveStoryMapReview(latest, source);
    for (const characterId of initialReview.coreCharacterIds) {
      latest = createStoryMapRevision({
        projectId: project.id,
        artifactId: latest.id,
        change: { type: "confirm_character", characterId },
      });
    }
    for (const ending of latest.storyMap.endingCandidates) {
      latest = createStoryMapRevision({
        projectId: project.id,
        artifactId: latest.id,
        change: {
          type: "confirm_ending_candidate",
          endingCandidateId: ending.id,
        },
      });
    }
    for (const requirement of deriveStoryMapReview(latest, source)
      .importantEvidence) {
      latest = createStoryMapRevision({
        projectId: project.id,
        artifactId: latest.id,
        change:
          requirement.targetKind === "event"
            ? {
                type: "confirm_evidence",
                eventId: requirement.targetId,
                evidence: requirement.evidence,
              }
            : {
                type: "confirm_edge_evidence",
                edgeId: requirement.targetId,
                evidence: requirement.evidence,
              },
      });
    }
    expect(deriveStoryMapReview(latest, source).readiness.readyForRipple).toBe(
      true,
    );

    const confirmed = confirmStoryMapArtifact({
      projectId: project.id,
      artifactId: latest.id,
    });
    const repeated = confirmStoryMapArtifact({
      projectId: project.id,
      artifactId: confirmed.id,
    });

    expect(confirmed).toMatchObject({
      version: latest.version + 1,
      basedOnArtifactId: latest.id,
      generationRunId: null,
      storyMap: { version: latest.version + 1, status: "confirmed" },
      review: {
        operation: {
          type: "confirm_story_map",
          storyMapVersion: latest.version + 1,
        },
      },
    });
    expect(repeated).toEqual(confirmed);
    expect(getStoryMapArtifact(artifact.id)?.storyMap.status).toBe("draft");
  });
});
