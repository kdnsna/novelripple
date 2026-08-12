import { validateStoryMap } from "@/domain/invariants/validate-story-map";
import type {
  Source,
  SourceReference,
  StoryMapArtifact,
} from "@/domain/schemas";

export const LOW_CONFIDENCE_THRESHOLD = 0.75;

export type StoryMapReviewQueueCategory =
  | "inference_event"
  | "low_confidence_event"
  | "low_confidence_edge"
  | "alias_rich_character"
  | "identity_merge_risk"
  | "ending_candidate"
  | "high_leverage_divergence"
  | "unconfirmed_evidence"
  | "validator_advisory";

export type StoryMapReviewQueueItem = {
  id: string;
  category: StoryMapReviewQueueCategory;
  priority: number;
  targetKind: "event" | "edge" | "character" | "ending";
  targetId: string;
  relatedTargetIds: string[];
  title: string;
  reason: string;
  status: "pending" | "reviewed" | "advisory";
};

export type ImportantEvidenceRequirement = {
  targetKind: "event" | "edge";
  targetId: string;
  evidence: SourceReference;
};

export type StoryMapReadiness = {
  eventsHaveEvidence: boolean;
  coreCharactersReviewed: boolean;
  endingCandidatesReviewed: boolean;
  noIllegalReferences: boolean;
  noDanglingEdges: boolean;
  importantEvidenceReviewed: boolean;
  readyForRipple: boolean;
};

export type DerivedStoryMapReview = {
  queue: StoryMapReviewQueueItem[];
  readiness: StoryMapReadiness;
  coreCharacterIds: string[];
  importantEvidence: ImportantEvidenceRequirement[];
};

const categoryOrder: Record<StoryMapReviewQueueCategory, number> = {
  inference_event: 1,
  low_confidence_event: 2,
  low_confidence_edge: 3,
  alias_rich_character: 4,
  identity_merge_risk: 5,
  ending_candidate: 6,
  high_leverage_divergence: 7,
  unconfirmed_evidence: 8,
  validator_advisory: 9,
};

const materialOperationTypes = new Set([
  "update_character",
  "merge_characters",
  "update_event",
  "delete_event",
  "add_event",
  "reorder_events",
  "delete_edge",
  "add_edge",
  "update_edge",
]);

