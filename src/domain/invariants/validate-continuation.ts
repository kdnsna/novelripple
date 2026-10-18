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

/** 最终校验问题中的 Canon 硬拒绝标记；只用于服务端选择错误文案。 */
export const CONTINUATION_CANON_HARD_REJECT_ISSUE_CODE =
  "continuation_canon_hard_reject" as const;

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
 * 谓词直接绑定（否定词后必须跟“发生/存在”类谓词，或标题后跟“是假的”类
 * 谓词；中间只允许少量助词），且落在同一句内。裸 `没有<title>`、回忆、因果、
 * 反事实（如果/要不是/若是/假如/倘若）与失去义（没有了/再也没有）只会产生
 * warning，不阻断保存。改写同义句、隐含矛盾与设定矛盾不在本护栏的召回范围内。
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
          code: CONTINUATION_CANON_HARD_REJECT_ISSUE_CODE,
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
  // 「矢口否认<title>存在过」没有“没有/未”类否定词，但“否认”本身就是改写信号，
  // 因此只进入弱线索，不参与硬拒绝。
  "否认",
] as const;

/**
 * 标题与否定谓词之间最多 4 个助词/指示词。
 *
 * 字符类只包含“了/过/这件事/那场”一类的助词，不包含“忘记/想起/记得/听说”
 * 等会改变否定对象的动词，因此 `没有忘记<title>` 不会被当成事件未发生。
 */
const CANON_PARTICLE_GAP = "[过 了的这那场件事次段个幕一起回，,、]{0,4}";

/**
 * 明确否定“发生/存在”的否定词；裸 `没有<title>` 不再硬拒。
 *
 * 长词排在前面，保证“压根没有/未曾/从没”等整体优先于它包含的单字
 * 否定词；所有词仍必须后接发生/存在类谓词才算硬拒绝。
 */
const CANON_OCCURRENCE_NEGATION = [
  "从来没有",
  "根本没有",
  "压根没有",
  "其实没有",
  "压根没",
  "并没有",
  "未曾",
  "从没",
  "并未",
  "不曾",
  "从未",
  "没有",
  "未",
  "没",
]
  .map(escapeRegExp)
  .join("|");

/** 否定词后必须跟“发生/存在”类谓词，才能说明事件未发生/不存在。 */
const CANON_PREFIX_NEGATION_VERB = ["发生过", "发生", "存在过", "存在"]
  .map(escapeRegExp)
  .join("|");

const CANON_OCCURRENCE_VERB = ["发生过", "发生", "存在过", "存在"]
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

/**
 * 反事实/失去义线索不构成“事件未发生”的断言。
 *
 * 反事实线索只有与否定谓词处于同一分句且位于其前面时才豁免；失去义
 * （没有了/再也没有）只在该线索本身就是紧邻标题的否定时才豁免。这样
 * 「灯塔熄灭从未发生过，如果有人问起就这么说。」不会被后半句的“如果”放过。
 */
const CANON_COUNTERFACTUAL_CUES = [
  "如果",
  "要不是",
  "若是",
  "假如",
  "倘若",
  "要是",
] as const;
const CANON_LOSS_CUES = ["没有了", "再也没有"] as const;

/**
 * 引述/对白/传闻/怀疑/撒谎等框架只产生 warning，不硬拒绝。
 *
 * 这些线索必须出现在匹配之前（同一句）；硬检查前还会先剥离成对引号内的
 * 内容，因此角色对白里的否定不会被当成叙述者的直接断言。裸 `说` 与 `骗`
 * 太短，改用下方更窄的 `hasReportingSayCue` / `hasDeceptionCue` 判定。
 */
const CANON_DIALOGUE_CUES = [
  "有人说",
  "撒谎",
  "谎称",
  "听说",
  "据说",
  "据传",
  "传言",
  "传闻",
  "说道",
  "声称",
  "坚称",
  "告诉",
  "假装",
  "装作",
  "怀疑",
  "以为",
  "难道",
  "也许",
  "或许",
  "可能",
  "大概",
] as const;

/**
 * 角色断言框架：角色“咬定/坚持/否认/发誓”的内容仍是角色话语，不是
 * 叙述者的直接断言，只产生 warning。线索必须出现在匹配之前（同一句）。
 */
const CANON_CHARACTER_ASSERTION_CUES = [
  "一口咬定",
  "咬定",
  "咬死",
  "坚持说",
  "坚持认为",
  "一再强调",
  "矢口否认",
  "否认",
  "断言",
  "发誓",
  "嚷道",
  "喊道",
  "辩称",
  "硬说",
  "非说",
] as const;

/** 愿望/假设框架：角色“希望/但愿/宁愿”的事没有发生，同样只警告。 */
const CANON_WISH_CUES = [
  "多希望",
  "希望",
  "但愿",
  "宁愿",
  "巴不得",
  "恨不得",
  "盼着",
  "宁可相信",
  "祈祷",
] as const;

