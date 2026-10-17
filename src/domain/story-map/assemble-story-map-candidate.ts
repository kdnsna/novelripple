import type {
  Character,
  StoryMapCandidateEdge,
  StoryMapCandidateEnding,
  StoryMapCandidateEvent,
  StoryMapContentCandidate,
  StoryMapEndingPassCandidate,
  StoryMapExtractionCandidate,
  StoryMapGleaningCandidate,
  StoryMapMergeCandidate,
  StoryMapRosterCandidate,
} from "@/domain/schemas";

/**
 * 分块 Story Map 管线的确定性组装与校验。
 *
 * 模型在每个阶段只提出候选；这里负责：
 * - 校验每个阶段的引用（Unit ID 只能来自该阶段看到的原文、人物/事件引用不能悬空）；
 * - 把各块候选汇总（ID 冲突时确定性改名）、应用人名归并、结局轮次和最终合并；
 * - 产出一个 StoryMapContentCandidate，交给现有的 Evidence 解析与领域校验（fail closed）。
 *
 * 这里不读写数据库、不调用模型、不修改 Source。
 */

export type AssemblyIssue = { path: string; message: string };

export type ChunkCandidate = {
  chunkIndex: number;
  extraction: StoryMapExtractionCandidate;
  gleaning: StoryMapGleaningCandidate;
};

export type PooledEvent = StoryMapCandidateEvent & { chunkIndex: number };

export type StoryMapPool = {
  characters: Character[];
  events: PooledEvent[];
  edges: StoryMapCandidateEdge[];
};

type LocalGraph = {
  characters: Character[];
  events: StoryMapCandidateEvent[];
  edges: StoryMapCandidateEdge[];
};

// ── 阶段校验 ──

export function validateChunkExtraction(
  extraction: StoryMapExtractionCandidate,
  allowedUnitIds: ReadonlySet<string>,
): AssemblyIssue[] {
  return validateLocalGraph(extraction, extraction, allowedUnitIds);
}

export function validateChunkGleaning(
  gleaning: StoryMapGleaningCandidate,
  extraction: StoryMapExtractionCandidate,
  allowedUnitIds: ReadonlySet<string>,
): AssemblyIssue[] {
  const issues: AssemblyIssue[] = [];
  const taken = {
    characters: new Set(extraction.characters.map((item) => item.id)),
    events: new Set(extraction.events.map((item) => item.id)),
    edges: new Set(extraction.edges.map((item) => item.id)),
  };
  for (const key of ["characters", "events", "edges"] as const) {
    gleaning[key].forEach((item, index) => {
      if (taken[key].has(item.id)) {
        issues.push({
          path: `${key}.${index}.id`,
          message: `补抽只能返回新增内容，ID 已存在：${item.id}`,
        });
      }
    });
  }
  const combined: LocalGraph = {
    characters: [...extraction.characters, ...gleaning.characters],
    events: [...extraction.events, ...gleaning.events],
    edges: [...extraction.edges, ...gleaning.edges],
  };
  issues.push(...validateLocalGraph(gleaning, combined, allowedUnitIds));
  // 补抽新增的人物也必须参与本块某个事件。
  const participants = new Set(combined.events.flatMap((event) => event.participants));
  gleaning.characters.forEach((character, index) => {
    if (!participants.has(character.id)) {
      issues.push({
        path: `characters.${index}`,
        message: `人物必须至少参与一个有 Evidence 的 Event：${character.id}`,
      });
    }
  });
  return issues;
}

function validateLocalGraph(
  graph: LocalGraph,
  scope: LocalGraph,
  allowedUnitIds: ReadonlySet<string>,
): AssemblyIssue[] {
  const issues: AssemblyIssue[] = [];
  const characterIds = new Set(scope.characters.map((item) => item.id));
  const eventIds = new Set(scope.events.map((item) => item.id));
  for (const key of ["characters", "events", "edges"] as const) {
    for (const duplicate of duplicates(graph[key].map((item) => item.id))) {
      issues.push({ path: key, message: `重复 ID：${duplicate}` });
    }
  }
  graph.events.forEach((event, index) => {
    for (const participant of event.participants) {
      if (!characterIds.has(participant)) {
        issues.push({
          path: `events.${index}.participants`,
          message: `事件引用了未知人物：${participant}`,
        });
      }
    }
    issues.push(...checkUnits(event.evidenceUnitIds, allowedUnitIds, `events.${index}.evidenceUnitIds`));
  });
  graph.edges.forEach((edge, index) => {
    if (!eventIds.has(edge.from) || !eventIds.has(edge.to)) {
      issues.push({
        path: `edges.${index}`,
        message: `因果边包含悬空引用：${edge.from} → ${edge.to}`,
      });
    }
    issues.push(...checkUnits(edge.evidenceUnitIds, allowedUnitIds, `edges.${index}.evidenceUnitIds`));
  });
  if (graph === scope) {
    const participants = new Set(graph.events.flatMap((event) => event.participants));
    graph.characters.forEach((character, index) => {
      if (!participants.has(character.id)) {
        issues.push({
          path: `characters.${index}`,
          message: `人物必须至少参与一个有 Evidence 的 Event：${character.id}`,
        });
      }
    });
  }
  return issues;
}

