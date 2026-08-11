import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray } from "drizzle-orm";

import {
  assertValidStoryMap,
  assertValidStoryMapReview,
} from "@/domain/invariants/validate-story-map";
import {
  StoryMapArtifactSchema,
  StoryMapContentSchema,
  StoryMapRevisionChangeSchema,
  StoryMapSchema,
  type StoryMapArtifact,
  type StoryMapContent,
  type StoryMapReview,
  type StoryMapRevisionChange,
  type SourceReference,
} from "@/domain/schemas";
import { getDatabase } from "@/server/db/client";
import { artifacts } from "@/server/db/schema";
import { getGenerationRun } from "@/server/repositories/generation-run-repository";
import { getProjectSource } from "@/server/repositories/project-repository";

const storyMapKinds = ["story_map", "story_map_revision"] as const;

export function createStoryMapArtifact(input: {
  projectId: string;
  sourceId: string;
  content: StoryMapContent;
  generationRunId: string;
}): StoryMapArtifact {
  const content = StoryMapContentSchema.parse(input.content);
  const source = getProjectSource(input.projectId, input.sourceId);
  if (!source) throw new Error("找不到 Story Map 对应的 Source");

  const run = getGenerationRun(input.generationRunId);
  if (
    !run ||
    run.projectId !== input.projectId ||
    run.worldlineId !== null ||
    run.kind !== "story_map_reconcile" ||
    run.status !== "succeeded"
  ) {
    throw new Error("Artifact 必须绑定成功的 Story Map Reconciler Run");
  }

  return getDatabase().transaction((transaction) => {
    const previous = transaction
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.projectId, input.projectId),
          eq(artifacts.sourceId, input.sourceId),
          inArray(artifacts.kind, storyMapKinds),
        ),
      )
      .orderBy(desc(artifacts.version), desc(artifacts.createdAt))
      .get();
    const version = (previous?.version ?? 0) + 1;
    const storyMap = StoryMapSchema.parse({
      schemaVersion: 1,
      id: `story_map_${randomUUID()}`,
      sourceId: source.id,
      version,
      status: "draft",
      ...content,
    });
    assertValidStoryMap(storyMap, source);

    const artifact = StoryMapArtifactSchema.parse({
      id: `artifact_story_map_${randomUUID()}`,
      projectId: input.projectId,
      sourceId: source.id,
      kind: version === 1 ? "story_map" : "story_map_revision",
      schemaVersion: 2,
      version,
      storyMap,
      review: { evidenceConfirmations: [] },
      basedOnArtifactId: previous?.id ?? null,
      generationRunId: run.id,
      createdAt: new Date().toISOString(),
    });

    transaction
      .insert(artifacts)
      .values({
        id: artifact.id,
        projectId: artifact.projectId,
        sourceId: artifact.sourceId,
        worldlineId: null,
        kind: artifact.kind,
        schemaVersion: artifact.schemaVersion,
        version: artifact.version,
        dataJson: JSON.stringify(artifact.storyMap),
        reviewJson: JSON.stringify(artifact.review),
        basedOnArtifactId: artifact.basedOnArtifactId,
        generationRunId: artifact.generationRunId,
        createdAt: artifact.createdAt,
      })
      .run();

    return artifact;
  });
}

export function getStoryMapArtifact(id: string): StoryMapArtifact | null {
  const row = getDatabase()
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, id), inArray(artifacts.kind, storyMapKinds)))
    .get();

  return row ? parseStoryMapArtifact(row) : null;
}

export function listStoryMapArtifactsForSource(
  projectId: string,
  sourceId: string,
): StoryMapArtifact[] {
  return getDatabase()
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.projectId, projectId),
        eq(artifacts.sourceId, sourceId),
        inArray(artifacts.kind, storyMapKinds),
      ),
    )
    .orderBy(desc(artifacts.version), desc(artifacts.createdAt))
    .all()
    .map(parseStoryMapArtifact);
}

export function createStoryMapRevision(input: {
  projectId: string;
  artifactId: string;
  change: StoryMapRevisionChange;
}): StoryMapArtifact {
  const change = StoryMapRevisionChangeSchema.parse(input.change);

  return createRevisionFromLatest({
    projectId: input.projectId,
    artifactId: input.artifactId,
    update(storyMap, review) {
      applyReviewChange(storyMap, review, change);
      return "draft";
    },
  });
}

export function confirmStoryMapArtifact(input: {
  projectId: string;
  artifactId: string;
}): StoryMapArtifact {
  return createRevisionFromLatest({
    ...input,
    returnIfAlreadyConfirmed: true,
    update: () => "confirmed",
  });
}