/** `说` 只有作为引述动词时才豁免；这些后续字说明它是“说完/说明/起来”等。 */
const CANON_SAY_BLOCKED_FOLLOWERS = new Set(["完", "明", "起", "来", "法", "服"]);
/** 说：/ 说: / 说，是明确的引述框架，即使逗号后已跨分句。 */
const CANON_SAY_IMMEDIATE_PUNCTUATION = new Set(["：", ":", "，"]);

/** 分句边界：只在同一分句内判断反事实线索与否定谓词的关系。 */
const CANON_CLAUSE_DELIMITER = /[，,；;：:、]/u;

const CANON_QUOTE_PAIRS: Readonly<Record<string, string>> = {
  "「": "」",
  "『": "』",
  "“": "”",
  "‘": "’",
  '"': '"',
};

type CanonQuotedSpan = { start: number; end: number };

function detectEventRewriteSignals(
  text: string,
  title: string,
): { hard: boolean; weak: boolean } {
  if (title.length < 2) return { hard: false, weak: false };
  const sentencePattern = /[。！？!?；;\n\r]+/u;
  let weak = false;
  for (const sentence of text.split(sentencePattern)) {
    if (!sentence.includes(title)) continue;
    const withoutTitle = sentence.split(title).join("");
    if (CANON_WEAK_CUES.some((cue) => withoutTitle.includes(cue))) {
      weak = true;
    }
    const { masked, quotedSpans } = maskQuotedSpans(sentence);
    // 引号内的否定只警告，不参与硬拒绝；但引号内容若单独看足以命中，
    // 仍要产生 warning，不能静默丢掉信号。
    if (
      quotedSpans.some(
        (span) =>
          hasExplicitOccurrenceNegation(
            sentence.slice(span.start + 1, span.end),
            title,
          ) !== null,
      )
    ) {
      weak = true;
    }
    const signal = hasExplicitOccurrenceNegation(masked, title);
    if (signal === "hard") return { hard: true, weak: false };
    if (signal === "nonAssertive") weak = true;
  }
  return { hard: false, weak };
}

/**
 * 高置信：标题与“未发生/不存在/是假的”谓词直接绑定。
 *
 * 只接受同一句内的直接谓词，不做 ±40 字窗口扫描；因此“想起<title>……
 * 不再……”“因为<title>，她不再……”这类回忆/因果句只会命中弱线索。裸
 * `没有<title>`、`没有忘记<title>` 都不再硬拒；反事实/失去义/引述框架
 * 只在对应范围内豁免，返回 `nonAssertive` 让调用方产生 warning。
 */
function hasExplicitOccurrenceNegation(
  sentence: string,
  title: string,
): "hard" | "nonAssertive" | null {
  const escaped = escapeRegExp(title);
  const gap = `(?:${CANON_PARTICLE_GAP})?`;
  const patterns = [
    // <title>(从未|根本没有|并没有|其实没有|没有)(发生过?|存在过?)
    new RegExp(
      `${escaped}${gap}(?:${CANON_OCCURRENCE_NEGATION})(?:${CANON_OCCURRENCE_VERB})`,
      "gu",
    ),
    // <title>(是假的|是谎言|是捏造的|根本不存在)
    new RegExp(`${escaped}${gap}(?:${CANON_FAKE_PREDICATE})`, "gu"),
    // (从未|从来没有|根本没有|并没有|其实没有|没有)(发生过?|存在过?)<title>
    new RegExp(
      `(?:${CANON_OCCURRENCE_NEGATION})(?:${CANON_PREFIX_NEGATION_VERB})${gap}${escaped}`,
      "gu",
    ),
  ];

  let matched = false;
  for (const pattern of patterns) {
    for (const match of sentence.matchAll(pattern)) {
      matched = true;
      if (!isNonAssertionMatch(sentence, match, title)) {
        return "hard";
      }
    }
  }
  return matched ? "nonAssertive" : null;
}

