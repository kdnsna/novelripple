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

/**
 * Canon 护栏策略：
 * - `strict`（默认）：高置信否定硬拒绝，低置信线索只警告；
 * - `warn`：全部降级为不阻断的警告；
 * - `off`：完全关闭生成后 Canon 检查（Prompt 护栏仍保留）。
 */
export type ContinuationCanonGuardPolicy = "strict" | "warn" | "off";

export type ContinuationCanonWarning = {
  eventId: string;
  field: string;
  reason: string;
};

export type ContinuationCanonHardRejection = {
  eventId: string;
  title: string;
  field: string;
};

export type PreDivergenceCanonEvaluation = {
  issues: DomainValidationIssue[];
  warnings: ContinuationCanonWarning[];
  hardRejections: ContinuationCanonHardRejection[];
};

/**
 * 生成后、落库前的“分歧前 Canon 保护”校验（纯函数、确定、无模型）。
 *
 * 锁定集合 = Story Map 中 `sequence < 分歧事件.sequence` 且不在**当前路径
 * 状态** `factsRemoved` 里的事件。这与 `validateContinuationStatePatch` 的
 * “分歧前”定义一致：分歧后事件永远不锁定，路径上合法删除的事件也不锁定。
 *
 * 精度只做高置信的字面否定：锁定事件标题与一个明确的“未发生/不存在/是假的”
 * 谓词直接绑定（中间只允许少量助词），且落在同一句内。回忆、因果、普通提到
 * 某个否定词只会产生 warning，不阻断保存。改写同义句、隐含矛盾与设定矛盾
 * 不在本护栏的召回范围内。
 *
 * 命中硬拒绝时返回 issue，由调用方走既有 fail-closed 路径；绝不静默裁剪、
 * 修补或改写模型输出。
 */
export function validateAgainstPreDivergenceCanon(input: {
  textFields: readonly { field: string; text: string }[];
  storyMap: StoryMap;
  divergenceEventId: string;
  /** 当前路径状态（baseDelta 折叠完路径上的 statePatch），不是 baseDelta。 */
  pathState: WorldlineDelta;
  policy?: ContinuationCanonGuardPolicy;
}): PreDivergenceCanonEvaluation {
  const policy = input.policy ?? "strict";
  if (policy === "off") {
    return { issues: [], warnings: [], hardRejections: [] };
  }

  const divergenceEvent = input.storyMap.events.find(
    (event) => event.id === input.divergenceEventId,
  );
  if (!divergenceEvent) {
    return {
      issues: [
        {
          path: "divergenceEventId",
          message: `Canon 校验引用了未知 Divergence Event：${input.divergenceEventId}`,
        },
      ],
      warnings: [],
      hardRejections: [],
    };
  }

  const removedFacts = new Set(input.pathState.factsRemoved);
  const lockedEvents = input.storyMap.events.filter(
    (event) =>
      event.sequence < divergenceEvent.sequence &&
      !removedFacts.has(eventFactKey(event.id)),
  );

  const issues: DomainValidationIssue[] = [];
  const warnings: ContinuationCanonWarning[] = [];
  const hardRejections: ContinuationCanonHardRejection[] = [];
  const emitted = new Set<string>();

  for (const field of input.textFields) {
    if (field.text.trim().length < 2) continue;
    for (const event of lockedEvents) {
      const key = `${event.id}\u0000${field.field}`;
      if (emitted.has(key)) continue;
      const signals = detectEventRewriteSignals(field.text, event.title);
      if (signals.hard) {
        emitted.add(key);
        if (policy === "warn") {
          warnings.push(buildCanonWarning(event.id, field.field, event.title));
          continue;
        }
        issues.push({
          path: field.field,
          message: `生成内容明确否定了分歧前已确认的事件：${event.title}`,
        });
        hardRejections.push({
          eventId: event.id,
          title: event.title,
          field: field.field,
        });
        continue;
      }
      if (signals.weak) {
        emitted.add(key);
        warnings.push(buildCanonWarning(event.id, field.field, event.title));
      }
    }
  }

  return { issues, warnings, hardRejections };
}

function buildCanonWarning(
  eventId: string,
  field: string,
  title: string,
): ContinuationCanonWarning {
  return {
    eventId,
    field,
    reason: `提及分歧前已确认事件「${title}」的句子附近出现否定/改写线索，请核对。`,
  };
}

