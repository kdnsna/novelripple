import {
  derivePathState,
  mergeCharacterChange,
  type SceneNode,
} from "@/domain/continuation/scene-tree";
import type {
  CharacterStatus,
  Divergence,
  StoryMap,
  WorldlineCharacterStatusOverride,
  WorldlineDelta,
} from "@/domain/schemas";

/** 人物状态的来源；Prompt 与界面共用同一套标签。 */
export type CharacterStatusSource =
  | "source_inference"
  | "impact"
  | "scene"
  | "reader"
  | "default";

export type CharacterStatusHistoryEntry = {
  sourceKind: "divergence" | "scene";
  sceneId: string | null;
  depth: number;
  summary: string;
  /** 该条变化显式携带的状态；未改变状态时缺省。 */
  status?: CharacterStatus;
};

export type DerivedCharacterStatus = {
  characterId: string;
  name: string;
  status: CharacterStatus;
  source: CharacterStatusSource;
  sourceSceneId: string | null;
  /** 来源场景在路径上的深度；分歧点/默认来源为 null。 */
  sourceDepth: number | null;
  summary: string | null;
  history: CharacterStatusHistoryEntry[];
};

export type SourceBaselineStatus = {
  status: "dead";
  source: "source_inference";
  eventId: string;
};

const DEATH_KEYWORDS = [
  "死亡",
  "死了",
  "去世",
  "身亡",
  "遇难",
  "病故",
  "病死",
  "牺牲",
  "被杀",
  "丧命",
  "过世",
  "亡故",
  "殉",
  "毙命",
  "自尽",
  "溺亡",
] as const;

const NEGATED_DEATH_KEYWORDS = [
  "没死",
  "未死",
  "不死",
  "假死",
  "装死",
  "诈死",
  "险些",
  "差点",
] as const;

/**
 * 从「分歧点之前、有证据的 fact 事件」推断原著人物基线状态。
 *
 * 这是确定性启发式，不调用模型：
 * - 只在 Story Map 已 confirmed 时推断；草稿/候选一律不推断；
 * - 只读 `sequence < 分歧事件.sequence` 的事件，分歧事件自身与之后事件
 *   都不参与；
 * - 只看 `evidenceKind === "fact"` 且 evidence 非空的事件；
 * - 只有事件**恰好一名参与者**时才可能归因：多人事件一律 unknown，即使
 *   stateChange 点名了其中一人。当前 Event Schema 没有结构化的「死者」
 *   字段（`stateChanges` 是自由文本），因此无法可靠地从多人事件中挑出
 *   被推断者；未来若新增该字段，可以在那一分支使用，而不是解析自由文本；
 * - 单一参与者事件中，某条 stateChange 需包含死亡关键词且不含否定/假死
 *   措辞；若同一句还整词提到**其他**角色，死亡可能属于别人，跳过；
 * - 以上所有命中只用于让推断更保守。
 *
 * 只返回基线为 dead 的人物；其余人物由调用方默认为 unknown。
 */
export function deriveSourceBaselineStatuses(input: {
  storyMap: StoryMap;
  divergence: Divergence;
}): Map<string, SourceBaselineStatus> {
  const { storyMap, divergence } = input;
  const divergenceEvent = storyMap.events.find(
    (event) => event.id === divergence.eventId,
  );
  if (!divergenceEvent) {
    throw new Error(`分歧事件不在当前 Story Map 中：${divergence.eventId}`);
  }

  const result = new Map<string, SourceBaselineStatus>();
  // 未确认的 Story Map 还可能被改写；宁可全部 unknown，也不把草稿当原著。
  if (storyMap.status !== "confirmed") return result;

  const charactersById = new Map(
    storyMap.characters.map((character) => [character.id, character]),
  );
  const characterNames = storyMap.characters.map((character) => ({
    characterId: character.id,
    names: [character.name, ...character.aliases].filter(
      (name) => name.length > 0,
    ),
  }));
  const events = [...storyMap.events]
    .filter(
      (event) =>
        event.sequence < divergenceEvent.sequence &&
        event.evidenceKind === "fact" &&
        event.evidence.length > 0,
    )
    .sort((left, right) => left.sequence - right.sequence);

  for (const event of events) {
    // 多人事件没有结构化归因；任何“谁死了”的猜测都可能把活人标死。
    if (event.participants.length !== 1) continue;
    const [participant] = event.participants;
    if (!charactersById.has(participant)) continue;

    for (const stateChange of event.stateChanges) {
      if (!hasDeathKeyword(stateChange)) continue;
      if (hasNegatedDeathKeyword(stateChange)) continue;
      if (mentionsOtherCharacter(stateChange, participant)) continue;
      result.set(participant, {
        status: "dead",
        source: "source_inference",
        eventId: event.id,
      });
      break;
    }
  }

  /**
   * 歧义守卫：stateChange 若整词提到其他角色，死亡可能不是单一参与者的。
   * 对每个其他角色，用「其余角色」的姓名作为更长姓名边界，避免把
   * 「张三」误当成「张三丰」的命中。
   */
  function mentionsOtherCharacter(
    stateChange: string,
    participant: string,
  ): boolean {
    return characterNames.some((entry) => {
      if (entry.characterId === participant) return false;
      const longerNames = characterNames
        .filter((other) => other.characterId !== entry.characterId)
        .flatMap((other) => other.names);
      return entry.names.some((name) =>
        mentionsWholeWord(stateChange, name, longerNames),
      );
    });
  }

  return result;
}

