import {
  sameSourceReference,
  sourceReferenceKey,
  type ImpactPlan,
  type Source,
  type SourceReference,
  type StoryMap,
  type StoryMapReview,
} from "@/domain/schemas";
import { sha256 } from "@/domain/source/normalize-source";

export type DomainValidationIssue = {
  path: string;
  message: string;
};

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }

  return [...duplicates];
}

function validateEvidence(
  source: Source,
  reference: SourceReference,
  path: string,
): DomainValidationIssue[] {
  const issues: DomainValidationIssue[] = [];

  if (reference.sourceId !== source.id) {
    issues.push({ path, message: `证据引用了未知 Source：${reference.sourceId}` });
    return issues;
  }

  const section = source.sections.find((item) => item.id === reference.sectionId);
  if (!section) {
    issues.push({ path, message: `证据引用了未知 Section：${reference.sectionId}` });
  }

  if (
    reference.start < 0 ||
    reference.end > source.normalizedText.length ||
    reference.start >= reference.end
  ) {
    issues.push({ path, message: "证据字符偏移超出 Source 边界" });
    return issues;
  }

  if (
    section &&
    (reference.start < section.start || reference.end > section.end)
  ) {
    issues.push({ path, message: "证据字符偏移不在声明的 Section 内" });
  }

  const excerpt = source.normalizedText.slice(reference.start, reference.end);
  if (sha256(excerpt) !== reference.excerptHash) {
    issues.push({ path, message: "证据片段 Hash 与 Source 不匹配" });
  }

  return issues;
}

function validateReasonPath(
  reasonPath: string[],
  eventIds: Set<string>,
  path: string,
): DomainValidationIssue[] {
  const issues = reasonPath
    .filter((eventId) => !eventIds.has(eventId))
    .map((eventId) => ({
      path,
      message: `reasonPath 引用了未知 Event：${eventId}`,
    }));
  for (const duplicate of duplicateValues(reasonPath)) {
    issues.push({
      path,
      message: `reasonPath 包含重复 Event：${duplicate}`,
    });
  }
  return issues;
}

export function validateImpactPlanReasonPaths(
  impactPlan: ImpactPlan,
  storyMap: StoryMap,
): DomainValidationIssue[] {
  const issues: DomainValidationIssue[] = [];
  const eventIds = new Set(storyMap.events.map((event) => event.id));

  if (!eventIds.has(impactPlan.divergence.eventId)) {
    issues.push({
      path: "divergence.eventId",
      message: `Divergence 引用了未知 Event：${impactPlan.divergence.eventId}`,
    });
  }

  for (const [impactIndex, impact] of impactPlan.impacts.entries()) {
    const path = `impacts.${impactIndex}.reasonPath`;
    if (!eventIds.has(impact.fromEventId)) {
      issues.push({
        path: `impacts.${impactIndex}.fromEventId`,
        message: `fromEventId 引用了未知 Event：${impact.fromEventId}`,
      });
    }
    if (impact.reasonPath[0] !== impact.fromEventId) {
      issues.push({
        path: `impacts.${impactIndex}.fromEventId`,
        message: "fromEventId 必须是 reasonPath 的起点",
      });
    }
    if (
      impact.affectedEventId !== null &&
      !eventIds.has(impact.affectedEventId)
    ) {
      issues.push({
        path: `impacts.${impactIndex}.affectedEventId`,
        message: `affectedEventId 引用了未知 Event：${impact.affectedEventId}`,
      });
    }
    if (!impact.reasonPath.includes(impactPlan.divergence.eventId)) {
      issues.push({
        path,
        message: "每项 Impact 的 reasonPath 必须包含 Divergence Event",
      });
    }
    if (
      impact.scope === "direct" &&
      impact.reasonPath[0] !== impactPlan.divergence.eventId
    ) {
      issues.push({
        path,
        message: "direct Impact 的 reasonPath 必须从 Divergence Event 开始",
      });
    }
    if (
      impact.affectedEventId !== null &&
      impact.reasonPath.at(-1) !== impact.affectedEventId
    ) {
      issues.push({
        path,
        message: "reasonPath 的终点必须等于 affectedEventId",
      });
    }
    issues.push(...validateReasonPath(impact.reasonPath, eventIds, path));
  }

  for (const [anchorIndex, anchor] of impactPlan.anchors.entries()) {
    if (!eventIds.has(anchor.targetEventId)) {
      issues.push({
        path: `anchors.${anchorIndex}.targetEventId`,
        message: `Anchor 引用了未知 Event：${anchor.targetEventId}`,
      });
    }
  }

  const anchorIds = new Set(impactPlan.anchors.map((anchor) => anchor.id));
  for (const [evaluationIndex, evaluation] of impactPlan.anchorEvaluations.entries()) {
    const path = `anchorEvaluations.${evaluationIndex}.reasonPath`;
    if (!anchorIds.has(evaluation.anchorId)) {
      issues.push({
        path: `anchorEvaluations.${evaluationIndex}.anchorId`,
        message: `Anchor 评估引用了未知 Anchor：${evaluation.anchorId}`,
      });
    }
    if (evaluation.reasonPath[0] !== impactPlan.divergence.eventId) {
      issues.push({
        path,
        message: "Anchor Evaluation 的 reasonPath 必须从 Divergence Event 开始",
      });
    }
    const anchor = impactPlan.anchors.find(
      (candidate) => candidate.id === evaluation.anchorId,
    );
    if (anchor && evaluation.reasonPath.at(-1) !== anchor.targetEventId) {
      issues.push({
        path,
        message: "Anchor Evaluation 的 reasonPath 必须以对应 targetEventId 结束",
      });
    }
    issues.push(...validateReasonPath(evaluation.reasonPath, eventIds, path));
  }

  return issues;
}

