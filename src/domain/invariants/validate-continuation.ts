import {
  ImpactPlanSchema,
  StoryMapSchema,
  WorldlineDeltaSchema,
  WorldlineSchema,
  type ContinuationDirectionsModelOutput,
  type ImpactPlan,
  type StatePatch,
  type StoryMap,
  type Worldline,
  type WorldlineDelta,
} from "@/domain/schemas";
import type { DomainValidationIssue } from "@/domain/invariants/validate-story-map";

export function deriveWorldlineDelta(input: {
  worldline: Worldline;
  impactPlan: ImpactPlan;
  storyMap: StoryMap;
}): WorldlineDelta {
  const worldline = WorldlineSchema.parse(input.worldline);
  const impactPlan = ImpactPlanSchema.parse(input.impactPlan);
  const storyMap = StoryMapSchema.parse(input.storyMap);
  if (
    worldline.status !== "active" ||
    worldline.acceptedImpactPlanId !== impactPlan.id ||
    impactPlan.status !== "accepted" ||
    impactPlan.storyMapId !== storyMap.id ||
    JSON.stringify(worldline.divergence) !== JSON.stringify(impactPlan.divergence)
  ) {
    throw new Error("Worldline Delta 必须绑定同一 accepted Impact Plan 与 Story Map");
  }

  const eventsById = new Map(storyMap.events.map((event) => [event.id, event]));
  const factsRemoved = new Set<string>();
  const factsAdded = new Map<string, { key: string; statement: string }>();
  const divergenceEvent = eventsById.get(impactPlan.divergence.eventId);
  if (!divergenceEvent) throw new Error("Divergence 引用了未知 Story Map Event");
  factsRemoved.add(eventFactKey(divergenceEvent.id));
  if (impactPlan.divergence.type !== "prevent") {
    const key = `divergence:${impactPlan.divergence.id}`;
    factsAdded.set(key, { key, statement: impactPlan.divergence.instruction });
  }

  for (const impact of impactPlan.impacts) {
    if (
      impact.affectedEventId &&
      (impact.changeType === "removed" || impact.changeType === "modified")
    ) {
      factsRemoved.add(eventFactKey(impact.affectedEventId));
    }
    if (impact.changeType === "added" || impact.changeType === "modified") {
      const key = `impact:${impact.id}`;
      factsAdded.set(key, { key, statement: impact.summary });
    }
  }

  return WorldlineDeltaSchema.parse({
    factsAdded: [...factsAdded.values()],
    factsRemoved: [...factsRemoved],
    characterChanges: impactPlan.characterChanges,
    threadsOpened: impactPlan.threadChanges.opened,
    threadsClosed: impactPlan.threadChanges.closed,
  });
}

export function validateContinuationDirections(
  output: ContinuationDirectionsModelOutput,
  storyMap: StoryMap,
): DomainValidationIssue[] {
  const issues: DomainValidationIssue[] = [];
  const characterIds = new Set(storyMap.characters.map((character) => character.id));
  const titles = new Set<string>();

  for (const [directionIndex, direction] of output.directions.entries()) {
    if (titles.has(direction.title)) {
      issues.push({
        path: `directions.${directionIndex}.title`,
        message: `后续方向标题重复：${direction.title}`,
      });
    }
    titles.add(direction.title);
    const seenCharacters = new Set<string>();
    for (const [characterIndex, characterId] of direction.affectedCharacterIds.entries()) {
      const path = `directions.${directionIndex}.affectedCharacterIds.${characterIndex}`;
      if (!characterIds.has(characterId)) {
        issues.push({ path, message: `后续方向引用了未知人物：${characterId}` });
      }
      if (seenCharacters.has(characterId)) {
        issues.push({ path, message: `后续方向重复引用人物：${characterId}` });
      }
      seenCharacters.add(characterId);
    }
  }

  return issues;
}