function checkUnits(
  unitIds: string[],
  allowedUnitIds: ReadonlySet<string>,
  path: string,
): AssemblyIssue[] {
  return unitIds
    .map((unitId, index) => ({ unitId, index }))
    .filter(({ unitId }) => !allowedUnitIds.has(unitId))
    .map(({ unitId, index }) => ({
      path: `${path}.${index}`,
      message: `Evidence 引用了本阶段未提供的 Unit：${unitId}`,
    }));
}

// ── 汇总各块 ──

/**
 * 按块顺序汇总候选。块内顺序：提取结果按模型给出的 sequence（叙事顺序），
 * 补抽事件按最早证据位置插入。不同块之间出现相同 ID 时，后出现的确定性改名为
 * `<id>__c<块序号>`，由人名轮次和最终合并决定是否同一对象。
 */
export function poolChunkCandidates(
  chunks: ChunkCandidate[],
  unitOrder: ReadonlyMap<string, number>,
): StoryMapPool {
  const used = { characters: new Set<string>(), events: new Set<string>(), edges: new Set<string>() };
  const pool: StoryMapPool = { characters: [], events: [], edges: [] };

  for (const chunk of [...chunks].sort((left, right) => left.chunkIndex - right.chunkIndex)) {
    const suffix = `__c${chunk.chunkIndex + 1}`;
    const characterIds = new Map<string, string>();
    const eventIds = new Map<string, string>();
    for (const character of [...chunk.extraction.characters, ...chunk.gleaning.characters]) {
      characterIds.set(character.id, claim(character.id, suffix, used.characters));
      pool.characters.push({ ...character, id: characterIds.get(character.id)! });
    }
    const ordered = orderChunkEvents(chunk, unitOrder);
    for (const event of ordered) {
      eventIds.set(event.id, claim(event.id, suffix, used.events));
    }
    for (const event of ordered) {
      pool.events.push({
        ...event,
        id: eventIds.get(event.id)!,
        participants: event.participants.map((id) => characterIds.get(id) ?? id),
        chunkIndex: chunk.chunkIndex,
      });
    }
    for (const edge of [...chunk.extraction.edges, ...chunk.gleaning.edges]) {
      pool.edges.push({
        ...edge,
        id: claim(edge.id, suffix, used.edges),
        from: eventIds.get(edge.from) ?? edge.from,
        to: eventIds.get(edge.to) ?? edge.to,
      });
    }
  }
  return pool;
}

function orderChunkEvents(
  chunk: ChunkCandidate,
  unitOrder: ReadonlyMap<string, number>,
): StoryMapCandidateEvent[] {
  const ordered = [...chunk.extraction.events].sort((left, right) => left.sequence - right.sequence);
  const firstUnit = (event: StoryMapCandidateEvent) =>
    Math.min(...event.evidenceUnitIds.map((id) => unitOrder.get(id) ?? Number.MAX_SAFE_INTEGER));
  for (const event of chunk.gleaning.events) {
    const position = firstUnit(event);
    const insertAt = ordered.findIndex((existing) => firstUnit(existing) > position);
    if (insertAt < 0) ordered.push(event);
    else ordered.splice(insertAt, 0, event);
  }
  return ordered;
}

function claim(id: string, suffix: string, used: Set<string>): string {
  let candidate = used.has(id) ? `${id}${suffix}` : id;
  let counter = 2;
  while (used.has(candidate)) candidate = `${id}${suffix}_${counter++}`;
  used.add(candidate);
  return candidate;
}

// ── 人名轮次 ──

export function validateRoster(
  roster: StoryMapRosterCandidate,
  pool: StoryMapPool,
): AssemblyIssue[] {
  const issues: AssemblyIssue[] = [];
  for (const duplicate of duplicates(roster.characters.map((item) => item.id))) {
    issues.push({ path: "characters", message: `重复人物 ID：${duplicate}` });
  }
  const poolIds = new Set(pool.characters.map((item) => item.id));
  const assigned = new Map<string, number>();
  roster.characters.forEach((character, index) => {
    character.mergedFrom.forEach((candidateId, mergedIndex) => {
      if (!poolIds.has(candidateId)) {
        issues.push({
          path: `characters.${index}.mergedFrom.${mergedIndex}`,
          message: `mergedFrom 引用了未知人物候选：${candidateId}`,
        });
      }
      assigned.set(candidateId, (assigned.get(candidateId) ?? 0) + 1);
    });
  });
  for (const id of poolIds) {
    const count = assigned.get(id) ?? 0;
    if (count !== 1) {
      issues.push({
        path: "characters",
        message:
          count === 0
            ? `人物候选没有归入任何人物：${id}`
            : `人物候选被归入多个人物：${id}`,
      });
    }
  }
  return issues;
}