export function validateStoryMap(
  storyMap: StoryMap,
  source: Source,
): DomainValidationIssue[] {
  const issues: DomainValidationIssue[] = [];
  const characterIds = new Set(storyMap.characters.map((item) => item.id));
  const eventIds = new Set(storyMap.events.map((item) => item.id));
  const evidencedParticipantIds = new Set(
    storyMap.events.flatMap((event) => event.participants),
  );

  if (storyMap.sourceId !== source.id) {
    issues.push({
      path: "sourceId",
      message: `Story Map 绑定了未知 Source：${storyMap.sourceId}`,
    });
  }

  for (const duplicate of duplicateValues(
    storyMap.characters.map((item) => item.id),
  )) {
    issues.push({ path: "characters", message: `重复人物 ID：${duplicate}` });
  }

  storyMap.characters.forEach((character, characterIndex) => {
    if (!evidencedParticipantIds.has(character.id)) {
      issues.push({
        path: `characters.${characterIndex}`,
        message: `人物必须至少参与一个有 Evidence 的 Event：${character.id}`,
      });
    }
  });

  for (const duplicate of duplicateValues(storyMap.events.map((item) => item.id))) {
    issues.push({ path: "events", message: `重复事件 ID：${duplicate}` });
  }

  for (const duplicate of duplicateValues(storyMap.edges.map((item) => item.id))) {
    issues.push({ path: "edges", message: `重复边 ID：${duplicate}` });
  }

  for (const duplicate of duplicateValues(
    storyMap.endingCandidates.map((item) => item.id),
  )) {
    issues.push({
      path: "endingCandidates",
      message: `重复结局候选 ID：${duplicate}`,
    });
  }

  for (const duplicate of duplicateValues(
    storyMap.events.map((item) => String(item.sequence)),
  )) {
    issues.push({ path: "events", message: `重复事件顺序：${duplicate}` });
  }

  const orderedSequences = storyMap.events
    .map((event) => event.sequence)
    .sort((left, right) => left - right);
  const invalidSequenceIndex = orderedSequences.findIndex(
    (sequence, index) => sequence !== index + 1,
  );
  if (invalidSequenceIndex >= 0) {
    issues.push({
      path: "events",
      message: `事件 sequence 必须从 1 开始连续：期望 ${invalidSequenceIndex + 1}，实际 ${orderedSequences[invalidSequenceIndex]}`,
    });
  }

  for (const [eventIndex, event] of storyMap.events.entries()) {
    for (const participant of event.participants) {
      if (!characterIds.has(participant)) {
        issues.push({
          path: `events.${eventIndex}.participants`,
          message: `事件引用了未知人物：${participant}`,
        });
      }
    }

    event.evidence.forEach((reference, evidenceIndex) => {
      issues.push(
        ...validateEvidence(
          source,
          reference,
          `events.${eventIndex}.evidence.${evidenceIndex}`,
        ),
      );
    });
  }

  for (const [edgeIndex, edge] of storyMap.edges.entries()) {
    if (!eventIds.has(edge.from) || !eventIds.has(edge.to)) {
      issues.push({
        path: `edges.${edgeIndex}`,
        message: `因果边包含悬空引用：${edge.from} → ${edge.to}`,
      });
    }

    edge.evidence.forEach((reference, evidenceIndex) => {
      issues.push(
        ...validateEvidence(
          source,
          reference,
          `edges.${edgeIndex}.evidence.${evidenceIndex}`,
        ),
      );
    });
  }

  for (const [endingIndex, ending] of storyMap.endingCandidates.entries()) {
    if (!eventIds.has(ending.targetEventId)) {
      issues.push({
        path: `endingCandidates.${endingIndex}`,
        message: `结局候选引用了未知事件：${ending.targetEventId}`,
      });
    }

    ending.evidence.forEach((reference, evidenceIndex) => {
      issues.push(
        ...validateEvidence(
          source,
          reference,
          `endingCandidates.${endingIndex}.evidence.${evidenceIndex}`,
        ),
      );
    });
  }

  return issues;
}

