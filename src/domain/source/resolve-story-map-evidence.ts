import {
  StoryMapContentSchema,
  type Source,
  type SourceReference,
  type StoryMapContent,
  type StoryMapLocalExtractionCandidate,
  type StoryMapReconciliationCandidate,
} from "@/domain/schemas";
import type { AnalysisSegment } from "@/domain/source/analysis-segments";
import { sha256 } from "@/domain/source/normalize-source";

export type EvidenceResolutionIssue = {
  path: string;
  message: string;
};

export type TemporaryEvidenceReference = {
  id: string;
  reference: SourceReference;
};

type LocalCharacter = StoryMapLocalExtractionCandidate["characters"][number];
type LocalEvent = StoryMapLocalExtractionCandidate["events"][number];
type LocalEdge = StoryMapLocalExtractionCandidate["edges"][number];

export type ResolvedSegmentCandidate = {
  segmentId: string;
  characters: Array<Omit<LocalCharacter, "localId"> & { localId: string }>;
  events: Array<
    Omit<LocalEvent, "localId" | "evidence" | "participants"> & {
      localId: string;
      participants: string[];
      evidenceReferenceIds: string[];
    }
  >;
  edges: Array<
    Omit<LocalEdge, "localId" | "evidence" | "from" | "to"> & {
      localId: string;
      from: string;
      to: string;
      evidenceReferenceIds: string[];
    }
  >;
};

export function temporaryEvidenceReferenceId(
  reference: SourceReference,
): string {
  return [
    "evidence_ref",
    reference.sourceId,
    reference.sectionId,
    reference.start,
    reference.end,
  ].join(":");
}

export function resolveLocalStoryMapCandidate(input: {
  local: StoryMapLocalExtractionCandidate;
  source: Source;
  segment: AnalysisSegment;
}):
  | {
      success: true;
      candidate: ResolvedSegmentCandidate;
      references: TemporaryEvidenceReference[];
    }
  | { success: false; issues: EvidenceResolutionIssue[] } {
  const { local, source, segment } = input;
  const issues: EvidenceResolutionIssue[] = [];

  if (segment.sourceId !== source.id) {
    return {
      success: false,
      issues: [{ path: "segment.sourceId", message: "Segment 不属于当前 Source" }],
    };
  }

  collectDuplicateIdIssues(local.characters, "characters", issues);
  collectDuplicateIdIssues(local.events, "events", issues);
  collectDuplicateIdIssues(local.edges, "edges", issues);

  const characterIds = new Set(local.characters.map((item) => item.localId));
  const eventIds = new Set(local.events.map((item) => item.localId));

  for (const [eventIndex, event] of local.events.entries()) {
    for (const [participantIndex, participant] of event.participants.entries()) {
      if (!characterIds.has(participant)) {
        issues.push({
          path: `events.${eventIndex}.participants.${participantIndex}`,
          message: "Event participant 引用了未知 Character",
        });
      }
    }
  }

  for (const [edgeIndex, edge] of local.edges.entries()) {
    if (!eventIds.has(edge.from)) {
      issues.push({
        path: `edges.${edgeIndex}.from`,
        message: "Edge from 存在悬空 Event 引用",
      });
    }
    if (!eventIds.has(edge.to)) {
      issues.push({
        path: `edges.${edgeIndex}.to`,
        message: "Edge to 存在悬空 Event 引用",
      });
    }
  }

  if (issues.length > 0) return { success: false, issues };

  const references = new Map<string, TemporaryEvidenceReference>();
  const events = local.events.map((event, eventIndex) => {
    const evidenceReferenceIds = resolveClaims({
      claims: event.evidence,
      path: `events.${eventIndex}.evidence`,
      source,
      segment,
      requirePrimaryCore: true,
      references,
      issues,
    });
    return {
      localId: namespacedLocalId(segment, "event", event.localId),
      title: event.title,
      summary: event.summary,
      sequence: event.sequence,
      participants: event.participants.map((participant) =>
        namespacedLocalId(segment, "character", participant),
      ),
      stateChanges: event.stateChanges,
      evidenceKind: event.evidenceKind,
      ...(event.confidence === undefined
        ? {}
        : { confidence: event.confidence }),
      evidenceReferenceIds,
    };
  });

  const edges = local.edges.map((edge, edgeIndex) => {
    const evidenceReferenceIds = resolveClaims({
      claims: edge.evidence,
      path: `edges.${edgeIndex}.evidence`,
      source,
      segment,
      requirePrimaryCore: true,
      references,
      issues,
    });
    return {
      localId: namespacedLocalId(segment, "edge", edge.localId),
      from: namespacedLocalId(segment, "event", edge.from),
      to: namespacedLocalId(segment, "event", edge.to),
      type: edge.type,
      explanation: edge.explanation,
      confidence: edge.confidence,
      confirmed: edge.confirmed,
      evidenceReferenceIds,
    };
  });

  if (issues.length > 0) return { success: false, issues };

  return {
    success: true,
    candidate: {
      segmentId: segment.id,
      characters: local.characters.map(({ localId, ...character }) => ({
        ...character,
        localId: namespacedLocalId(segment, "character", localId),
      })),
      events,
      edges,
    },
    references: [...references.values()],
  };
}

