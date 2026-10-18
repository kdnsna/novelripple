import type {
  Anchor,
  ImpactPlan,
  Source,
  StoryMap,
} from "@/domain/schemas";

import type { ContextEvidenceItem } from "./context-assembler";

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

/**
 * 分歧事件及其直接依赖的分歧前 Canon Event 集合。
 *
 * 规则：始终包含分歧事件自身；再包含每条已确认（`edge.confirmed`）Story Map
 * 边的 `from` 事件——前提是该边的 `to` 正是分歧事件，且 `from` 事件在故事
 * 顺序上早于分歧事件（`sequence < divergence.sequence`）。分歧后事件、从
 * 分歧事件出发的边、未确认边以及不存在的端点都不算直接依赖。该集合用于把
 * 对应原著证据标记为 pinned：它们是分歧成立所依赖的最小 Canon 依据，任何
 * 预算下都不得被降级阶梯裁掉。纯函数，不读取生成内容或兄弟分支。
 */
export function divergenceDependencyEventIds(
  storyMap: StoryMap,
  divergenceEventId: string,
): Set<string> {
  const ids = new Set<string>([divergenceEventId]);
  const divergence = storyMap.events.find(
    (event) => event.id === divergenceEventId,
  );
  if (divergence === undefined) return ids;
  for (const edge of storyMap.edges) {
    if (!edge.confirmed || edge.to !== divergenceEventId) continue;
    const from = storyMap.events.find((event) => event.id === edge.from);
    if (from !== undefined && from.sequence < divergence.sequence) {
      ids.add(edge.from);
    }
  }
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
 * 生成 `canon_events` 段（必需段，不参与裁剪阶梯）。
 *
 * 只为相关事件保留 id/title/summary/sequence/participants/stateChanges；
 * 人物只保留 id/name/aliases/role（worldline_setup 已携带同一份 slim 列表）；
 * 边保留 id/from/to/type/explanation/confidence/confirmed，Anchor 目标结局
 * 保留 id/targetEventId/requirement。
 *
 * 这里刻意不包含任何 `evidence[]`：原著证据已经由 `buildRelatedEvidenceItems`
 * 单独放进可裁剪的 `canon_evidence`（相关事件切片优先、最后丢弃）。若把同一份
 * 证据再塞进必需段，证据就无法被降级阶梯裁掉，strict 模式首次方向生成会因
 * 证据体积直接超预算；证据只属于 `canon_evidence`，不回到必需段。
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
    characters: input.storyMap.characters.map((character) => ({
      id: character.id,
      name: character.name,
      aliases: character.aliases,
      role: character.role,
    })),
    events: related.events.map((event) => ({
      id: event.id,
      title: event.title,
      summary: event.summary,
      sequence: event.sequence,
      participants: event.participants,
      stateChanges: event.stateChanges,
    })),
    edges: related.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      type: edge.type,
      explanation: edge.explanation,
      confidence: edge.confidence,
      confirmed: edge.confirmed,
    })),
    endingCandidates: related.endingCandidates.map((ending) => ({
      id: ending.id,
      targetEventId: ending.targetEventId,
      requirement: ending.requirement,
    })),
  });
}

export type RelatedEvidenceItem = {
  id: string;
  text: string;
};

/**
 * 每个相关事件的原著证据切片，id 为 `related:<eventId>:<n>`。
 *
 * 这些证据必须排在代表片段/人物证据之前：非 pinned 条目在裁剪时最后丢，
 * 分歧事件自身及直接依赖事件的条目由调用方标为 pinned，永不裁剪。
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
  // 分歧事件直接依赖的事件即使不在 Impact Plan 的 reasonPath 中，也必须带上
  // 其原著证据，否则生成器无法把它们标成 pinned。仍按 Story Map 的事件顺序
  // 输出，保持渲染稳定。
  const dependencyEventIds = divergenceDependencyEventIds(
    input.storyMap,
    input.impactPlan.divergence.eventId,
  );
  const events = input.storyMap.events.filter(
    (event) =>
      related.relevantEventIds.has(event.id) ||
      dependencyEventIds.has(event.id),
  );
  return events.flatMap((event) =>
    event.evidence.map((reference, index) => ({
      id: `related:${event.id}:${index}`,
      text: [
        `[事件 ${event.id} / ${event.title} / ${reference.sourceId} ${reference.sectionId} ${reference.start}-${reference.end} / ${reference.excerptHash}]`,
        input.source.normalizedText.slice(reference.start, reference.end),
      ].join("\n"),
    })),
  );
}

/**
 * pinned 证据的确定性上限。
 *
 * 分歧事件自身及直接依赖事件可能各带很多条证据；如果全部进入必需下限，
 * 少数事件就能让任何预算都 fail closed。24 条 / 6000 字与证据选择器的
 * 历史上限同量级，足以保留分歧的最小依据，又不让必需段无界增长。
 */