export function deriveStoryMapReview(
  artifact: StoryMapArtifact,
  source: Source,
): DerivedStoryMapReview {
  const { storyMap, review } = artifact;
  const queue: StoryMapReviewQueueItem[] = [];
  const reviewedCharacters = new Set(review.characterConfirmations);
  const reviewedEndings = new Set(review.endingCandidateConfirmations);
  const coreCharacterIds = deriveCoreCharacterIds(artifact);
  const highLeverage = deriveHighLeverageEvents(storyMap);
  const highLeverageIds = new Set(highLeverage.map((item) => item.eventId));
  const endingTargetIds = new Set(
    storyMap.endingCandidates.map((ending) => ending.targetEventId),
  );

  for (const event of storyMap.events) {
    const evidenceReviewed = event.evidence.every((evidence) =>
      review.evidenceConfirmations.some(
        (confirmation) =>
          confirmation.eventId === event.id &&
          sameSourceReference(confirmation.evidence, evidence),
      ),
    );
    if (event.evidenceKind === "inference") {
      queue.push({
        id: `inference_event:${event.id}`,
        category: "inference_event",
        priority: 1,
        targetKind: "event",
        targetId: event.id,
        relatedTargetIds: [],
        title: event.title,
        reason: "该事件是模型推断，需要结合 Evidence 人工判断。",
        status: evidenceReviewed ? "reviewed" : "pending",
      });
    }
    if (
      event.confidence !== undefined &&
      event.confidence < LOW_CONFIDENCE_THRESHOLD
    ) {
      queue.push({
        id: `low_confidence_event:${event.id}`,
        category: "low_confidence_event",
        priority: 2,
        targetKind: "event",
        targetId: event.id,
        relatedTargetIds: [],
        title: event.title,
        reason: `事件置信度 ${formatConfidence(event.confidence)}，低于明确阈值 ${formatConfidence(LOW_CONFIDENCE_THRESHOLD)}。`,
        status: evidenceReviewed ? "reviewed" : "pending",
      });
    }
  }

  for (const edge of storyMap.edges) {
    const evidenceReviewed = edge.evidence.every((evidence) =>
      review.edgeEvidenceConfirmations.some(
        (confirmation) =>
          confirmation.edgeId === edge.id &&
          sameSourceReference(confirmation.evidence, evidence),
      ),
    );
    if (edge.confidence < LOW_CONFIDENCE_THRESHOLD) {
      queue.push({
        id: `low_confidence_edge:${edge.id}`,
        category: "low_confidence_edge",
        priority: 2,
        targetKind: "edge",
        targetId: edge.id,
        relatedTargetIds: [edge.from, edge.to],
        title: edge.explanation,
        reason: `Edge 置信度 ${formatConfidence(edge.confidence)}，低于明确阈值 ${formatConfidence(LOW_CONFIDENCE_THRESHOLD)}。`,
        status: evidenceReviewed ? "reviewed" : "pending",
      });
    }
  }

  for (const character of storyMap.characters) {
    if (character.aliases.length >= 2) {
      queue.push({
        id: `alias_rich_character:${character.id}`,
        category: "alias_rich_character",
        priority: 3,
        targetKind: "character",
        targetId: character.id,
        relatedTargetIds: [],
        title: character.name,
        reason: `该人物有 ${character.aliases.length} 个别名，需要核对是否属于同一身份。`,
        status: reviewedCharacters.has(character.id) ? "reviewed" : "pending",
      });
    }
  }

  for (const risk of deriveIdentityMergeRisks(storyMap.characters)) {
    const reviewed = risk.characterIds.every((id) => reviewedCharacters.has(id));
    queue.push({
      id: `identity_merge_risk:${risk.characterIds.join(":")}`,
      category: "identity_merge_risk",
      priority: 4,
      targetKind: "character",
      targetId: risk.characterIds[0]!,
      relatedTargetIds: risk.characterIds.slice(1),
      title: "人物身份可能重复",
      reason: `不同人物使用了相同名称或别名“${risk.label}”，系统不会自动合并。`,
      status: reviewed ? "reviewed" : "pending",
    });
  }

  for (const ending of storyMap.endingCandidates) {
    queue.push({
      id: `ending_candidate:${ending.id}`,
      category: "ending_candidate",
      priority: 5,
      targetKind: "ending",
      targetId: ending.id,
      relatedTargetIds: [ending.targetEventId],
      title: ending.requirement,
      reason: "该 Ending Candidate 将影响 strict Ripple 的 Anchor 选择。",
      status: reviewedEndings.has(ending.id) ? "reviewed" : "pending",
    });
  }

  for (const item of highLeverage) {
    queue.push({
      id: `high_leverage_divergence:${item.eventId}`,
      category: "high_leverage_divergence",
      priority: 6,
      targetKind: "event",
      targetId: item.eventId,
      relatedTargetIds: [],
      title:
        storyMap.events.find((event) => event.id === item.eventId)?.title ??
        item.eventId,
      reason: `沿当前 Edge 可影响 ${item.reachableCount} 个后续事件，值得优先判断分叉价值。`,
      status: "advisory",
    });
  }

  const importantEvidence = deriveImportantEvidenceRequirements({
    artifact,
    endingTargetIds,
    highLeverageIds,
  });
  for (const requirement of importantEvidence) {
    const confirmed = isEvidenceConfirmed(artifact, requirement);
    if (!confirmed) {
      queue.push({
        id: `unconfirmed_evidence:${requirement.targetKind}:${requirement.targetId}:${referenceKey(requirement.evidence)}`,
        category: "unconfirmed_evidence",
        priority: 7,
        targetKind: requirement.targetKind,
        targetId: requirement.targetId,
        relatedTargetIds: [],
        title: requirement.targetKind === "event" ? "事件 Evidence" : "Edge Evidence",
        reason: "这条 Evidence 支撑高风险或高影响结构，尚未人工确认。",
        status: "pending",
      });
    }
  }

  for (const characterId of coreCharacterIds) {
    if (reviewedCharacters.has(characterId)) continue;
    const character = storyMap.characters.find(
      (candidate) => candidate.id === characterId,
    )!;
    queue.push({
      id: `validator_advisory:core_character:${characterId}`,
      category: "validator_advisory",
      priority: 8,
      targetKind: "character",
      targetId: characterId,
      relatedTargetIds: [],
      title: character.name,
      reason: "该人物承担核心角色或参与多个事件，需要人工核对身份。",
      status: "pending",
    });
  }

  for (const edge of storyMap.edges.filter((candidate) => !candidate.confirmed)) {
    queue.push({
      id: `validator_advisory:edge_unconfirmed:${edge.id}`,
      category: "validator_advisory",
      priority: 8,
      targetKind: "edge",
      targetId: edge.id,
      relatedTargetIds: [edge.from, edge.to],
      title: edge.explanation,
      reason: "领域结构合法，但该 Edge 尚未被确认。",
      status: "advisory",
    });
  }
  for (const event of storyMap.events.filter(
    (candidate) => candidate.stateChanges.length === 0,
  )) {
    queue.push({
      id: `validator_advisory:empty_state_changes:${event.id}`,
      category: "validator_advisory",
      priority: 8,
      targetKind: "event",
      targetId: event.id,
      relatedTargetIds: [],
      title: event.title,
      reason: "领域结构允许空状态变化，但关键 Event 通常需要人工核对。",
      status: "advisory",
    });
  }

  queue.sort(
    (left, right) =>
      left.priority - right.priority ||
      categoryOrder[left.category] - categoryOrder[right.category] ||
      left.id.localeCompare(right.id),
  );

  const validationIssues = validateStoryMap(storyMap, source);
  const danglingIssues = validationIssues.filter(
    (issue) =>
      issue.path.startsWith("edges.") && issue.message.includes("悬空引用"),
  );
  const evidenceIssues = validationIssues.filter(
    (issue) => issue.path.startsWith("events.") && issue.path.includes(".evidence."),
  );
  const illegalIssues = validationIssues.filter(
    (issue) => !danglingIssues.includes(issue),
  );
  const eventsHaveEvidence =
    storyMap.events.every((event) => event.evidence.length > 0) &&
    evidenceIssues.length === 0;
  const coreCharactersReviewed = coreCharacterIds.every((id) =>
    reviewedCharacters.has(id),
  );
  const endingCandidatesReviewed = storyMap.endingCandidates.every((ending) =>
    reviewedEndings.has(ending.id),
  );
  const noIllegalReferences = illegalIssues.length === 0;
  const noDanglingEdges = danglingIssues.length === 0;
  const importantEvidenceReviewed = importantEvidence.every((requirement) =>
    isEvidenceConfirmed(artifact, requirement),
  );
  const readyForRipple =
    eventsHaveEvidence &&
    coreCharactersReviewed &&
    endingCandidatesReviewed &&
    noIllegalReferences &&
    noDanglingEdges &&
    importantEvidenceReviewed;

  return {
    queue,
    coreCharacterIds,
    importantEvidence,
    readiness: {
      eventsHaveEvidence,
      coreCharactersReviewed,
      endingCandidatesReviewed,
      noIllegalReferences,
      noDanglingEdges,
      importantEvidenceReviewed,
      readyForRipple,
    },
  };
}