export function validateContinuationStatePatch(
  patch: StatePatch,
  currentDelta: WorldlineDelta,
  storyMap: StoryMap,
  divergenceEventId: string,
  protectedAnchorEventIds: string[],
): DomainValidationIssue[] {
  const issues: DomainValidationIssue[] = [];
  const removedFactKeys = new Set(currentDelta.factsRemoved);
  const currentFactKeys = new Set(currentDelta.factsAdded.map((fact) => fact.key));
  const eventsById = new Map(storyMap.events.map((event) => [event.id, event]));
  const eventIds = new Set(eventsById.keys());
  const divergenceEvent = eventsById.get(divergenceEventId);
  const protectedAnchors = new Set(protectedAnchorEventIds);
  const characterIds = new Set(storyMap.characters.map((character) => character.id));
  const openThreads = new Set(currentDelta.threadsOpened);
  for (const thread of currentDelta.threadsClosed) openThreads.delete(thread);

  if (!divergenceEvent) {
    issues.push({
      path: "divergenceEventId",
      message: `Continuation 引用了未知 Divergence Event：${divergenceEventId}`,
    });
  }
  for (const anchorEventId of protectedAnchors) {
    if (!eventIds.has(anchorEventId)) {
      issues.push({
        path: "protectedAnchorEventIds",
        message: `Continuation 引用了未知 Anchor Event：${anchorEventId}`,
      });
    }
  }

  for (const [index, fact] of patch.factsAdded.entries()) {
    if (!fact.key.startsWith("generated:")) {
      issues.push({
        path: `factsAdded.${index}.key`,
        message: `Continuation 新事实必须使用 generated: 命名空间：${fact.key}`,
      });
    }
    if (removedFactKeys.has(fact.key)) {
      issues.push({
        path: `factsAdded.${index}.key`,
        message: `Continuation 不得恢复已删除事实：${fact.key}`,
      });
    }
    if (currentFactKeys.has(fact.key)) {
      issues.push({
        path: `factsAdded.${index}.key`,
        message: `Continuation 不得重复新增当前事实：${fact.key}`,
      });
    }
  }

  for (const [index, factKey] of patch.factsRemoved.entries()) {
    if (removedFactKeys.has(factKey)) {
      issues.push({
        path: `factsRemoved.${index}`,
        message: `Continuation 不得重复删除已删除事实：${factKey}`,
      });
    }
    const eventId = factKey.startsWith("event:") ? factKey.slice(6) : null;
    const event = eventId === null ? undefined : eventsById.get(eventId);
    if (factKey.startsWith("impact:") || factKey.startsWith("divergence:")) {
      issues.push({
        path: `factsRemoved.${index}`,
        message: `Continuation 不得删除 accepted ImpactPlan 拥有的 Worldline Delta 事实：${factKey}`,
      });
    }
    if (eventId !== null && protectedAnchors.has(eventId)) {
      issues.push({
        path: `factsRemoved.${index}`,
        message: `Continuation 不得删除严格模式 Anchor 目标：${factKey}`,
      });
    }
    if (
      (eventId !== null && !eventIds.has(eventId)) ||
      (eventId === null && !currentFactKeys.has(factKey))
    ) {
      issues.push({
        path: `factsRemoved.${index}`,
        message: `Continuation 删除了当前状态中不存在的事实：${factKey}`,
      });
    }
    if (
      event &&
      divergenceEvent &&
      event.sequence < divergenceEvent.sequence
    ) {
      issues.push({
        path: `factsRemoved.${index}`,
        message: `Continuation 不得删除分歧前 Canon 事实：${factKey}`,
      });
    }
  }

  for (const [index, change] of patch.characterChanges.entries()) {
    if (!characterIds.has(change.characterId)) {
      issues.push({
        path: `characterChanges.${index}.characterId`,
        message: `Continuation 人物变化引用了未知人物：${change.characterId}`,
      });
    }
  }

  for (const [index, thread] of patch.threadsOpened.entries()) {
    if (openThreads.has(thread)) {
      issues.push({
        path: `threadsOpened.${index}`,
        message: `Continuation 不能重复开启当前线索：${thread}`,
      });
    }
  }
  for (const [index, thread] of patch.threadsClosed.entries()) {
    if (!openThreads.has(thread)) {
      issues.push({
        path: `threadsClosed.${index}`,
        message: `Continuation 不能关闭尚未开启的线索：${thread}`,
      });
    }
  }

  return issues;
}

function eventFactKey(eventId: string): string {
  return `event:${eventId}`;
}