export function dedupeResolvedSegmentCandidates(
  candidates: ResolvedSegmentCandidate[],
): ResolvedSegmentCandidate[] {
  const canonicalEventIds = new Map<string, string>();
  const eventIdsByKey = new Map<string, string>();

  const withoutDuplicateEvents = candidates.map((candidate) => ({
    ...candidate,
    characters: candidate.characters.map((character) => ({ ...character })),
    events: candidate.events.filter((event) => {
      const key = [
        normalizeForExactDedupe(event.title),
        event.evidenceReferenceIds[0],
      ].join("\u0000");
      const canonical = eventIdsByKey.get(key);
      if (canonical) {
        canonicalEventIds.set(event.localId, canonical);
        return false;
      }
      eventIdsByKey.set(key, event.localId);
      canonicalEventIds.set(event.localId, event.localId);
      return true;
    }),
    edges: candidate.edges.map((edge) => ({ ...edge })),
  }));

  const seenEdges = new Set<string>();
  return withoutDuplicateEvents.map((candidate) => ({
    ...candidate,
    edges: candidate.edges
      .map((edge) => ({
        ...edge,
        from: canonicalEventIds.get(edge.from) ?? edge.from,
        to: canonicalEventIds.get(edge.to) ?? edge.to,
      }))
      .filter((edge) => {
        const key = [
          edge.from,
          edge.to,
          edge.type,
          [...edge.evidenceReferenceIds].sort().join(","),
        ].join("\u0000");
        if (seenEdges.has(key)) return false;
        seenEdges.add(key);
        return true;
      }),
  }));
}

export function resolveReconciledStoryMapCandidate(input: {
  candidate: StoryMapReconciliationCandidate;
  source: Source;
  references: TemporaryEvidenceReference[];
}):
  | { success: true; content: StoryMapContent }
  | { success: false; issues: EvidenceResolutionIssue[] } {
  const { candidate, source } = input;
  const issues: EvidenceResolutionIssue[] = [];
  const references = new Map<string, SourceReference>();

  for (const [index, temporary] of input.references.entries()) {
    if (!isReferenceDerivedFromSource(temporary.reference, source)) {
      issues.push({
        path: `references.${index}`,
        message: "临时 Evidence Reference 不属于当前 Source 或哈希无效",
      });
      continue;
    }
    if (temporaryEvidenceReferenceId(temporary.reference) !== temporary.id) {
      issues.push({
        path: `references.${index}.id`,
        message: "临时 Evidence Reference ID 与范围不一致",
      });
      continue;
    }
    const existing = references.get(temporary.id);
    if (existing && !sameReference(existing, temporary.reference)) {
      issues.push({
        path: `references.${index}.id`,
        message: "临时 Evidence Reference ID 冲突",
      });
      continue;
    }
    references.set(temporary.id, temporary.reference);
  }

  const events = candidate.events.map((event, eventIndex) => {
    const { evidenceReferenceIds, ...content } = event;
    return {
      ...content,
      evidence: resolveTemporaryReferences(
        evidenceReferenceIds,
        references,
        `events.${eventIndex}.evidenceReferenceIds`,
        issues,
      ),
    };
  });
  const edges = candidate.edges.map((edge, edgeIndex) => {
    const { evidenceReferenceIds, ...content } = edge;
    return {
      ...content,
      evidence: resolveTemporaryReferences(
        evidenceReferenceIds,
        references,
        `edges.${edgeIndex}.evidenceReferenceIds`,
        issues,
      ),
    };
  });
  const endingCandidates = candidate.endingCandidates.map(
    (ending, endingIndex) => {
      const { evidenceReferenceIds, ...content } = ending;
      return {
        ...content,
        evidence: resolveTemporaryReferences(
          evidenceReferenceIds,
          references,
          `endingCandidates.${endingIndex}.evidenceReferenceIds`,
          issues,
        ),
      };
    },
  );

  if (issues.length > 0) return { success: false, issues };

  return {
    success: true,
    content: StoryMapContentSchema.parse({
      title: candidate.title,
      logline: candidate.logline,
      characters: candidate.characters,
      events,
      edges,
      endingCandidates,
    }),
  };
}