export function summarizeStoryMapReviewOperations(
  artifacts: StoryMapArtifact[],
): {
  totalOperations: number;
  materialRevisions: number;
  manualEventAdditions: number;
  byType: Record<string, number>;
} {
  const operations = artifacts.flatMap((artifact) =>
    artifact.review.operation ? [artifact.review.operation] : [],
  );
  const counts = new Map<string, number>();
  for (const operation of operations) {
    counts.set(operation.type, (counts.get(operation.type) ?? 0) + 1);
  }
  return {
    totalOperations: operations.length,
    materialRevisions: operations.filter((operation) =>
      materialOperationTypes.has(operation.type),
    ).length,
    manualEventAdditions: counts.get("add_event") ?? 0,
    byType: Object.fromEntries(
      [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function deriveCoreCharacterIds(artifact: StoryMapArtifact): string[] {
  const participation = new Map<string, number>();
  for (const event of artifact.storyMap.events) {
    for (const characterId of new Set(event.participants)) {
      participation.set(characterId, (participation.get(characterId) ?? 0) + 1);
    }
  }
  return artifact.storyMap.characters
    .filter(
      (character) =>
        character.role === "protagonist" ||
        character.role === "antagonist" ||
        (participation.get(character.id) ?? 0) >= 2,
    )
    .map((character) => character.id)
    .sort();
}

function deriveHighLeverageEvents(
  storyMap: StoryMapArtifact["storyMap"],
): Array<{ eventId: string; reachableCount: number }> {
  const outgoing = new Map<string, string[]>();
  for (const edge of storyMap.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  return storyMap.events
    .map((event) => ({
      eventId: event.id,
      sequence: event.sequence,
      reachableCount: countReachable(event.id, outgoing),
    }))
    .filter((item) => item.reachableCount > 0)
    .sort(
      (left, right) =>
        right.reachableCount - left.reachableCount ||
        left.sequence - right.sequence ||
        left.eventId.localeCompare(right.eventId),
    )
    .slice(0, 3)
    .map(({ eventId, reachableCount }) => ({ eventId, reachableCount }));
}

function countReachable(start: string, outgoing: Map<string, string[]>): number {
  const seen = new Set<string>();
  const pending = [...(outgoing.get(start) ?? [])];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === start || seen.has(current)) continue;
    seen.add(current);
    pending.push(...(outgoing.get(current) ?? []));
  }
  return seen.size;
}

function deriveIdentityMergeRisks(
  characters: StoryMapArtifact["storyMap"]["characters"],
): Array<{ characterIds: string[]; label: string }> {
  const identities = new Map<string, Array<{ id: string; label: string }>>();
  for (const character of characters) {
    for (const label of [character.name, ...character.aliases]) {
      const normalized = normalizeIdentityLabel(label);
      if (!normalized) continue;
      identities.set(normalized, [
        ...(identities.get(normalized) ?? []),
        { id: character.id, label: label.trim() },
      ]);
    }
  }
  return [...identities.values()]
    .map((values) => ({
      characterIds: [...new Set(values.map((value) => value.id))].sort(),
      label: values[0]?.label ?? "",
    }))
    .filter((risk) => risk.characterIds.length >= 2)
    .sort((left, right) => left.characterIds.join(":").localeCompare(right.characterIds.join(":")));
}

function deriveImportantEvidenceRequirements(input: {
  artifact: StoryMapArtifact;
  endingTargetIds: Set<string>;
  highLeverageIds: Set<string>;
}): ImportantEvidenceRequirement[] {
  const requirements: ImportantEvidenceRequirement[] = [];
  for (const event of input.artifact.storyMap.events) {
    const important =
      event.evidenceKind === "inference" ||
      (event.confidence !== undefined && event.confidence < LOW_CONFIDENCE_THRESHOLD) ||
      input.endingTargetIds.has(event.id) ||
      input.highLeverageIds.has(event.id);
    if (!important) continue;
    for (const evidence of event.evidence) {
      requirements.push({ targetKind: "event", targetId: event.id, evidence });
    }
  }
  for (const edge of input.artifact.storyMap.edges) {
    if (edge.confirmed && edge.confidence >= LOW_CONFIDENCE_THRESHOLD) continue;
    for (const evidence of edge.evidence) {
      requirements.push({ targetKind: "edge", targetId: edge.id, evidence });
    }
  }
  const seen = new Set<string>();
  return requirements.filter((requirement) => {
    const key = `${requirement.targetKind}:${requirement.targetId}:${referenceKey(requirement.evidence)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isEvidenceConfirmed(
  artifact: StoryMapArtifact,
  requirement: ImportantEvidenceRequirement,
): boolean {
  if (requirement.targetKind === "event") {
    return artifact.review.evidenceConfirmations.some(
      (confirmation) =>
        confirmation.eventId === requirement.targetId &&
        sameSourceReference(confirmation.evidence, requirement.evidence),
    );
  }
  return artifact.review.edgeEvidenceConfirmations.some(
    (confirmation) =>
      confirmation.edgeId === requirement.targetId &&
      sameSourceReference(confirmation.evidence, requirement.evidence),
  );
}

function normalizeIdentityLabel(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function sameSourceReference(
  left: SourceReference,
  right: SourceReference,
): boolean {
  return referenceKey(left) === referenceKey(right);
}

function referenceKey(reference: SourceReference): string {
  return [
    reference.sourceId,
    reference.sectionId,
    reference.start,
    reference.end,
    reference.excerptHash,
  ].join(":");
}
