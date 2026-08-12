import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray } from "drizzle-orm";

import {
  assertValidStoryMap,
  assertValidStoryMapReview,
} from "@/domain/invariants/validate-story-map";
import { deriveStoryMapReview } from "@/domain/review/derive-story-map-review";
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
      review: {
        evidenceConfirmations: [],
        edgeEvidenceConfirmations: [],
        characterConfirmations: [],
        endingCandidateConfirmations: [],
        operation: null,
      },
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
    operationType: change.type,
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
    operationType: "confirm_story_map",
    requireReadyForRipple: true,
    returnIfAlreadyConfirmed: true,
    update: () => "confirmed",
  });
}

function createRevisionFromLatest(input: {
  projectId: string;
  artifactId: string;
  operationType: NonNullable<StoryMapReview["operation"]>["type"];
  requireReadyForRipple?: boolean;
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
    if (
      input.requireReadyForRipple &&
      !deriveStoryMapReview(base, source).readiness.readyForRipple
    ) {
      throw new Error("Story Map 尚未完成必要核对，不能进入 Ripple");
    }

    const nextStoryMap = structuredClone(base.storyMap);
    const nextReview = structuredClone(base.review);
    const nextStatus = input.update(nextStoryMap, nextReview);
    const version = base.version + 1;
    const createdAt = new Date().toISOString();
    nextReview.operation = {
      type: input.operationType,
      timestamp: createdAt,
      storyMapVersion: version,
    };
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
      createdAt,
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
  if (change.type === "update_character") {
    const character = storyMap.characters.find(
      (candidate) => candidate.id === change.characterId,
    );
    if (!character) throw new Error("找不到指定的 Story Map Character");
    const before = JSON.stringify(character);
    if (change.name !== undefined) character.name = change.name;
    if (change.aliases !== undefined) character.aliases = change.aliases;
    if (change.role !== undefined) character.role = change.role;
    if (JSON.stringify(character) === before) throw new Error("修改没有产生变化");
    invalidateCharacterReview(review, [change.characterId]);
    invalidateEventEvidenceForCharacters(storyMap, review, [change.characterId]);
    return;
  }

  if (change.type === "merge_characters") {
    const mergedIds = [...new Set(change.mergedCharacterIds)];
    if (
      mergedIds.length !== change.mergedCharacterIds.length ||
      mergedIds.includes(change.targetCharacterId)
    ) {
      throw new Error("人物合并必须使用互不重复的 Character");
    }
    const target = storyMap.characters.find(
      (character) => character.id === change.targetCharacterId,
    );
    const mergedCharacters = mergedIds.map((id) =>
      storyMap.characters.find((character) => character.id === id),
    );
    if (!target || mergedCharacters.some((character) => !character)) {
      throw new Error("找不到指定的 Story Map Character");
    }
    const affectedIds = [change.targetCharacterId, ...mergedIds];
    target.aliases = stableIdentityLabels([
      ...target.aliases,
      ...mergedCharacters.flatMap((character) => [
        character!.name,
        ...character!.aliases,
      ]),
    ]).filter((alias) => normalizeIdentityLabel(alias) !== normalizeIdentityLabel(target.name));
    storyMap.characters = storyMap.characters.filter(
      (character) => !mergedIds.includes(character.id),
    );
    const affectedEventIds: string[] = [];
    for (const event of storyMap.events) {
      if (!event.participants.some((id) => mergedIds.includes(id))) continue;
      affectedEventIds.push(event.id);
      event.participants = [
        ...new Set(
          event.participants.map((id) =>
            mergedIds.includes(id) ? change.targetCharacterId : id,
          ),
        ),
      ];
    }
    invalidateCharacterReview(review, affectedIds);
    invalidateEventEvidence(review, affectedEventIds);
    return;
  }

  if (change.type === "confirm_character") {
    if (
      !storyMap.characters.some(
        (character) => character.id === change.characterId,
      )
    ) {
      throw new Error("找不到指定的 Story Map Character");
    }
    if (review.characterConfirmations.includes(change.characterId)) {
      throw new Error("人物已确认");
    }
    review.characterConfirmations.push(change.characterId);
    return;
  }

  if (change.type === "update_event") {
    const event = storyMap.events.find((candidate) => candidate.id === change.eventId);
    if (!event) throw new Error("找不到指定的 Story Map Event");
    const before = JSON.stringify(event);
    if (change.title !== undefined) event.title = change.title;
    if (change.summary !== undefined) event.summary = change.summary;
    if (change.participants !== undefined) {
      event.participants = change.participants;
    }
    if (change.stateChanges !== undefined) {
      event.stateChanges = change.stateChanges;
    }
    if (change.evidenceKind !== undefined) {
      event.evidenceKind = change.evidenceKind;
    }
    if (change.confidence !== undefined) {
      event.confidence = change.confidence;
    }
    if (JSON.stringify(event) === before) throw new Error("修改没有产生变化");
    invalidateEventEvidence(review, [change.eventId]);
    return;
  }

  if (change.type === "delete_event") {
    const eventIndex = storyMap.events.findIndex(
      (candidate) => candidate.id === change.eventId,
    );
    if (eventIndex < 0) throw new Error("找不到指定的 Story Map Event");
    storyMap.events.splice(eventIndex, 1);
    storyMap.events
      .sort((left, right) => left.sequence - right.sequence)
      .forEach((event, index) => {
        event.sequence = index + 1;
      });
    const removedEdgeIds = storyMap.edges
      .filter(
        (edge) => edge.from === change.eventId || edge.to === change.eventId,
      )
      .map((edge) => edge.id);
    storyMap.edges = storyMap.edges.filter(
      (edge) => !removedEdgeIds.includes(edge.id),
    );
    const removedEndingIds = storyMap.endingCandidates
      .filter((ending) => ending.targetEventId === change.eventId)
      .map((ending) => ending.id);
    storyMap.endingCandidates = storyMap.endingCandidates.filter(
      (ending) => !removedEndingIds.includes(ending.id),
    );
    invalidateEventEvidence(review, [change.eventId]);
    review.edgeEvidenceConfirmations = review.edgeEvidenceConfirmations.filter(
      (confirmation) => !removedEdgeIds.includes(confirmation.edgeId),
    );
    review.endingCandidateConfirmations =
      review.endingCandidateConfirmations.filter(
        (endingId) => !removedEndingIds.includes(endingId),
      );
    return;
  }

  if (change.type === "add_event") {
    storyMap.events.push({
      id: `event_manual_${randomUUID()}`,
      title: change.title,
      summary: change.summary,
      sequence: storyMap.events.length + 1,
      participants: change.participants,
      stateChanges: change.stateChanges,
      evidenceKind: change.evidenceKind,
      ...(change.confidence === undefined
        ? {}
        : { confidence: change.confidence }),
      evidence: change.evidence,
    });
    return;
  }

  if (change.type === "reorder_events") {
    const currentIds = [...storyMap.events]
      .sort((left, right) => left.sequence - right.sequence)
      .map((event) => event.id);
    if (
      change.eventIds.length !== currentIds.length ||
      new Set(change.eventIds).size !== currentIds.length ||
      change.eventIds.some((id) => !currentIds.includes(id))
    ) {
      throw new Error("事件重排必须包含当前全部 Event 且每个只出现一次");
    }
    if (change.eventIds.every((id, index) => id === currentIds[index])) {
      throw new Error("修改没有产生变化");
    }
    const eventsById = new Map(storyMap.events.map((event) => [event.id, event]));
    storyMap.events = change.eventIds.map((id, index) => {
      const event = eventsById.get(id)!;
      event.sequence = index + 1;
      return event;
    });
    return;
  }

  if (change.type === "delete_edge") {
    const edgeIndex = storyMap.edges.findIndex(
      (candidate) => candidate.id === change.edgeId,
    );
    if (edgeIndex < 0) throw new Error("找不到指定的 Story Edge");
    storyMap.edges.splice(edgeIndex, 1);
    review.edgeEvidenceConfirmations = review.edgeEvidenceConfirmations.filter(
      (confirmation) => confirmation.edgeId !== change.edgeId,
    );
    return;
  }

  if (change.type === "add_edge") {
    storyMap.edges.push({
      id: `edge_manual_${randomUUID()}`,
      from: change.from,
      to: change.to,
      type: change.edgeType,
      explanation: change.explanation,
      confidence: 1,
      confirmed: false,
      evidence: change.evidence,
    });
    return;
  }

  if (change.type === "update_edge") {
    const edge = storyMap.edges.find((candidate) => candidate.id === change.edgeId);
    if (!edge) throw new Error("找不到指定的 Story Edge");
    const before = JSON.stringify(edge);
    if (change.edgeType !== undefined) edge.type = change.edgeType;
    if (change.explanation !== undefined) edge.explanation = change.explanation;
    if (change.evidence !== undefined) edge.evidence = change.evidence;
    if (JSON.stringify(edge) === before) throw new Error("修改没有产生变化");
    review.edgeEvidenceConfirmations = review.edgeEvidenceConfirmations.filter(
      (confirmation) => confirmation.edgeId !== change.edgeId,
    );
    return;
  }

  if (change.type === "confirm_evidence") {
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
    return;
  }

  if (change.type === "confirm_edge_evidence") {
    const edge = storyMap.edges.find(
      (candidate) => candidate.id === change.edgeId,
    );
    if (
      !edge ||
      !edge.evidence.some((reference) =>
        sameSourceReference(reference, change.evidence),
      )
    ) {
      throw new Error("Evidence 不属于指定 Edge");
    }
    if (
      review.edgeEvidenceConfirmations.some(
        (confirmation) =>
          confirmation.edgeId === change.edgeId &&
          sameSourceReference(confirmation.evidence, change.evidence),
      )
    ) {
      throw new Error("Edge Evidence 已确认");
    }
    review.edgeEvidenceConfirmations.push({
      edgeId: change.edgeId,
      evidence: change.evidence,
    });
    return;
  }

  const ending = storyMap.endingCandidates.find(
    (candidate) => candidate.id === change.endingCandidateId,
  );
  if (!ending) throw new Error("找不到指定的 Ending Candidate");
  if (review.endingCandidateConfirmations.includes(ending.id)) {
    throw new Error("Ending Candidate 已确认");
  }
  review.endingCandidateConfirmations.push(ending.id);
}

function invalidateCharacterReview(
  review: StoryMapReview,
  characterIds: string[],
): void {
  const invalidated = new Set(characterIds);
  review.characterConfirmations = review.characterConfirmations.filter(
    (characterId) => !invalidated.has(characterId),
  );
}

function invalidateEventEvidenceForCharacters(
  storyMap: StoryMapArtifact["storyMap"],
  review: StoryMapReview,
  characterIds: string[],
): void {
  const affected = new Set(characterIds);
  invalidateEventEvidence(
    review,
    storyMap.events
      .filter((event) => event.participants.some((id) => affected.has(id)))
      .map((event) => event.id),
  );
}

function invalidateEventEvidence(
  review: StoryMapReview,
  eventIds: string[],
): void {
  const invalidated = new Set(eventIds);
  review.evidenceConfirmations = review.evidenceConfirmations.filter(
    (confirmation) => !invalidated.has(confirmation.eventId),
  );
}

function stableIdentityLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  return labels.filter((label) => {
    const normalized = normalizeIdentityLabel(label);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function normalizeIdentityLabel(label: string): string {
  return label.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
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