export function applyRoster(
  pool: StoryMapPool,
  roster: StoryMapRosterCandidate,
): StoryMapPool {
  const mapping = new Map<string, string>();
  for (const character of roster.characters) {
    for (const candidateId of character.mergedFrom) mapping.set(candidateId, character.id);
  }
  return {
    characters: roster.characters.map((character) => ({
      id: character.id,
      name: character.name,
      aliases: character.aliases,
      role: character.role,
      initialState: character.initialState,
    })),
    events: pool.events.map((event) => ({
      ...event,
      participants: unique(event.participants.map((id) => mapping.get(id) ?? id)),
    })),
    edges: pool.edges,
  };
}

// ── 结局轮次 ──

export function validateEndingPass(
  pass: StoryMapEndingPassCandidate,
  pool: StoryMapPool,
  allowedUnitIds: ReadonlySet<string>,
): AssemblyIssue[] {
  const issues: AssemblyIssue[] = [];
  const characterIds = new Set(pool.characters.map((item) => item.id));
  const existingEventIds = new Set(pool.events.map((item) => item.id));
  for (const duplicate of duplicates(pass.additionalEvents.map((item) => item.id))) {
    issues.push({ path: "additionalEvents", message: `重复事件 ID：${duplicate}` });
  }
  pass.additionalEvents.forEach((event, index) => {
    if (existingEventIds.has(event.id)) {
      issues.push({ path: `additionalEvents.${index}.id`, message: `事件 ID 已存在：${event.id}` });
    }
    for (const participant of event.participants) {
      if (!characterIds.has(participant)) {
        issues.push({
          path: `additionalEvents.${index}.participants`,
          message: `事件引用了未知人物：${participant}`,
        });
      }
    }
    issues.push(...checkUnits(event.evidenceUnitIds, allowedUnitIds, `additionalEvents.${index}.evidenceUnitIds`));
  });
  const eventIds = new Set([...existingEventIds, ...pass.additionalEvents.map((item) => item.id)]);
  for (const duplicate of duplicates([
    ...pass.endings.map((item) => item.id),
    ...pass.characterEndings.map((item) => item.id),
  ])) {
    issues.push({ path: "endings", message: `重复结局 ID：${duplicate}` });
  }
  pass.endings.forEach((ending, index) => {
    if (!eventIds.has(ending.targetEventId)) {
      issues.push({ path: `endings.${index}.targetEventId`, message: `结局候选引用了未知事件：${ending.targetEventId}` });
    }
    issues.push(...checkUnits(ending.evidenceUnitIds, allowedUnitIds, `endings.${index}.evidenceUnitIds`));
  });
  pass.characterEndings.forEach((ending, index) => {
    if (!characterIds.has(ending.characterId)) {
      issues.push({ path: `characterEndings.${index}.characterId`, message: `人物结局引用了未知人物：${ending.characterId}` });
    }
    if (!eventIds.has(ending.targetEventId)) {
      issues.push({ path: `characterEndings.${index}.targetEventId`, message: `人物结局引用了未知事件：${ending.targetEventId}` });
    }
    issues.push(...checkUnits(ending.evidenceUnitIds, allowedUnitIds, `characterEndings.${index}.evidenceUnitIds`));
  });
  return issues;
}

/** 人物结局在 Story Map 中表示为带「人物结局」前缀的 Ending Candidate，不新增 Schema。 */
export const CHARACTER_ENDING_PREFIX = "【人物结局】";

export function applyEndingPass(
  pool: StoryMapPool,
  pass: StoryMapEndingPassCandidate,
): { pool: StoryMapPool; endings: StoryMapCandidateEnding[] } {
  const names = new Map(pool.characters.map((item) => [item.id, item.name]));
  const lastChunk = Math.max(0, ...pool.events.map((event) => event.chunkIndex));
  return {
    pool: {
      ...pool,
      events: [
        ...pool.events,
        ...pass.additionalEvents.map((event) => ({ ...event, chunkIndex: lastChunk + 1 })),
      ],
    },
    endings: [
      ...pass.endings,
      ...pass.characterEndings.map((ending) => ({
        id: ending.id,
        targetEventId: ending.targetEventId,
        requirement: `${CHARACTER_ENDING_PREFIX}${names.get(ending.characterId) ?? ending.characterId}：${ending.fate}`,
        evidenceUnitIds: ending.evidenceUnitIds,
      })),
    ],
  };
}