export const CONTEXT_PINNED_EVIDENCE_MAX_ITEMS = 24;
export const CONTEXT_PINNED_EVIDENCE_MAX_CHARS = 6000;

/**
 * 给 pinned 证据排一个公平、确定、与 maxChars 无关的优先级。
 *
 * 选择规则：分歧事件自身的证据按原顺序优先；然后直接依赖事件按离分歧
 * 事件的 sequence 距离（越近越先，再按事件 id）轮转，每轮每个事件最多取
 * 一条。超出上限的条目只把 `pinned` 降级为 false（仍是 `canon_evidence`
 * 里的普通可裁剪证据），不会从候选列表删除。纯函数；不读取预算。
 */
export function capPinnedEvidence(input: {
  items: readonly ContextEvidenceItem[];
  storyMap: StoryMap;
  divergenceEventId: string;
}): {
  items: ContextEvidenceItem[];
  pinnedItemIds: string[];
  demotedItemIds: string[];
} {
  const pinnedIndexes = input.items
    .map((item, index) => (item.pinned ? index : -1))
    .filter((index) => index >= 0);
  if (pinnedIndexes.length === 0) {
    return {
      items: [...input.items],
      pinnedItemIds: [],
      demotedItemIds: [],
    };
  }

  const eventsById = new Map(
    input.storyMap.events.map((event) => [event.id, event]),
  );
  const divergence = eventsById.get(input.divergenceEventId);
  if (!divergence) {
    return {
      items: [...input.items],
      pinnedItemIds: pinnedIndexes.map((index) => input.items[index]!.id),
      demotedItemIds: [],
    };
  }

  const groups = new Map<string, number[]>();
  for (const index of pinnedIndexes) {
    const eventId = relatedEventIdOf(input.items[index]!.id) ?? "";
    const group = groups.get(eventId);
    if (group) group.push(index);
    else groups.set(eventId, [index]);
  }

  const dependencyOrder = [...groups.keys()]
    .filter((eventId) => eventId !== input.divergenceEventId)
    .sort((left, right) => {
      const leftDistance = divergenceDistance(
        eventsById.get(left),
        divergence.sequence,
      );
      const rightDistance = divergenceDistance(
        eventsById.get(right),
        divergence.sequence,
      );
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      return left < right ? -1 : left > right ? 1 : 0;
    });

  const selected: number[] = [];
  let selectedChars = 0;
  const select = (index: number): boolean => {
    if (selected.length >= CONTEXT_PINNED_EVIDENCE_MAX_ITEMS) return false;
    const length = input.items[index]!.text.trim().length;
    if (selectedChars + length > CONTEXT_PINNED_EVIDENCE_MAX_CHARS) {
      return false;
    }
    selected.push(index);
    selectedChars += length;
    return true;
  };

  for (const index of groups.get(input.divergenceEventId) ?? []) {
    if (selected.length >= CONTEXT_PINNED_EVIDENCE_MAX_ITEMS) break;
    select(index);
  }

  const queues = dependencyOrder.map((eventId) => ({
    indexes: [...(groups.get(eventId) ?? [])],
    cursor: 0,
  }));
  let progressed = true;
  while (progressed && selected.length < CONTEXT_PINNED_EVIDENCE_MAX_ITEMS) {
    progressed = false;
    for (const queue of queues) {
      if (selected.length >= CONTEXT_PINNED_EVIDENCE_MAX_ITEMS) break;
      // 每条事件每轮最多选一条；超长的条目跳过并尝试该事件的下一条。
      while (queue.cursor < queue.indexes.length) {
        const index = queue.indexes[queue.cursor]!;
        queue.cursor += 1;
        if (select(index)) {
          progressed = true;
          break;
        }
      }
    }
  }

  const selectedSet = new Set(selected);
  const demotedItemIds = pinnedIndexes
    .filter((index) => !selectedSet.has(index))
    .map((index) => input.items[index]!.id);
  const items = input.items.map((item, index) =>
    item.pinned && !selectedSet.has(index)
      ? { ...item, pinned: false, demotedFromPinned: true }
      : item,
  );
  return {
    items,
    // manifest 按渲染顺序记录，与 pinnedItemIds 的既有语义一致。
    pinnedItemIds: pinnedIndexes
      .filter((index) => selectedSet.has(index))
      .map((index) => input.items[index]!.id),
    demotedItemIds,
  };
}

function relatedEventIdOf(evidenceId: string): string | null {
  const match = /^related:([^:]+):/u.exec(evidenceId);
  return match?.[1] ?? null;
}

function divergenceDistance(
  event: StoryMap["events"][number] | undefined,
  divergenceSequence: number,
): number {
  if (!event) return Number.MAX_SAFE_INTEGER;
  return Math.abs(divergenceSequence - event.sequence);
}
