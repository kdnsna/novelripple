import type {
  Anchor,
  ImpactPlan,
  Source,
  StoryMap,
} from "@/domain/schemas";

/**
 * 与本次续写相关的 Canon Event 集合。
 *
 * 规则与旧 `buildPrompt` 的 `collectRelevantEventIds` 完全一致：
 * Divergence、每条 Impact 的起点/终点/reasonPath、Anchor 评估路径，
 * 以及 accepted Impact Plan 中 Anchor 的目标事件。这里只做确定性选择，
 * 不读取任何生成内容或兄弟分支。
 */
export function collectRelevantEventIds(plan: ImpactPlan): Set<string> {
  const ids = new Set<string>([plan.divergence.eventId]);
  for (const impact of plan.impacts) {
    ids.add(impact.fromEventId);
    if (impact.affectedEventId) ids.add(impact.affectedEventId);
    for (const id of impact.reasonPath) ids.add(id);
  }
  for (const evaluation of plan.anchorEvaluations) {
    for (const id of evaluation.reasonPath) ids.add(id);
  }
  for (const anchor of plan.anchors) ids.add(anchor.targetEventId);
  return ids;
}

export type RelatedCanon = {
  relevantEventIds: Set<string>;
  events: StoryMap["events"];
  edges: StoryMap["edges"];
  endingCandidates: StoryMap["endingCandidates"];
};

/** 按旧 readonlyCanonical 的语义筛选相关事件、内部边与 Anchor 目标结局。 */
export function selectRelatedCanon(input: {
  storyMap: StoryMap;
  impactPlan: ImpactPlan;
  anchors: readonly Anchor[];
}): RelatedCanon {
  const relevantEventIds = collectRelevantEventIds(input.impactPlan);
  const anchorTargets = new Set(
    input.anchors.map((anchor) => anchor.targetEventId),
  );
  return {
    relevantEventIds,
    events: input.storyMap.events.filter((event) =>
      relevantEventIds.has(event.id),
    ),
    edges: input.storyMap.edges.filter(
      (edge) =>
        relevantEventIds.has(edge.from) && relevantEventIds.has(edge.to),
    ),
    endingCandidates: input.storyMap.endingCandidates.filter((ending) =>
      anchorTargets.has(ending.targetEventId),
    ),
  };
}

/**
 * 生成 `canon_events` 段。字段与旧 `readonlyCanonical` 一致：
 * 相关事件保留 id/title/summary/sequence/participants/stateChanges，
 * 只保留相关事件之间的边和 Anchor 目标结局，不包含整本 Source。
 */
export function buildCanonEventsSection(input: {
  storyMap: StoryMap;
  storyMapArtifactId: string;
  source: Source;
  impactPlan: ImpactPlan;
  anchors: readonly Anchor[];
}): string {
  const related = selectRelatedCanon(input);
  return JSON.stringify({
    sourceId: input.source.id,
    storyMapArtifactId: input.storyMapArtifactId,
    storyMapId: input.storyMap.id,
    characters: input.storyMap.characters,
    events: related.events.map((event) => ({
      id: event.id,
      title: event.title,
      summary: event.summary,
      sequence: event.sequence,
      participants: event.participants,
      stateChanges: event.stateChanges,
    })),
    edges: related.edges,
    endingCandidates: related.endingCandidates,
  });
}

export type RelatedEvidenceItem = {
  id: string;
  text: string;
};

/**
 * 每个相关事件的原著证据切片，id 为 `related:<eventId>:<n>`。
 *
 * 这些证据必须排在代表片段/人物证据之前，并在裁剪时最后被丢弃。
 */
export function buildRelatedEvidenceItems(input: {
  storyMap: StoryMap;
  source: Source;
  impactPlan: ImpactPlan;
}): RelatedEvidenceItem[] {
  const related = selectRelatedCanon({
    storyMap: input.storyMap,
    impactPlan: input.impactPlan,
    anchors: [],
  });
  return related.events.flatMap((event) =>
    event.evidence.map((reference, index) => ({
      id: `related:${event.id}:${index}`,
      text: [
        `[事件 ${event.id} / ${event.title} / ${reference.sourceId} ${reference.sectionId} ${reference.start}-${reference.end} / ${reference.excerptHash}]`,
        input.source.normalizedText.slice(reference.start, reference.end),
      ].join("\n"),
    })),
  );
}