// ── 最终合并 ──

export function applyMerge(
  pool: StoryMapPool,
  endings: StoryMapCandidateEnding[],
  merge: StoryMapMergeCandidate,
):
  | { success: true; candidate: StoryMapContentCandidate }
  | { success: false; issues: AssemblyIssue[] } {
  const issues: AssemblyIssue[] = [];
  const eventIds = new Set(pool.events.map((item) => item.id));
  const duplicateOf = new Map<string, string>();
  const keepers = new Set<string>();
  merge.duplicateEventGroups.forEach((group, index) => {
    const path = `duplicateEventGroups.${index}`;
    if (!eventIds.has(group.keepEventId)) {
      issues.push({ path: `${path}.keepEventId`, message: `未知事件：${group.keepEventId}` });
    }
    if (keepers.has(group.keepEventId) || duplicateOf.has(group.keepEventId)) {
      issues.push({ path: `${path}.keepEventId`, message: `事件出现在多个合并组：${group.keepEventId}` });
    }
    keepers.add(group.keepEventId);
    for (const duplicateId of group.duplicateEventIds) {
      if (!eventIds.has(duplicateId)) {
        issues.push({ path: `${path}.duplicateEventIds`, message: `未知事件：${duplicateId}` });
      }
      if (duplicateId === group.keepEventId || duplicateOf.has(duplicateId) || keepers.has(duplicateId)) {
        issues.push({ path: `${path}.duplicateEventIds`, message: `事件出现在多个合并组：${duplicateId}` });
      }
      duplicateOf.set(duplicateId, group.keepEventId);
    }
  });
  const existingEdgeIds = new Set(pool.edges.map((item) => item.id));
  merge.edges.forEach((edge, index) => {
    if (existingEdgeIds.has(edge.id)) {
      issues.push({ path: `edges.${index}.id`, message: `边 ID 已存在：${edge.id}` });
    }
    if (!eventIds.has(edge.from) || !eventIds.has(edge.to)) {
      issues.push({ path: `edges.${index}`, message: `因果边包含悬空引用：${edge.from} → ${edge.to}` });
    }
  });
  for (const duplicate of duplicates(merge.edges.map((item) => item.id))) {
    issues.push({ path: "edges", message: `重复边 ID：${duplicate}` });
  }
  if (issues.length > 0) return { success: false, issues };

  const resolve = (id: string) => duplicateOf.get(id) ?? id;
  const merged = new Map<string, PooledEvent>();
  for (const event of pool.events) {
    const keepId = resolve(event.id);
    const existing = merged.get(keepId);
    if (keepId === event.id && !existing) {
      merged.set(keepId, { ...event });
      continue;
    }
    // 被合并的事件：证据、参与者、状态变化并入保留事件，不丢证据。
    const target = existing ?? { ...pool.events.find((item) => item.id === keepId)! };
    if (keepId === event.id) {
      merged.set(keepId, {
        ...event,
        evidenceUnitIds: unique([...event.evidenceUnitIds, ...target.evidenceUnitIds]),
        participants: unique([...event.participants, ...target.participants]),
        stateChanges: unique([...event.stateChanges, ...target.stateChanges]),
      });
    } else {
      merged.set(keepId, {
        ...target,
        evidenceUnitIds: unique([...target.evidenceUnitIds, ...event.evidenceUnitIds]),
        participants: unique([...target.participants, ...event.participants]),
        stateChanges: unique([...target.stateChanges, ...event.stateChanges]),
      });
    }
  }
  const orderedIds = unique(pool.events.map((event) => resolve(event.id)));
  const events = orderedIds.map((id, index) => {
    const { chunkIndex: _chunkIndex, ...event } = merged.get(id)!;
    void _chunkIndex;
    return { ...event, sequence: index + 1 };
  });

  const seenEdges = new Set<string>();
  const edges: StoryMapCandidateEdge[] = [];
  for (const edge of [...pool.edges, ...merge.edges]) {
    const from = resolve(edge.from);
    const to = resolve(edge.to);
    const key = `${from}|${to}|${edge.type}`;
    if (from === to || seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({ ...edge, from, to });
  }

  const seenEndings = new Set<string>();
  const endingCandidates = endings
    .map((ending) => ({ ...ending, targetEventId: resolve(ending.targetEventId) }))
    .filter((ending) => {
      const key = `${ending.targetEventId}|${ending.requirement}`;
      if (seenEndings.has(key)) return false;
      seenEndings.add(key);
      return true;
    });

  return {
    success: true,
    candidate: {
      title: merge.title,
      logline: merge.logline,
      characters: pool.characters,
      events,
      edges,
      endingCandidates,
    },
  };
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const result = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) result.add(value);
    seen.add(value);
  }
  return [...result];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