/**
 * 整词姓名匹配；只用于让死亡推断更保守，命中不会放宽任何规则。
 *
 * - 少于 2 个码点的姓名/别名永不命中（中文单字名歧义过大）；
 * - 命中不得落在 `otherCharacterNames` 中某个更长姓名/别名的内部：
 *   「张三」不算命中「张三丰」（当「张三丰」属于另一个角色时）；
 * - ASCII 姓名要求两侧不是字母/数字：`Li` 不算命中 `Lily`。
 */
export function mentionsWholeWord(
  text: string,
  name: string,
  otherCharacterNames: readonly string[] = [],
): boolean {
  if (Array.from(name).length < 2) return false;
  const longerNames = otherCharacterNames.filter(
    (other) =>
      other !== name && Array.from(other).length > Array.from(name).length,
  );
  const requireAsciiBoundary = /^[\x00-\x7f]+$/.test(name);

  let from = 0;
  while (from <= text.length - name.length) {
    const start = text.indexOf(name, from);
    if (start === -1) return false;
    const end = start + name.length;
    const isMatch =
      (!requireAsciiBoundary || hasAsciiBoundaries(text, start, end)) &&
      !longerNames.some((longer) =>
        overlapsOccurrence(text, longer, start, end),
      );
    if (isMatch) return true;
    from = start + 1;
  }
  return false;
}

function hasAsciiBoundaries(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : "";
  const after = end < text.length ? text[end] : "";
  return !/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after);
}

/** longer 是否在 [start, end) 范围内出现，从而覆盖短名命中。 */
function overlapsOccurrence(
  text: string,
  longer: string,
  start: number,
  end: number,
): boolean {
  let from = 0;
  while (from <= text.length - longer.length) {
    const index = text.indexOf(longer, from);
    if (index === -1) return false;
    if (index < end && index + longer.length > start) return true;
    from = index + 1;
  }
  return false;
}

/**
 * 沿当前路径派生人物状态，是 UI 与生成 Prompt 的唯一折叠入口。
 *
 * 折叠顺序：
 * 1. 原著基线（分歧前 fact 事件的死亡推断）；
 * 2. `baseDelta`（Impact Plan 只有 summary，没有 status）；
 * 3. 锚在分歧点的读者覆盖；
 * 4. 路径上的每个场景：先折叠 statePatch（显式非 null status 生效，
 *    null/缺省保留旧值），再应用锚在该场景的读者覆盖。
 *
 * 路径本身仍由 `derivePathState` 校验；断裂、跨世界线或非法补丁都会抛错。
 * 只读取给定路径，兄弟分支的覆盖与状态不会泄漏。
 */