/**
 * 低置信线索：只在同一句里出现，且不直接绑定事件标题。
 *
 * 这些词本身很常见（回忆、因果、无关否定），所以只产生 warning；真正的
 * 硬拒绝必须满足 `hasExplicitOccurrenceNegation` 的直接谓词结构。
 */
const CANON_WEAK_CUES = [
  "不再",
  "不曾",
  "没有",
  "并未",
  "取消",
  "并非",
  "从未",
  "并没有",
  "其实没有",
  "其实并未",
  "改写",
  "推翻",
  "抹去",
  "从没",
  "从来没有",
  "根本没有",
] as const;

/**
 * 标题与否定谓词之间最多 4 个助词/指示词。
 *
 * 字符类只包含“了/过/这件事/那场”一类的助词，不包含“忘记/想起/记得/听说”
 * 等会改变否定对象的动词，因此 `没有忘记<title>` 不会被当成事件未发生。
 */
const CANON_PARTICLE_GAP = "[过 了的这那场件事次段个幕一起回，,、]{0,4}";

const CANON_OCCURRENCE_NEGATION = [
  "从未",
  "从没",
  "从来没有",
  "根本没有",
  "其实并没有",
  "其实没有",
  "其实从未",
  "其实并未",
  "并没有",
  "并未",
  "不曾",
  "没有",
]
  .map(escapeRegExp)
  .join("|");

const CANON_OCCURRENCE_VERB = [
  "发生过",
  "发生",
  "存在过",
  "存在",
  "出现过",
  "出现",
]
  .map(escapeRegExp)
  .join("|");

const CANON_FAKE_PREDICATE = [
  "是假的",
  "是谎言",
  "是捏造的",
  "根本不存在",
  "纯属虚构",
  "纯属捏造",
]
  .map(escapeRegExp)
  .join("|");

/** 直接前缀否定：`从未(发生过)?<title>`；不含裸 `没有`，避免窗口误伤。 */
const CANON_PREFIX_NEGATION = CANON_OCCURRENCE_NEGATION;

function detectEventRewriteSignals(
  text: string,
  title: string,
): { hard: boolean; weak: boolean } {
  if (title.length < 2) return { hard: false, weak: false };
  const sentencePattern = /[。！？!?；;\n\r]+/u;
  let weak = false;
  for (const sentence of text.split(sentencePattern)) {
    if (!sentence.includes(title)) continue;
    if (hasExplicitOccurrenceNegation(sentence, title)) {
      return { hard: true, weak: false };
    }
    const withoutTitle = sentence.split(title).join("");
    if (CANON_WEAK_CUES.some((cue) => withoutTitle.includes(cue))) {
      weak = true;
    }
  }
  return { hard: false, weak };
}

/**
 * 高置信：标题与“未发生/不存在/是假的”直接绑定，或裸 `没有<title>` 紧邻。
 *
 * 只接受同一句内的直接谓词，不做 ±40 字窗口扫描；因此“想起<title>……
 * 不再……”“因为<title>，她不再……”这类回忆/因果句只会命中弱线索。
 */
function hasExplicitOccurrenceNegation(
  sentence: string,
  title: string,
): boolean {
  const escaped = escapeRegExp(title);
  const gap = `(?:${CANON_PARTICLE_GAP})?`;
  const patterns = [
    // <title>(从未|并没有|...)(发生|存在|出现)
    new RegExp(
      `${escaped}${gap}(?:${CANON_OCCURRENCE_NEGATION})(?:${CANON_OCCURRENCE_VERB})`,
      "u",
    ),
    // <title>(是假的|是谎言|是捏造的|根本不存在)
    new RegExp(`${escaped}${gap}(?:${CANON_FAKE_PREDICATE})`, "u"),
    // (从未|根本没有|并没有|...)(发生过)?(助词)<title>
    new RegExp(
      `(?:${CANON_PREFIX_NEGATION})(?:发生过|发生|有过|有过这件事)?${gap}${escaped}`,
      "u",
    ),
    // 裸“没有<title>”只接受紧邻，`没有忘记<title>` 不会命中。
    new RegExp(`没有${escaped}`, "u"),
  ];
  return patterns.some((pattern) => pattern.test(sentence));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function eventFactKey(eventId: string): string {
  return `event:${eventId}`;
}