/** 该硬匹配是否被同一分句的反事实、失去义或之前的引述框架豁免。 */
function isNonAssertionMatch(
  sentence: string,
  match: RegExpMatchArray,
  title: string,
): boolean {
  const start = match.index ?? 0;
  const end = start + match[0].length;
  const clauseStart = clauseStartBefore(sentence, start);
  const clauseEnd = clauseEndAfter(sentence, end);
  const clause = sentence.slice(clauseStart, clauseEnd);
  const prefix = sentence.slice(clauseStart, start);
  if (CANON_COUNTERFACTUAL_CUES.some((cue) => prefix.includes(cue))) {
    return true;
  }

  // 失去义只在“没有了/再也没有”本身紧邻标题、且位于匹配之前时豁免；
  // 「再也没有发生过<title>」仍按前缀否定处理。
  const escapedTitle = escapeRegExp(title);
  if (
    CANON_LOSS_CUES.some((cue) => {
      const cueIndex = clause.indexOf(cue);
      return (
        cueIndex >= 0 &&
        clauseStart + cueIndex < start &&
        new RegExp(
          `${escapeRegExp(cue)}(?:${CANON_PARTICLE_GAP})?${escapedTitle}`,
          "u",
        ).test(clause)
      );
    })
  ) {
    return true;
  }

  return (
    CANON_DIALOGUE_CUES.some((cue) =>
      sentence.slice(0, start).includes(cue),
    ) ||
    CANON_CHARACTER_ASSERTION_CUES.some((cue) =>
      sentence.slice(0, start).includes(cue),
    ) ||
    CANON_WISH_CUES.some((cue) => sentence.slice(0, start).includes(cue)) ||
    hasReportingSayCue(sentence, start, clauseStart) ||
    hasDeceptionCue(sentence.slice(0, start))
  );
}

/**
 * `说` 仅在引述框架中豁免：
 * - 与匹配处于同一分句（`他说了…`、`他转述说…`）；或
 * - 紧跟 `：` / `:` / `，`（`他说：…`、`他说，…`）。
 *
 * 但“说完/说明/说起/说来/说法/说服/说过了”不是引述动词，因此像
 * 「众人说完后便散了，灯塔熄灭从未发生过。」「这么说来，……」仍会硬拒绝。
 */
function hasReportingSayCue(
  sentence: string,
  matchStart: number,
  clauseStart: number,
): boolean {
  for (let index = clauseStart; index < matchStart; index += 1) {
    if (sentence[index] !== "说") continue;
    if (isBlockedReportingSay(sentence, index)) continue;
    return true;
  }
  for (let index = 0; index < matchStart; index += 1) {
    if (sentence[index] !== "说") continue;
    if (isBlockedReportingSay(sentence, index)) continue;
    if (CANON_SAY_IMMEDIATE_PUNCTUATION.has(sentence[index + 1] ?? "")) {
      return true;
    }
  }
  return false;
}

function isBlockedReportingSay(sentence: string, index: number): boolean {
  const next = sentence[index + 1];
  if (next === undefined) return false;
  if (CANON_SAY_BLOCKED_FOLLOWERS.has(next)) return true;
  return next === "过" && sentence[index + 2] === "了";
}

/** `骗` 只在「骗…说」「骗人」「欺骗」中作为转述/谎言框架。 */
function hasDeceptionCue(prefix: string): boolean {
  if (prefix.includes("欺骗") || prefix.includes("骗人")) return true;
  const lieIndex = prefix.indexOf("骗");
  return lieIndex >= 0 && prefix.slice(lieIndex + 1).includes("说");
}

function clauseStartBefore(sentence: string, index: number): number {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (CANON_CLAUSE_DELIMITER.test(sentence[cursor]!)) return cursor + 1;
  }
  return 0;
}

function clauseEndAfter(sentence: string, index: number): number {
  for (let cursor = index; cursor < sentence.length; cursor += 1) {
    if (CANON_CLAUSE_DELIMITER.test(sentence[cursor]!)) return cursor;
  }
  return sentence.length;
}

/**
 * 把成对引号（含嵌套）内的内容替换为空格，保留长度与下标。
 *
 * 未闭合的开引号一直遮蔽到句末：宁可少抓一条对白，也不把角色台词当成
 * 叙述者的直接断言。引号本身也一并遮蔽，避免跨引号拼出假匹配。
 */
function maskQuotedSpans(sentence: string): {
  masked: string;
  quotedSpans: CanonQuotedSpan[];
} {
  const stack: Array<{ close: string; start: number }> = [];
  const spans: CanonQuotedSpan[] = [];
  // 引号都是 BMP 字符，按 UTF-16 下标扫描即可与正则 match.index 对齐。
  for (let index = 0; index < sentence.length; index += 1) {
    const char = sentence[index]!;
    const top = stack.at(-1);
    if (top && top.close === char) {
      stack.pop();
      spans.push({ start: top.start, end: index });
      continue;
    }
    if (Object.hasOwn(CANON_QUOTE_PAIRS, char)) {
      stack.push({ close: CANON_QUOTE_PAIRS[char]!, start: index });
    }
  }
  while (stack.length > 0) {
    const open = stack.pop()!;
    spans.push({ start: open.start, end: sentence.length - 1 });
  }
  let masked = "";
  for (let index = 0; index < sentence.length; index += 1) {
    const inside = spans.some(
      (span) => index >= span.start && index <= span.end,
    );
    masked += inside ? " " : sentence[index]!;
  }
  return { masked, quotedSpans: spans };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function eventFactKey(eventId: string): string {
  return `event:${eventId}`;
}
