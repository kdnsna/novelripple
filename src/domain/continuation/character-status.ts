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
 * - 只读 `sequence < 分歧事件.sequence` 的事件，分歧事件自身与之后事件
 *   都不参与；
 * - 只看 `evidenceKind === "fact"` 且 evidence 非空的事件；
 * - 状态变化必须同时包含死亡关键词与人物姓名/别名；事件恰好只有一个
 *   参与者时允许省略姓名；
 * - 同一句出现否定/假死措辞时跳过。
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

  const charactersById = new Map(
    storyMap.characters.map((character) => [character.id, character]),
  );
  const result = new Map<string, SourceBaselineStatus>();
  const events = [...storyMap.events]
    .filter(
      (event) =>
        event.sequence < divergenceEvent.sequence &&
        event.evidenceKind === "fact" &&
        event.evidence.length > 0,
    )
    .sort((left, right) => left.sequence - right.sequence);

  for (const event of events) {
    for (const participant of event.participants) {
      const character = charactersById.get(participant);
      if (!character) continue;
      const names = [character.name, ...character.aliases].filter(
        (name) => name.length > 0,
      );
      for (const stateChange of event.stateChanges) {
        if (!hasDeathKeyword(stateChange)) continue;
        if (hasNegatedDeathKeyword(stateChange)) continue;
        const namesCharacter =
          names.some((name) => stateChange.includes(name)) ||
          event.participants.length === 1;
        if (!namesCharacter) continue;
        result.set(participant, {
          status: "dead",
          source: "source_inference",
          eventId: event.id,
        });
        break;
      }
    }
  }

  return result;
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