function collectDuplicateIdIssues(
  items: Array<{ localId: string }>,
  path: string,
  issues: EvidenceResolutionIssue[],
): void {
  const ids = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (ids.has(item.localId)) {
      issues.push({
        path: `${path}.${index}.localId`,
        message: "局部 Candidate ID 重复",
      });
    }
    ids.add(item.localId);
  }
}

function resolveClaims(input: {
  claims: Array<{ sectionId: string; exactQuote: string }>;
  path: string;
  source: Source;
  segment: AnalysisSegment;
  requirePrimaryCore: boolean;
  references: Map<string, TemporaryEvidenceReference>;
  issues: EvidenceResolutionIssue[];
}): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const [index, claim] of input.claims.entries()) {
    const path = `${input.path}.${index}`;
    const claimKey = `${claim.sectionId}\u0000${claim.exactQuote}`;
    if (seen.has(claimKey)) {
      input.issues.push({ path, message: "Evidence 声明重复" });
      continue;
    }
    seen.add(claimKey);

    const section = input.source.sections.find(
      (item) => item.id === claim.sectionId,
    );
    if (!section) {
      input.issues.push({ path, message: "Evidence 引用了未知 Section" });
      continue;
    }
    if (
      section.start < input.segment.contextStart ||
      section.end > input.segment.contextEnd
    ) {
      input.issues.push({ path, message: "Evidence Section 不属于当前 Segment" });
      continue;
    }

    const sectionText = input.source.normalizedText.slice(
      section.start,
      section.end,
    );
    const relativeStart = sectionText.indexOf(claim.exactQuote);
    if (relativeStart < 0) {
      input.issues.push({ path, message: "exactQuote 未在指定 Section 中找到" });
      continue;
    }
    if (sectionText.indexOf(claim.exactQuote, relativeStart + 1) >= 0) {
      input.issues.push({ path, message: "exactQuote 在指定 Section 中不唯一" });
      continue;
    }

    const start = section.start + relativeStart;
    const end = start + claim.exactQuote.length;
    if (
      index === 0 &&
      input.requirePrimaryCore &&
      (start < input.segment.coreStart || end > input.segment.coreEnd)
    ) {
      input.issues.push({
        path,
        message: "第一条 Evidence 必须完整位于 Segment core 范围",
      });
      continue;
    }

    const reference: SourceReference = {
      sourceId: input.source.id,
      sectionId: section.id,
      start,
      end,
      excerptHash: sha256(
        input.source.normalizedText.slice(start, end),
      ),
    };
    const id = temporaryEvidenceReferenceId(reference);
    input.references.set(id, { id, reference });
    ids.push(id);
  }

  return ids;
}

function resolveTemporaryReferences(
  ids: string[],
  references: Map<string, SourceReference>,
  path: string,
  issues: EvidenceResolutionIssue[],
): SourceReference[] {
  const seen = new Set<string>();
  const resolved: SourceReference[] = [];

  for (const [index, id] of ids.entries()) {
    if (seen.has(id)) {
      issues.push({
        path: `${path}.${index}`,
        message: "临时 Evidence Reference ID 重复",
      });
      continue;
    }
    seen.add(id);
    const reference = references.get(id);
    if (!reference) {
      issues.push({
        path: `${path}.${index}`,
        message: "引用了未知临时 Evidence Reference ID",
      });
      continue;
    }
    resolved.push(reference);
  }

  return resolved;
}

function namespacedLocalId(
  segment: AnalysisSegment,
  kind: "character" | "event" | "edge",
  localId: string,
): string {
  return `local:${segment.id}:${kind}:${localId}`;
}

function normalizeForExactDedupe(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

function isReferenceDerivedFromSource(
  reference: SourceReference,
  source: Source,
): boolean {
  if (reference.sourceId !== source.id) return false;
  const section = source.sections.find(
    (item) => item.id === reference.sectionId,
  );
  if (!section) return false;
  if (reference.start < section.start || reference.end > section.end) {
    return false;
  }
  if (reference.start >= reference.end) return false;
  return (
    sha256(source.normalizedText.slice(reference.start, reference.end)) ===
    reference.excerptHash
  );
}

function sameReference(
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
