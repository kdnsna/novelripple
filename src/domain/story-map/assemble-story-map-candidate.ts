import type {
  Character,
  StoryMapCandidateCharacter,
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
import { isCollectiveName } from "@/domain/source/name-candidates";

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

/**
 * 池中人物：抽取/补抽候选带 kind，人名归并后变为最终 Character（不再带 kind）。
 */
export type PooledCharacter = Character & {
  kind?: StoryMapCandidateCharacter["kind"];
};

export type StoryMapPool = {
  characters: PooledCharacter[];
  events: PooledEvent[];
  edges: StoryMapCandidateEdge[];
};

type LocalGraph = {
  characters: PooledCharacter[];
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
  // 补抽新增的人物也必须参与本块某个事件；群体候选随后会在人名轮前被丢弃，
  // 不要求它出现在事件参与者里。
  const participants = new Set(combined.events.flatMap((event) => event.participants));
  gleaning.characters.forEach((character, index) => {
    if (!participants.has(character.id) && !isGroupCharacter(character)) {
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
      if (!participants.has(character.id) && !isGroupCharacter(character)) {
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

// ── 群体过滤 ──

/**
 * 群体 / 家族 / 机构候选：模型标为 group，或名字呈确定性群体特征。
 * 安全网不依赖提示词是否被遵守。
 */
export function isGroupCharacter(
  character: Pick<PooledCharacter, "name" | "kind">,
): boolean {
  return character.kind === "group" || isCollectiveName(character.name);
}

/**
 * 从池中丢弃指定人物候选，并从事件参与者中移除。
 * 最小例外：某事件只剩被丢弃的参与者时，保留第一个，避免事件失去全部参与者。
 */
export function dropCandidates(
  pool: StoryMapPool,
  droppedIds: ReadonlySet<string>,
): StoryMapPool {
  if (droppedIds.size === 0) return pool;
  const keptIds = new Set<string>();
  const events = pool.events.map((event) => {
    const participants = event.participants.filter((id) => !droppedIds.has(id));
    if (participants.length === 0 && event.participants.length > 0) {
      const kept = event.participants[0]!;
      keptIds.add(kept);
      return { ...event, participants: [kept] };
    }
    return participants.length === event.participants.length
      ? event
      : { ...event, participants };
  });
  return {
    ...pool,
    characters: pool.characters.filter(
      (character) => !droppedIds.has(character.id) || keptIds.has(character.id),
    ),
    events,
  };
}

/**
 * 在人名归并前丢弃群体候选，并从事件参与者中移除。
 * 最小例外：某事件只剩群体参与者时，保留第一个群体，避免事件失去全部参与者。
 */
export function dropGroupCandidates(pool: StoryMapPool): StoryMapPool {
  return dropCandidates(
    pool,
    new Set(pool.characters.filter(isGroupCharacter).map((character) => character.id)),
  );
}

/**
 * 人名轮允许拒绝的候选：漏网的群体/家族/机构，以及没有参与任何事件、
 * 只被提到或评论的候选（作者叙事者、路人传闻等）。参与事件的具体个体即使
 * 无名、只短暂出现或处于边缘，也必须合并为 `role: "minor"`，不能通过
 * `rejectedCandidateIds` 丢掉；拒绝列表只删除真正可拒绝的候选，不降级。
 */
export function canRejectRosterCandidate(
  candidate: Pick<PooledCharacter, "id" | "name" | "kind">,
  eventParticipants: ReadonlySet<string>,
): boolean {
  if (isGroupCharacter(candidate)) return true;
  return !eventParticipants.has(candidate.id);
}

export function validateRoster(
  roster: StoryMapRosterCandidate,
  pool: StoryMapPool,
): AssemblyIssue[] {
  const issues: AssemblyIssue[] = [];
  for (const duplicate of duplicates(roster.characters.map((item) => item.id))) {
    issues.push({ path: "characters", message: `重复人物 ID：${duplicate}` });
  }
  const poolIds = new Set(pool.characters.map((item) => item.id));
  const poolById = new Map(pool.characters.map((item) => [item.id, item]));
  const assigned = new Map<string, number>();
  roster.characters.forEach((character, index) => {
    character.mergedFrom.forEach((candidateId, mergedIndex) => {
      const candidate = poolById.get(candidateId);
      if (!candidate) {
        issues.push({
          path: `characters.${index}.mergedFrom.${mergedIndex}`,
          message: `mergedFrom 引用了未知人物候选：${candidateId}`,
        });
      } else {
        const candidateName = normalizeRosterName(candidate.name);
        const mergedName = normalizeRosterName(character.name);
        const aliases = character.aliases.map(normalizeRosterName);
        if (candidateName !== mergedName && !aliases.includes(candidateName)) {
          issues.push({
            path: `characters.${index}.mergedFrom.${mergedIndex}`,
            message:
              `合并候选取名不一致：${candidateId} 的 name 是“${candidate.name}”，` +
              `合并后人物是“${character.name}”；候选名必须等于 name 或出现在 aliases 中`,
          });
        }
      }
      assigned.set(candidateId, (assigned.get(candidateId) ?? 0) + 1);
    });
  });
  roster.rejectedCandidateIds.forEach((candidateId, index) => {
    const candidate = poolById.get(candidateId);
    if (!candidate) {
      issues.push({
        path: `rejectedCandidateIds.${index}`,
        message: `rejectedCandidateIds 引用了未知人物候选：${candidateId}`,
      });
    }
    // 不能拒绝的具体人物不再报错：applyRoster 会确定性地降级为 minor 人物。
    assigned.set(candidateId, (assigned.get(candidateId) ?? 0) + 1);
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
  const rosterIds = new Set(roster.characters.map((character) => character.id));
  const poolById = new Map(pool.characters.map((character) => [character.id, character]));
  const eventParticipants = new Set(
    pool.events.flatMap((event) => event.participants),
  );
  const rejectedIds = new Set<string>();
  const demotedRejected: StoryMapPool["characters"] = [];
  for (const candidateId of new Set(roster.rejectedCandidateIds)) {
    const candidate = poolById.get(candidateId);
    if (!candidate) continue;
    if (canRejectRosterCandidate(candidate, eventParticipants)) {
      rejectedIds.add(candidateId);
      continue;
    }
    // 不能拒绝的具体人物确定性地降级为独立 minor 人物，保留名字与别名；
    // 其事件参与关系也保持不变。
    if (rosterIds.has(candidateId)) continue;
    const { kind: _kind, ...character } = candidate;
    void _kind;
    demotedRejected.push({ ...character, role: "minor" });
  }
  // 只移除真正可拒绝的候选；只剩被拒参与者的事件按最小例外保留第一个。
  const withoutRejected = dropCandidates(pool, rejectedIds);
  const keptRejected = withoutRejected.characters
    .filter((character) => rejectedIds.has(character.id))
    .map(({ kind: _kind, ...character }) => {
      void _kind;
      return character;
    });
  return {
    characters: [
      ...roster.characters.map((character) => ({
        id: character.id,
        name: character.name,
        aliases: collectMergedAliases(character, poolById),
        role: character.role,
        initialState: character.initialState,
      })),
      ...demotedRejected,
      ...keptRejected,
    ],
    events: withoutRejected.events.map((event) => ({
      ...event,
      participants: unique(event.participants.map((id) => mapping.get(id) ?? id)),
    })),
    edges: pool.edges,
  };
}

/** 最终人物的别名上限；人名轮给出的别名优先保留。 */
export const MAX_CHARACTER_ALIASES = 12;

/**
 * 合并后人物的别名 = 人名轮别名 ∪ 每个 mergedFrom 候选的 name 与 aliases。
 * 保持出现顺序，按人名比较键去重；去掉空串、与最终 name 等价的写法和群体名。
 */
function collectMergedAliases(
  character: StoryMapRosterCandidate["characters"][number],
  poolById: ReadonlyMap<string, PooledCharacter>,
): string[] {
  const seen = new Set([normalizeRosterName(character.name)]);
  const aliases: string[] = [];
  const push = (value: string) => {
    if (aliases.length >= MAX_CHARACTER_ALIASES) return;
    const alias = value.trim();
    if (!alias || isCollectiveName(alias)) return;
    const key = normalizeRosterName(alias);
    if (seen.has(key)) return;
    seen.add(key);
    aliases.push(alias);
  };
  for (const alias of character.aliases) push(alias);
  for (const candidateId of character.mergedFrom) {
    const candidate = poolById.get(candidateId);
    if (!candidate) continue;
    push(candidate.name);
    for (const alias of candidate.aliases) push(alias);
  }
  return aliases;
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
  // 合并轮只能引用它本轮看到的事件、已有边和结局的证据 Unit；全书存在不算数。
  const allowedUnitIds = new Set([
    ...pool.events.flatMap((event) => event.evidenceUnitIds),
    ...pool.edges.flatMap((edge) => edge.evidenceUnitIds),
    ...endings.flatMap((ending) => ending.evidenceUnitIds),
  ]);
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
  const endingIds = new Set(endings.map((item) => item.id));
  const duplicateEndingOf = new Map<string, string>();
  const endingKeepers = new Set<string>();
  merge.duplicateEndingGroups.forEach((group, index) => {
    const path = `duplicateEndingGroups.${index}`;
    if (!endingIds.has(group.keepEndingId)) {
      issues.push({ path: `${path}.keepEndingId`, message: `未知结局候选：${group.keepEndingId}` });
    }
    if (endingKeepers.has(group.keepEndingId) || duplicateEndingOf.has(group.keepEndingId)) {
      issues.push({ path: `${path}.keepEndingId`, message: `结局候选出现在多个合并组：${group.keepEndingId}` });
    }
    endingKeepers.add(group.keepEndingId);
    for (const duplicateId of group.duplicateEndingIds) {
      if (!endingIds.has(duplicateId)) {
        issues.push({ path: `${path}.duplicateEndingIds`, message: `未知结局候选：${duplicateId}` });
      }
      if (
        duplicateId === group.keepEndingId ||
        duplicateEndingOf.has(duplicateId) ||
        endingKeepers.has(duplicateId)
      ) {
        issues.push({ path: `${path}.duplicateEndingIds`, message: `结局候选出现在多个合并组：${duplicateId}` });
      }
      duplicateEndingOf.set(duplicateId, group.keepEndingId);
    }
  });
  merge.edges.forEach((edge, index) => {
    if (existingEdgeIds.has(edge.id)) {
      issues.push({ path: `edges.${index}.id`, message: `边 ID 已存在：${edge.id}` });
    }
    if (!eventIds.has(edge.from) || !eventIds.has(edge.to)) {
      issues.push({ path: `edges.${index}`, message: `因果边包含悬空引用：${edge.from} → ${edge.to}` });
    }
    issues.push(...checkUnits(edge.evidenceUnitIds, allowedUnitIds, `edges.${index}.evidenceUnitIds`));
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

  // 同一 (from, to) 的边折叠为一条：保留最早出现的类型/说明，证据取并集。
  const edges = dedupeEdges([...pool.edges, ...merge.edges], resolve);

  // 显式结局合并组先按“保留项文字 + 全组证据”归并，再做同目标同要求/同人物结局去重。
  const endingById = new Map(endings.map((ending) => [ending.id, ending]));
  const endingGroupEvidence = new Map<string, string[]>();
  for (const group of merge.duplicateEndingGroups) {
    const keeper = endingById.get(group.keepEndingId)!;
    const members = [keeper, ...group.duplicateEndingIds.map((id) => endingById.get(id)!)];
    endingGroupEvidence.set(
      group.keepEndingId,
      unique(members.flatMap((ending) => ending.evidenceUnitIds)),
    );
  }
  const endingsBeforeDedupe: StoryMapCandidateEnding[] = [];
  for (const ending of endings) {
    if (duplicateEndingOf.has(ending.id)) continue;
    const evidence = endingGroupEvidence.get(ending.id);
    endingsBeforeDedupe.push({
      ...ending,
      targetEventId: resolve(ending.targetEventId),
      ...(evidence ? { evidenceUnitIds: evidence } : {}),
    });
  }
  const endingCandidates = dedupeEndings(endingsBeforeDedupe);

  return {
    success: true,
    candidate: cleanupCandidateIds({
      title: merge.title,
      logline: merge.logline,
      characters: pool.characters,
      events,
      edges,
      endingCandidates,
    }),
  };
}

/**
 * 合并后去重因果边：丢弃自环（含端点经事件合并后相同的边）；同一
 * (from, to, type) 只保留第一条边的说明，证据按出现顺序取并集。
 * 不同 type 各自保留，避免 enables / foreshadows 被 causes 吞掉。
 */
export function dedupeEdges(
  edges: readonly StoryMapCandidateEdge[],
  resolveEventId: (id: string) => string = (id) => id,
): StoryMapCandidateEdge[] {
  const seen = new Map<string, StoryMapCandidateEdge>();
  const result: StoryMapCandidateEdge[] = [];
  for (const edge of edges) {
    const from = resolveEventId(edge.from);
    const to = resolveEventId(edge.to);
    if (from === to) continue;
    const key = `${from}|${to}|${edge.type}`;
    const existing = seen.get(key);
    if (existing) {
      existing.evidenceUnitIds = unique([...existing.evidenceUnitIds, ...edge.evidenceUnitIds]);
      continue;
    }
    const kept = { ...edge, from, to };
    seen.set(key, kept);
    result.push(kept);
  }
  return result;
}

/**
 * 结局去重：
 * - 故事级结局只在 `targetEventId` 相同且规范化后的 `requirement` 文本相同时折叠，
 *   证据取并集；同一目标事件下的不同结局（例如不同人物的去向）各自保留；
 * - 人物结局按 `【人物结局】<name>：` 中的人物名折叠，每个名字只保留第一条。
 */
export function dedupeEndings(
  endings: readonly StoryMapCandidateEnding[],
  resolveEventId: (id: string) => string = (id) => id,
): StoryMapCandidateEnding[] {
  const storyEndings = new Map<string, StoryMapCandidateEnding>();
  const characterEndings = new Map<string, StoryMapCandidateEnding>();
  const result: StoryMapCandidateEnding[] = [];
  for (const ending of endings) {
    const resolved = { ...ending, targetEventId: resolveEventId(ending.targetEventId) };
    const characterName = characterEndingName(ending.requirement);
    const bucket = characterName === null ? storyEndings : characterEndings;
    const key =
      characterName === null
        ? `${resolved.targetEventId}\u0000${normalizeEndingRequirement(resolved.requirement)}`
        : characterName;
    const existing = bucket.get(key);
    if (existing) {
      existing.evidenceUnitIds = unique([...existing.evidenceUnitIds, ...resolved.evidenceUnitIds]);
      continue;
    }
    bucket.set(key, resolved);
    result.push(resolved);
  }
  return result;
}

/** 结局要求文本的确定性比较键：去首尾空白、折叠空白、去掉句末标点。 */
function normalizeEndingRequirement(requirement: string): string {
  return requirement
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\s。．.！!？?；;，,、…~～]+$/u, "");
}

function characterEndingName(requirement: string): string | null {
  if (!requirement.startsWith(CHARACTER_ENDING_PREFIX)) return null;
  const rest = requirement.slice(CHARACTER_ENDING_PREFIX.length);
  const separator = rest.indexOf("：");
  if (separator <= 0) return null;
  return rest.slice(0, separator).trim();
}

/**
 * 去掉汇总阶段为块内冲突 ID 加的 `__c<chunk>` 后缀，并重写所有引用。
 * 无后缀 ID 先保留原值（如合法的 `a-2`）；后缀 ID 再占用裸 ID，被占用时
 * 依次改为 `<id>-2`、`<id>-3`…，并跳过所有已使用的 ID。
 */
export function cleanupCandidateIds(
  candidate: StoryMapContentCandidate,
): StoryMapContentCandidate {
  const characterIds = assignFinalIds(candidate.characters.map((item) => item.id));
  const eventIds = assignFinalIds(candidate.events.map((item) => item.id));
  const edgeIds = assignFinalIds(candidate.edges.map((item) => item.id));
  const endingIds = assignFinalIds(candidate.endingCandidates.map((item) => item.id));
  return {
    ...candidate,
    characters: candidate.characters.map((character) => ({
      ...character,
      id: characterIds.get(character.id)!,
    })),
    events: candidate.events.map((event) => ({
      ...event,
      id: eventIds.get(event.id)!,
      participants: unique(event.participants.map((id) => characterIds.get(id) ?? id)),
    })),
    edges: candidate.edges.map((edge) => ({
      ...edge,
      id: edgeIds.get(edge.id)!,
      from: eventIds.get(edge.from) ?? edge.from,
      to: eventIds.get(edge.to) ?? edge.to,
    })),
    endingCandidates: candidate.endingCandidates.map((ending) => ({
      ...ending,
      id: endingIds.get(ending.id)!,
      targetEventId: eventIds.get(ending.targetEventId) ?? ending.targetEventId,
    })),
  };
}

function assignFinalIds(ids: readonly string[]): Map<string, string> {
  const used = new Set<string>();
  const mapping = new Map<string, string>();
  const hasChunkSuffix = (id: string) => /__c\d+(?:_\d+)?$/.test(id);

  // 先保留所有本来就没有块后缀的 ID（包括合法的 `a-2`），再加后缀 ID。
  for (const id of ids) {
    if (hasChunkSuffix(id)) continue;
    let candidate = id;
    let counter = 2;
    while (used.has(candidate)) candidate = `${id}-${counter++}`;
    used.add(candidate);
    mapping.set(id, candidate);
  }
  for (const id of ids) {
    if (!hasChunkSuffix(id)) continue;
    const bare = id.replace(/__c\d+(?:_\d+)?$/, "");
    let candidate = bare;
    let counter = 2;
    while (used.has(candidate)) candidate = `${bare}-${counter++}`;
    used.add(candidate);
    mapping.set(id, candidate);
  }
  return mapping;
}

/** 人名比较键：NFKC 统一全/半角，忽略大小写与多余空白。 */
function normalizeRosterName(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
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