export function validateImpactPlan(
  impactPlan: ImpactPlan,
  storyMap: StoryMap,
): DomainValidationIssue[] {
  const issues: DomainValidationIssue[] = [];
  const eventsById = new Map(storyMap.events.map((event) => [event.id, event]));
  const characterIds = new Set(
    storyMap.characters.map((character) => character.id),
  );
  const evaluatedAnchorIds = new Set(
    impactPlan.anchorEvaluations.map((evaluation) => evaluation.anchorId),
  );

  if (impactPlan.storyMapId !== storyMap.id) {
    issues.push({
      path: "storyMapId",
      message: `Impact Plan 绑定了未知 Story Map：${impactPlan.storyMapId}`,
    });
  }
  issues.push(...validateImpactPlanReasonPaths(impactPlan, storyMap));

  for (const scope of ["direct", "downstream", "ending"] as const) {
    if (!impactPlan.impacts.some((impact) => impact.scope === scope)) {
      issues.push({
        path: "impacts",
        message: `Impact Plan 缺少 ${scope} 影响`,
      });
    }
  }

  for (const duplicate of duplicateValues(
    impactPlan.impacts.map((impact) => impact.id),
  )) {
    issues.push({ path: "impacts", message: `重复影响 ID：${duplicate}` });
  }

  for (const duplicate of duplicateValues(
    impactPlan.anchors.map((anchor) => anchor.id),
  )) {
    issues.push({ path: "anchors", message: `重复 Anchor ID：${duplicate}` });
  }

  for (const duplicate of duplicateValues(
    impactPlan.anchorEvaluations.map((evaluation) => evaluation.anchorId),
  )) {
    issues.push({
      path: "anchorEvaluations",
      message: `重复 Anchor 评估：${duplicate}`,
    });
  }

  for (const [impactIndex, impact] of impactPlan.impacts.entries()) {
    if (impact.changeType !== "added" && impact.affectedEventId === null) {
      issues.push({
        path: `impacts.${impactIndex}.affectedEventId`,
        message: "修改、删除或保留原事件时必须声明 affectedEventId",
      });
    }
  }

  for (const [changeIndex, change] of impactPlan.characterChanges.entries()) {
    if (!characterIds.has(change.characterId)) {
      issues.push({
        path: `characterChanges.${changeIndex}.characterId`,
        message: `人物状态变化引用了未知人物：${change.characterId}`,
      });
    }
  }

  for (const duplicate of duplicateValues(
    impactPlan.characterChanges.map((change) => change.characterId),
  )) {
    issues.push({
      path: "characterChanges",
      message: `重复人物状态变化：${duplicate}`,
    });
  }
  for (const duplicate of duplicateValues(impactPlan.threadChanges.opened)) {
    issues.push({
      path: "threadChanges.opened",
      message: `重复开启线索：${duplicate}`,
    });
  }
  for (const duplicate of duplicateValues(impactPlan.threadChanges.closed)) {
    issues.push({
      path: "threadChanges.closed",
      message: `重复关闭线索：${duplicate}`,
    });
  }
  const closedThreads = new Set(impactPlan.threadChanges.closed);
  for (const [threadIndex, thread] of impactPlan.threadChanges.opened.entries()) {
    if (closedThreads.has(thread)) {
      issues.push({
        path: `threadChanges.opened.${threadIndex}`,
        message: `同一 Impact Plan 不能同时开启和关闭线索：${thread}`,
      });
    }
  }

  for (const [anchorIndex, anchor] of impactPlan.anchors.entries()) {
    const matchesEndingCandidate = storyMap.endingCandidates.some(
      (ending) =>
        ending.targetEventId === anchor.targetEventId &&
        ending.requirement === anchor.requirement,
    );
    if (!matchesEndingCandidate) {
      issues.push({
        path: `anchors.${anchorIndex}`,
        message: `Anchor 不匹配已确认 Story Map 的 Ending Candidate：${anchor.id}`,
      });
    }

    if (!evaluatedAnchorIds.has(anchor.id)) {
      issues.push({
        path: `anchors.${anchorIndex}`,
        message: `缺少 Anchor 评估：${anchor.id}`,
      });
    }
  }

  const divergence = eventsById.get(impactPlan.divergence.eventId);
  if (divergence) {
    for (const [impactIndex, impact] of impactPlan.impacts.entries()) {
      const affected = impact.affectedEventId
        ? eventsById.get(impact.affectedEventId)
        : undefined;
      if (
        affected &&
        affected.sequence < divergence.sequence &&
        (impact.changeType === "modified" || impact.changeType === "removed")
      ) {
        issues.push({
          path: `impacts.${impactIndex}.affectedEventId`,
          message: `任何模式都不得修改或删除分歧前事实：${affected.id}`,
        });
      }
    }
  }

  return issues;
}