export function derivePathCharacterStatuses(input: {
  storyMap: StoryMap;
  divergence: Divergence;
  baseDelta: WorldlineDelta;
  path: readonly SceneNode[];
  overrides: readonly WorldlineCharacterStatusOverride[];
}): DerivedCharacterStatus[] {
  const { storyMap, divergence, baseDelta, path, overrides } = input;
  // 先完整校验路径与补丁，再派生状态。
  const finalState = derivePathState(baseDelta, path);
  const baseline = deriveSourceBaselineStatuses({ storyMap, divergence });
  const historyByCharacter = collectPathCharacterHistory(baseDelta, path);
  const summaryById = new Map(
    finalState.characterChanges.map((change) => [
      change.characterId,
      change.summary,
    ]),
  );

  type StatusEntry = {
    status: CharacterStatus;
    source: CharacterStatusSource;
    sourceSceneId: string | null;
    sourceDepth: number | null;
  };
  const statusById = new Map<string, StatusEntry>();
  const defaultEntry: StatusEntry = {
    status: "unknown",
    source: "default",
    sourceSceneId: null,
    sourceDepth: null,
  };

  for (const character of storyMap.characters) {
    const baselineStatus = baseline.get(character.id);
    statusById.set(
      character.id,
      baselineStatus
        ? {
            status: baselineStatus.status,
            source: baselineStatus.source,
            sourceSceneId: null,
            sourceDepth: null,
          }
        : defaultEntry,
    );
  }

  for (const change of baseDelta.characterChanges) {
    if (change.status === null || change.status === undefined) continue;
    statusById.set(change.characterId, {
      status: change.status,
      source: "impact",
      sourceSceneId: null,
      sourceDepth: null,
    });
  }

  const overridesByAnchor = indexOverrides(overrides);
  applyOverrides(null, null);

  for (const node of path) {
    for (const change of node.statePatch.characterChanges) {
      if (change.status === null || change.status === undefined) continue;
      statusById.set(change.characterId, {
        status: change.status,
        source: "scene",
        sourceSceneId: node.id,
        sourceDepth: node.depth,
      });
    }
    applyOverrides(node.id, node.depth);
  }

  const charactersById = new Map(
    storyMap.characters.map((character) => [character.id, character]),
  );
  const knownIds = new Set(charactersById.keys());
  const result: DerivedCharacterStatus[] = [];
  const append = (characterId: string, name: string) => {
    const entry = statusById.get(characterId) ?? defaultEntry;
    const history = historyByCharacter.get(characterId) ?? [];
    // 只展示非默认状态或有历史的角色；默认 unknown 且从未出现的人不占列表。
    if (
      entry.status === "unknown" &&
      entry.source === "default" &&
      history.length === 0
    ) {
      return;
    }
    result.push({
      characterId,
      name,
      status: entry.status,
      source: entry.source,
      sourceSceneId: entry.sourceSceneId,
      sourceDepth: entry.sourceDepth,
      summary: summaryById.get(characterId) ?? null,
      history,
    });
  };

  for (const character of storyMap.characters) {
    append(character.id, character.name);
  }
  for (const characterId of historyByCharacter.keys()) {
    if (!knownIds.has(characterId)) append(characterId, characterId);
  }

  return result;

  function applyOverrides(
    anchorSceneId: string | null,
    anchorDepth: number | null,
  ): void {
    for (const override of overridesByAnchor.get(anchorSceneId) ?? []) {
      statusById.set(override.characterId, {
        status: override.status,
        source: "reader",
        sourceSceneId: anchorSceneId,
        sourceDepth: anchorDepth,
      });
    }
  }
}

/** 按 baseDelta → 路径场景顺序收集显式人物变化；不含读者覆盖。 */
export function collectPathCharacterHistory(
  baseDelta: WorldlineDelta,
  path: readonly SceneNode[],
): Map<string, CharacterStatusHistoryEntry[]> {
  const historyByCharacter = new Map<string, CharacterStatusHistoryEntry[]>();
  const append = (
    change: {
      characterId: string;
      summary: string;
      status?: CharacterStatus | null;
    },
    sourceKind: "divergence" | "scene",
    sceneId: string | null,
    depth: number,
  ) => {
    const history = historyByCharacter.get(change.characterId) ?? [];
    history.push({
      sourceKind,
      sceneId,
      depth,
      summary: change.summary,
      ...(change.status === null || change.status === undefined
        ? {}
        : { status: change.status }),
    });
    historyByCharacter.set(change.characterId, history);
  };

  for (const change of baseDelta.characterChanges) {
    append(change, "divergence", null, 0);
  }
  for (const node of path) {
    for (const change of node.statePatch.characterChanges) {
      append(change, "scene", node.id, node.depth);
    }
  }
  return historyByCharacter;
}

/**
 * 同一角色同一锚点只有最新一条覆盖生效；不同锚点按路径顺序处理。
 * 返回按 anchor 分组、组内按 (createdAt, id) 升序的覆盖列表。
 */
function indexOverrides(
  overrides: readonly WorldlineCharacterStatusOverride[],
): Map<string | null, WorldlineCharacterStatusOverride[]> {
  const groups = new Map<string | null, WorldlineCharacterStatusOverride[]>();
  for (const override of overrides) {
    const group = groups.get(override.anchorSceneId) ?? [];
    group.push(override);
    groups.set(override.anchorSceneId, group);
  }
  for (const group of groups.values()) {
    group.sort(compareOverrides);
    // 同一角色在同一锚点只保留最新一条，避免依赖后续 set 的覆盖顺序。
    const latestByCharacter = new Map<string, WorldlineCharacterStatusOverride>();
    for (const override of group) {
      latestByCharacter.set(override.characterId, override);
    }
    group.length = 0;
    group.push(...latestByCharacter.values());
    group.sort(compareOverrides);
  }
  return groups;
}

function compareOverrides(
  left: WorldlineCharacterStatusOverride,
  right: WorldlineCharacterStatusOverride,
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function hasDeathKeyword(value: string): boolean {
  return DEATH_KEYWORDS.some((keyword) => value.includes(keyword));
}

function hasNegatedDeathKeyword(value: string): boolean {
  return NEGATED_DEATH_KEYWORDS.some((keyword) => value.includes(keyword));
}

/** 供折叠与测试复用的单条合并规则。 */
export { mergeCharacterChange };