function createRevisionFromLatest(input: {
  projectId: string;
  artifactId: string;
  returnIfAlreadyConfirmed?: boolean;
  update: (
    storyMap: StoryMapArtifact["storyMap"],
    review: StoryMapReview,
  ) => "draft" | "confirmed";
}): StoryMapArtifact {
  const base = getStoryMapArtifact(input.artifactId);
  if (!base || base.projectId !== input.projectId) {
    throw new Error("找不到指定的 Story Map Artifact");
  }
  const source = getProjectSource(base.projectId, base.sourceId);
  if (!source) throw new Error("找不到 Story Map 对应的 Source");

  return getDatabase().transaction((transaction) => {
    const latestRow = transaction
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.projectId, base.projectId),
          eq(artifacts.sourceId, base.sourceId),
          inArray(artifacts.kind, storyMapKinds),
        ),
      )
      .orderBy(desc(artifacts.version), desc(artifacts.createdAt))
      .get();
    if (!latestRow || latestRow.id !== base.id) {
      throw new Error("Story Map 版本已更新，请基于最新 revision 重试");
    }
    if (
      input.returnIfAlreadyConfirmed &&
      base.storyMap.status === "confirmed"
    ) {
      return base;
    }

    const nextStoryMap = structuredClone(base.storyMap);
    const nextReview = structuredClone(base.review);
    const nextStatus = input.update(nextStoryMap, nextReview);
    const version = base.version + 1;
    const storyMap = StoryMapSchema.parse({
      ...nextStoryMap,
      id: `story_map_${randomUUID()}`,
      version,
      status: nextStatus,
    });
    assertValidStoryMap(storyMap, source);
    assertValidStoryMapReview(storyMap, nextReview);

    const artifact = StoryMapArtifactSchema.parse({
      id: `artifact_story_map_${randomUUID()}`,
      projectId: base.projectId,
      sourceId: base.sourceId,
      kind: "story_map_revision",
      schemaVersion: 2,
      version,
      storyMap,
      review: nextReview,
      basedOnArtifactId: base.id,
      generationRunId: null,
      createdAt: new Date().toISOString(),
    });

    transaction
      .insert(artifacts)
      .values({
        id: artifact.id,
        projectId: artifact.projectId,
        sourceId: artifact.sourceId,
        worldlineId: null,
        kind: artifact.kind,
        schemaVersion: artifact.schemaVersion,
        version: artifact.version,
        dataJson: JSON.stringify(artifact.storyMap),
        reviewJson: JSON.stringify(artifact.review),
        basedOnArtifactId: artifact.basedOnArtifactId,
        generationRunId: null,
        createdAt: artifact.createdAt,
      })
      .run();

    return artifact;
  });
}

function applyReviewChange(
  storyMap: StoryMapArtifact["storyMap"],
  review: StoryMapReview,
  change: StoryMapRevisionChange,
): void {
  if (change.type === "update_event") {
    const event = storyMap.events.find((candidate) => candidate.id === change.eventId);
    if (!event) throw new Error("找不到指定的 Story Map Event");
    const before = JSON.stringify(event);
    if (change.title !== undefined) event.title = change.title;
    if (change.summary !== undefined) event.summary = change.summary;
    if (change.participants !== undefined) {
      event.participants = change.participants;
    }
    if (JSON.stringify(event) === before) throw new Error("修改没有产生变化");
    return;
  }

  if (change.type === "delete_edge") {
    const edgeIndex = storyMap.edges.findIndex(
      (candidate) => candidate.id === change.edgeId,
    );
    if (edgeIndex < 0) throw new Error("找不到指定的 Story Edge");
    storyMap.edges.splice(edgeIndex, 1);
    return;
  }

  const event = storyMap.events.find(
    (candidate) => candidate.id === change.eventId,
  );
  if (
    !event ||
    !event.evidence.some((reference) =>
      sameSourceReference(reference, change.evidence),
    )
  ) {
    throw new Error("Evidence 不属于指定事件");
  }
  const alreadyConfirmed = review.evidenceConfirmations.some(
    (confirmation) =>
      confirmation.eventId === change.eventId &&
      sameSourceReference(confirmation.evidence, change.evidence),
  );
  if (alreadyConfirmed) throw new Error("Evidence 已确认");
  review.evidenceConfirmations.push({
    eventId: change.eventId,
    evidence: change.evidence,
  });
}

function sameSourceReference(
  left: SourceReference,
  right: SourceReference,
): boolean {
  return (
    left.sourceId === right.sourceId &&
    left.sectionId === right.sectionId &&
    left.start === right.start &&
    left.end === right.end &&
    left.excerptHash === right.excerptHash
  );
}

function parseStoryMapArtifact(
  row: typeof artifacts.$inferSelect,
): StoryMapArtifact {
  if (row.sourceId === null || row.version === null) {
    throw new Error(`Story Map Artifact 缺少 Source 或版本：${row.id}`);
  }

  return StoryMapArtifactSchema.parse({
    id: row.id,
    projectId: row.projectId,
    sourceId: row.sourceId,
    kind: row.kind,
    schemaVersion: row.schemaVersion,
    version: row.version,
    storyMap: JSON.parse(row.dataJson),
    review: JSON.parse(row.reviewJson),
    basedOnArtifactId: row.basedOnArtifactId,
    generationRunId: row.generationRunId,
    createdAt: normalizeSqliteDate(row.createdAt),
  });
}

function normalizeSqliteDate(value: string): string {
  if (value.includes("T")) return value;
  return `${value.replace(" ", "T")}Z`;
}