export function validateStoryMapReview(
  storyMap: StoryMap,
  review: StoryMapReview,
): DomainValidationIssue[] {
  const issues: DomainValidationIssue[] = [];
  const confirmationKeys = new Set<string>();
  const edgeConfirmationKeys = new Set<string>();
  const characterIds = new Set(storyMap.characters.map((character) => character.id));
  const endingCandidateIds = new Set(
    storyMap.endingCandidates.map((ending) => ending.id),
  );

  review.evidenceConfirmations.forEach((confirmation, index) => {
    const event = storyMap.events.find(
      (candidate) => candidate.id === confirmation.eventId,
    );
    const path = `evidenceConfirmations.${index}`;
    if (!event) {
      issues.push({
        path,
        message: `Evidence 确认引用了未知 Event：${confirmation.eventId}`,
      });
      return;
    }

    const belongsToEvent = event.evidence.some((reference) =>
      sameSourceReference(reference, confirmation.evidence),
    );
    if (!belongsToEvent) {
      issues.push({ path, message: "Evidence 不属于指定事件" });
      return;
    }

    const key = [
      confirmation.eventId,
      confirmation.evidence.sourceId,
      confirmation.evidence.sectionId,
      confirmation.evidence.start,
      confirmation.evidence.end,
      confirmation.evidence.excerptHash,
    ].join(":");
    if (confirmationKeys.has(key)) {
      issues.push({ path, message: "Evidence 已被重复确认" });
    }
    confirmationKeys.add(key);
  });

  review.edgeEvidenceConfirmations.forEach((confirmation, index) => {
    const edge = storyMap.edges.find(
      (candidate) => candidate.id === confirmation.edgeId,
    );
    const path = `edgeEvidenceConfirmations.${index}`;
    if (!edge) {
      issues.push({
        path,
        message: `Edge Evidence 确认引用了未知 Edge：${confirmation.edgeId}`,
      });
      return;
    }
    if (
      !edge.evidence.some((reference) =>
        sameSourceReference(reference, confirmation.evidence),
      )
    ) {
      issues.push({ path, message: "Evidence 不属于指定 Edge" });
      return;
    }
    const key = `${confirmation.edgeId}:${sourceReferenceKey(confirmation.evidence)}`;
    if (edgeConfirmationKeys.has(key)) {
      issues.push({ path, message: "Edge Evidence 已被重复确认" });
    }
    edgeConfirmationKeys.add(key);
  });

  for (const duplicate of duplicateValues(review.characterConfirmations)) {
    issues.push({
      path: "characterConfirmations",
      message: `人物已被重复确认：${duplicate}`,
    });
  }
  review.characterConfirmations.forEach((characterId, index) => {
    if (!characterIds.has(characterId)) {
      issues.push({
        path: `characterConfirmations.${index}`,
        message: `人物确认引用了未知 Character：${characterId}`,
      });
    }
  });

  for (const duplicate of duplicateValues(review.endingCandidateConfirmations)) {
    issues.push({
      path: "endingCandidateConfirmations",
      message: `Ending Candidate 已被重复确认：${duplicate}`,
    });
  }
  review.endingCandidateConfirmations.forEach((endingId, index) => {
    if (!endingCandidateIds.has(endingId)) {
      issues.push({
        path: `endingCandidateConfirmations.${index}`,
        message: `Ending 确认引用了未知 Candidate：${endingId}`,
      });
    }
  });

  if (
    review.operation !== null &&
    review.operation.storyMapVersion !== storyMap.version
  ) {
    issues.push({
      path: "operation.storyMapVersion",
      message: "Review operation 必须记录当前 Story Map version",
    });
  }

  return issues;
}

export function assertValidStoryMap(storyMap: StoryMap, source: Source): void {
  assertNoIssues("Story Map", validateStoryMap(storyMap, source));
}

export function assertValidStoryMapReview(
  storyMap: StoryMap,
  review: StoryMapReview,
): void {
  assertNoIssues("Story Map Review", validateStoryMapReview(storyMap, review));
}

export function assertValidImpactPlan(
  impactPlan: ImpactPlan,
  storyMap: StoryMap,
): void {
  assertNoIssues("Impact Plan", validateImpactPlan(impactPlan, storyMap));
}

function assertNoIssues(label: string, issues: DomainValidationIssue[]): void {
  if (issues.length === 0) return;

  throw new Error(
    `${label} 校验失败：\n${issues
      .map((issue) => `- ${issue.path}: ${issue.message}`)
      .join("\n")}`,
  );
}
