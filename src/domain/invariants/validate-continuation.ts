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
  /** 模型输出中真正命中的那句话（trim 后最多约 60 字，超出以 … 截断）。 */
  sentence: string;
  /**
   * 该句所在段落是否存在未闭合/孤立/风格错配的引号。
   *
   * 按 fail-closed 策略，这种段落里的引号不遮蔽任何内容；服务端据此提示
   * 读者“补全引号后重试即可”。
   */
  unpairedQuote: boolean;
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
 * warning，不阻断保存；角色对白/转述（引号内、言语动词 + 逗号、冒号直接引语、
 * 后置引述）同样只 warning。改写同义句、隐含矛盾与设定矛盾不在本护栏的召回
 * 范围内。
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
          sentence: signals.sentence ?? "",
          unpairedQuote: signals.unpairedQuote,
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
 * 框架必须“治理”匹配：与匹配处于同一分句且位于其前，或由紧跟框架动词的
 * 冒号引入直接引语。硬检查前还会先剥离成对引号内的内容，因此角色对白里的
 * 否定不会被当成叙述者的直接断言。裸 `说` 与 `骗` 太短，改用下方更窄的
 * `hasReportingSayCue` / `hasDeceptionCue` 判定。
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
 * 叙述者的直接断言，只产生 warning。框架同样必须治理匹配（见
 * `hasGoverningFrameCue`）。
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

/**
 * 统一的言语/断言动词族。
 *
 * 这些动词出现在“短分句 + 逗号”的末尾时，与冒号一样引出角色话语：后面到
 * 句末（或叙述者转折词）的否定属于被转述的内容，只警告。列表本身不参与
 * “同分句包含”判断，以免把 `知道`、`小说` 之类的普通词当成引述。
 */
const CANON_SPEECH_VERBS = [
  "一口咬定",
  "矢口否认",
  "坚持说",
  "高声道",
  "大声说",
  "大声道",
  "低声道",
  "轻声道",
  "冷笑道",
  "说道",
  "问道",
  "答道",
  "喊道",
  "叫道",
  "嚷道",
  "吼道",
  "笑道",
  "叹道",
  "大叫",
  "大喊",
  "尖叫",
  "高喊",
  "怒吼",
  "怒道",
  "哭喊",
  "哭道",
  "惊叫",
  "惊呼",
  "呼喊",
  "喊叫",
  "回答",
  "告诉",
  "询问",
  "发问",
  "提问",
  "质问",
  "盘问",
  "责问",
  "借问",
  "解说",
  "诉说",
  "演说",
  "叙说",
  "胡说",
  "瞎说",
  "强调",
  "嘀咕",
  "念叨",
  "喃喃",
  "嘟囔",
  "咕哝",
  "低语",
  "耳语",
  "插话",
  "补充",
  "反问",
  "追问",
  "回应",
  "感叹",
  "感慨",
  "嚷嚷",
  "坚称",
  "声称",
  "宣称",
  "辩称",
  "咬定",
  "断言",
  "发誓",
  "否认",
  "说",
  "道",
  "问",
  "答",
  "喊",
  "叫",
  "嚷",
] as const;

/** 长动词优先，保证 `低声道` 不会被拆成 `道`、`坚持说` 不会被拆成 `说`。 */
const CANON_SPEECH_VERBS_BY_LENGTH = [...CANON_SPEECH_VERBS].sort(
  (left, right) => right.length - left.length,
);

/**
 * 单字言语动词的常见复合词前缀黑名单。
 *
 * 只用于“动词位于分句末尾/引出话语”的判断：`知道`、`味道`、`小说`、`学问`
 * 不是引述，不能把叙述者的否定降级为 warning；`老人道`、`他问` 仍按引述处理。
 */
const CANON_SPEECH_VERB_BLOCKED_BEFORE: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  道: new Set([
    "知",
    "难",
    "味",
    "街",
    "通",
    "报",
    "轨",
    "频",
    "一",
    "公",
    "霸",
    "天",
    "地",
    "渠",
    "隧",
    "赤",
    "厚",
    "精",
    "门",
    "水",
    "管",
    "航",
    "跑",
    "车",
    "铁",
    "大",
    "小",
    "正",
    "邪",
    "外",
    "内",
    "王",
    "古",
    "山",
    "河",
    "甬",
    "索",
    "栈",
    "弯",
    "赛",
    "楼",
  ]),
  说: new Set([
    "小",
    "传",
    "学",
    "虽",
    "照",
    "按",
    "再",
    "是",
  ]),
  问: new Set([
    "学",
    "疑",
    "访",
    "过",
    "慰",
    "拷",
    "审",
    "顾",
    "设",
  ]),
  答: new Set(["解", "报"]),
  叫: new Set(["鸣", "狗", "鸡", "猫", "嗷", "嚎"]),
};

/**
 * 单字 `道` 的结构性判定：除了词法黑名单，量词/指示词/数字直接放在 `道`
 * 前面时它属于名词（一道、这道、那条道），不能当作“说道”的 `道`。
 */
const CANON_DAO_MEASURE_OR_DETERMINER_CHARS = new Set([
  "一",
  "二",
  "三",
  "四",
  "五",
  "六",
  "七",
  "八",
  "九",
  "十",
  "百",
  "千",
  "万",
  "零",
  "两",
  "几",
  "这",
  "那",
  "哪",
  "每",
  "某",
  "条",
  "个",
]);

/** `道` 前的言语类副词/动词字；命中时直接按言语动词处理。 */
const CANON_DAO_SPEECH_PREFIX_CHARS = new Set([
  "说",
  "问",
  "答",
  "喊",
  "叫",
  "嚷",
  "吼",
  "笑",
  "叹",
  "低",
  "轻",
  "冷",
  "怒",
  "哭",
  "惊",
  "高",
  "大",
  "尖",
  "忙",
  "急",
  "沉",
  "缓",
  "哑",
  "颤",
  "厉",
  "朗",
  "连",
  "又",
  "才",
  "正",
]);

/** `说` 只有作为引述动词时才豁免；这些后续字说明它是“说完/说明/起来”等。 */
const CANON_SAY_BLOCKED_FOLLOWERS = new Set(["完", "明", "起", "来", "法", "服"]);

/**
 * 叙述者切换连接词。
 *
 * 多字连接词出现在任意位置都算切换；单字 `但/可/却` 由
 * `hasNarratorSwitchCue` 结合分句起点与复合词黑名单判断，避免
 * “可能/可以/可怜/却步/冷却/但愿/不但”把角色话语误判成叙述者断言。
 */
const CANON_NARRATOR_SWITCH_PHRASES = [
  "事实上",
  "实际上",
  "但是",
  "可是",
  "然而",
  "不过",
  "其实",
] as const;

/**
 * 反事实/失去义的原有分句边界（冒号也切分）。
 *
 * 这两类线索的语义保持不变，因此不复用下面“框架治理”的边界。
 */
const CANON_COUNTERFACTUAL_CLAUSE_DELIMITER = /[，,；;：:、]/u;

/**
 * 框架治理的分句边界：逗号、顿号、句末标点与换行切分，冒号不切分。
 *
 * 冒号直接跟在框架动词后时引入直接引语（`他说：…`、`据说：…`），引语到
 * 下一个句末标点/换行为止都由该框架治理；该特例由 `frameCueGoverns` 处理。
 * ASCII `.` 已由 `splitSentenceSpans` 在切句时处理（小数点除外），因此这里
 * 不把 `.` 当分句边界，避免把 `3.5` 拆成两个分句。
 */
const CANON_GOVERNANCE_CLAUSE_DELIMITER = /[，,。；;！!？?、\n\r]/u;

const CANON_QUOTE_PAIRS: Readonly<Record<string, string>> = {
  "「": "」",
  "『": "』",
  "“": "”",
  "‘": "’",
  '"': '"',
};

export type QuotedSpan = {
  start: number;
  /** 排他下标：成对引号包含闭引号。 */
  end: number;
};

type CanonRewriteSignals = {
  hard: boolean;
  weak: boolean;
  /** 命中硬拒绝的原句（trim 后 ≤60 字）；未命中时为 null。 */
  sentence: string | null;
  /** 该句所在段落是否存在未闭合/孤立/风格错配的引号。 */
  unpairedQuote: boolean;
};

function detectEventRewriteSignals(
  text: string,
  title: string,
): CanonRewriteSignals {
  if (title.length < 2) {
    return { hard: false, weak: false, sentence: null, unpairedQuote: false };
  }
  // 先在整段文本上按 fail-closed 策略配对引号，再切句：同一段内跨句的
  // 多句引语仍属于引号内容；未闭合/错配的引号不遮蔽任何文本。
  const { masked, quotedSpans } = maskQuotedSpans(text);
  let weak = false;

  // 弱线索仍在原文句子上判断：即使引号里的否定没有直接绑定标题（例如
  // 「灯塔熄灭之后，他说『从来没有发生过』」），也要给出 warning。硬拒绝
  // 只看遮蔽后的句子，因此引号内容永远不会升级为硬拒绝。
  for (const span of splitSentenceSpans(text)) {
    const sentence = text.slice(span.start, span.end);
    if (!sentence.includes(title)) continue;
    const withoutTitle = sentence.split(title).join("");
    if (CANON_WEAK_CUES.some((cue) => withoutTitle.includes(cue))) {
      weak = true;
    }
  }

  // 标题只在引号内出现时，masked 段里已经没有标题；引号内容单独检查是否
  // 足以命中，但只产生 warning。
  for (const span of quotedSpans) {
    const inner = text.slice(span.start + 1, span.end - 1);
    if (!inner.includes(title)) continue;
    if (hasExplicitOccurrenceNegation(inner, title) !== null) {
      weak = true;
    }
  }

  for (const span of splitSentenceSpans(masked)) {
    const sentence = masked.slice(span.start, span.end);
    if (!sentence.includes(title)) continue;
    const signal = hasExplicitOccurrenceNegation(sentence, title);
    if (signal === "hard") {
      const paragraph = paragraphRangeAt(text, span.start);
      return {
        hard: true,
        weak: false,
        sentence: sampleCanonSentence(text.slice(span.start, span.end)),
        unpairedQuote: hasUnpairedQuote(
          text.slice(paragraph.start, paragraph.end),
        ),
      };
    }
    if (signal === "nonAssertive") weak = true;
  }
  return { hard: false, weak, sentence: null, unpairedQuote: false };
}

/** 把命中硬拒绝的整句压成服务端可安全展示的短样本（最多约 60 字）。 */
function sampleCanonSentence(sentence: string): string {
  const trimmed = sentence.trim();
  const max = 60;
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Canon 切句终止符：全角/半角句末标点、换行、省略号与 ASCII `.`。
 *
 * ASCII `.` 夹在两个数字之间时是小数点（`3.5`），不是句末；连续的 `.`
 * 与 `…` 按一个终止符处理，避免把 `...` 拆成多个空句。弱线索与硬拒绝都
 * 必须调用 `splitSentenceSpans`，保证下游看到的是同一批句子。
 */
const CANON_SENTENCE_TERMINATORS = new Set([
  "。",
  "！",
  "？",
  "!",
  "?",
  "；",
  ";",
  "\n",
  "\r",
  "…",
]);

function isAsciiDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function isCanonSentenceTerminatorAt(text: string, index: number): boolean {
  const char = text[index]!;
  if (char === ".") {
    return !(
      isAsciiDigit(text[index - 1]) && isAsciiDigit(text[index + 1])
    );
  }
  return CANON_SENTENCE_TERMINATORS.has(char);
}

/** 判断一段文本里是否还有句末边界（小数点不算）。 */
function hasCanonSentenceTerminator(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (isCanonSentenceTerminatorAt(text, index)) return true;
  }
  return false;
}

/** 切句但不丢下标；所有句末判断共用这一处。 */
function splitSentenceSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    if (!isCanonSentenceTerminatorAt(text, index)) {
      index += 1;
      continue;
    }
    if (index > cursor) spans.push({ start: cursor, end: index });
    index += 1;
    // 连续终止符（`...`、`……`、`！？`）只切一次。
    while (
      index < text.length &&
      isCanonSentenceTerminatorAt(text, index)
    ) {
      index += 1;
    }
    cursor = index;
  }
  if (cursor < text.length) spans.push({ start: cursor, end: text.length });
  return spans;
}

/** 返回下标所在段落（按 \n / \r\n / \r 切分）的 [start, end)。 */
function paragraphRangeAt(
  text: string,
  index: number,
): { start: number; end: number } {
  let start = index;
  while (start > 0 && !isLineBreak(text[start - 1]!)) start -= 1;
  let end = index;
  while (end < text.length && !isLineBreak(text[end]!)) end += 1;
  return { start, end };
}

function isLineBreak(char: string): boolean {
  return char === "\n" || char === "\r";
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

/** 该硬匹配是否被同一分句的反事实、失去义或治理它的引述框架豁免。 */
function isNonAssertionMatch(
  sentence: string,
  match: RegExpMatchArray,
  title: string,
): boolean {
  const start = match.index ?? 0;
  const end = start + match[0].length;
  // 反事实/失去义沿用原有分句边界；框架治理使用自己的边界。
  const counterfactualClauseStart = clauseStartBefore(
    sentence,
    start,
    CANON_COUNTERFACTUAL_CLAUSE_DELIMITER,
  );
  const counterfactualClauseEnd = clauseEndAfter(
    sentence,
    end,
    CANON_COUNTERFACTUAL_CLAUSE_DELIMITER,
  );
  const clause = sentence.slice(
    counterfactualClauseStart,
    counterfactualClauseEnd,
  );
  const prefix = sentence.slice(counterfactualClauseStart, start);
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
        counterfactualClauseStart + cueIndex < start &&
        new RegExp(
          `${escapeRegExp(cue)}(?:${CANON_PARTICLE_GAP})?${escapedTitle}`,
          "u",
        ).test(clause)
      );
    })
  ) {
    return true;
  }

  const governanceClauseStart = clauseStartBefore(
    sentence,
    start,
    CANON_GOVERNANCE_CLAUSE_DELIMITER,
  );
  // 1) 言语动词 + 逗号等价于冒号引出的直接引语：被转述的否定只警告。
  // 2) 后置引述（「…，他说。」）治理同一句前面所有分句。
  if (
    speechCommaGoverns(sentence, start) ||
    speechColonGoverns(sentence, start) ||
    trailingAttributionGoverns(sentence, end)
  ) {
    return true;
  }
  return (
    hasGoverningFrameCue(
      sentence,
      start,
      governanceClauseStart,
      CANON_DIALOGUE_CUES,
    ) ||
    hasGoverningFrameCue(
      sentence,
      start,
      governanceClauseStart,
      CANON_CHARACTER_ASSERTION_CUES,
    ) ||
    hasGoverningFrameCue(
      sentence,
      start,
      governanceClauseStart,
      CANON_WISH_CUES,
    ) ||
    hasReportingSayCue(sentence, start, governanceClauseStart) ||
    hasDeceptionCue(sentence, start, governanceClauseStart)
  );
}

/**
 * 通用框架规则：框架线索只有“治理”否定时才豁免，返回 true。
 *
 * 治理条件：
 * (a) 与匹配处于同一分句且位于其前，且两者之间没有叙述者切换连接词；
 * (b) 框架后紧跟全角/半角冒号，引入直接引语；冒号不切分句，因此引语内
 *     直到下一个句末标点/换行前的否定都由该框架治理（引语内逗号不打断）。
 *
 * 不同框架族共用这一条规则，避免“前面一句出现希望/怀疑，后一句的叙述者
 * 否定也被放过”。
 */
function hasGoverningFrameCue(
  sentence: string,
  matchStart: number,
  clauseStart: number,
  cues: readonly string[],
): boolean {
  for (const cue of cues) {
    let index = sentence.indexOf(cue);
    while (index >= 0 && index < matchStart) {
      if (
        frameCueGoverns(
          sentence,
          index,
          index + cue.length,
          matchStart,
          clauseStart,
        )
      ) {
        return true;
      }
      index = sentence.indexOf(cue, index + 1);
    }
  }
  return false;
}

/** 单个框架线索是否治理后面的匹配。 */
function frameCueGoverns(
  sentence: string,
  cueStart: number,
  cueEnd: number,
  matchStart: number,
  clauseStart: number,
): boolean {
  if (cueEnd > matchStart) return false;
  // (b) 冒号直接跟在框架动词后：直接引语直到句末/换行都受该框架治理。
  const colonIndex = colonDirectlyAfter(sentence, cueEnd);
  if (colonIndex !== null && colonIndex < matchStart) return true;
  // (a) 同一分句、位于匹配之前，且中间没有叙述者切换。
  if (cueStart < clauseStart) return false;
  return !hasNarratorSwitchCue(sentence, cueEnd, matchStart);
}

/**
 * 判断 `[start, end)` 内是否出现叙述者切换连接词。
 *
 * 多字连接词（但是/可是/然而/不过/其实/事实上/实际上）出现在任意位置都算；
 * 单字连接词按词法收紧：
 * - `但` 只有在不是“但愿/但凡/不但”时才算转折；
 * - `可` 必须位于分句起点，且不是“可能/可以/可怜/可惜/可爱/可见/可靠/
 *   可怕/可笑/可疑”等复合词；
 * - `却` 必须位于分句起点，或前面只有一个 ≤4 字的短主语（如「他却」），
 *   且不是“却步/冷却/推却/退却”。
 *
 * 这样「他可能记错了，…」里的“可”不会被当成转折，而「…，可灯塔熄灭从未
 * 发生过。」里的“可”仍然把前面的框架线索截断。
 */
export function hasNarratorSwitchCue(
  sentence: string,
  start = 0,
  end = sentence.length,
): boolean {
  const segment = sentence.slice(start, end);
  if (
    CANON_NARRATOR_SWITCH_PHRASES.some((phrase) => segment.includes(phrase))
  ) {
    return true;
  }
  for (let index = start; index < end; index += 1) {
    const char = sentence[index];
    if (char === "但") {
      if (isButCompound(sentence, index)) continue;
      return true;
    }
    if (char === "可") {
      if (isKeCompound(sentence, index)) continue;
      if (!isClauseStartAt(sentence, index)) continue;
      return true;
    }
    if (char === "却") {
      if (isQueCompound(sentence, index)) continue;
      if (!isQueClauseStart(sentence, index)) continue;
      return true;
    }
  }
  return false;
}

function isButCompound(sentence: string, index: number): boolean {
  const previous = sentence[index - 1];
  const next = sentence[index + 1];
  return previous === "不" || next === "愿" || next === "凡";
}

function isKeCompound(sentence: string, index: number): boolean {
  return KE_COMPOUND_FOLLOWERS.has(sentence[index + 1] ?? "");
}

const KE_COMPOUND_FOLLOWERS = new Set([
  "能",
  "以",
  "是",
  "怜",
  "惜",
  "爱",
  "见",
  "靠",
  "怕",
  "笑",
  "疑",
]);

function isQueCompound(sentence: string, index: number): boolean {
  const previous = sentence[index - 1];
  const next = sentence[index + 1];
  return (
    previous === "冷" ||
    previous === "推" ||
    previous === "退" ||
    next === "步"
  );
}

/** 单字转折词是否位于分句起点（允许 0 个字符，即标点/文本开头之后）。 */
function isClauseStartAt(sentence: string, index: number): boolean {
  if (index === 0) return true;
  return CANON_GOVERNANCE_CLAUSE_DELIMITER.test(sentence[index - 1]!);
}

/** `却` 额外允许一个 ≤4 字的短主语（「他却」「老人却」）。 */
function isQueClauseStart(sentence: string, index: number): boolean {
  if (isClauseStartAt(sentence, index)) return true;
  const clauseStart = clauseStartBefore(
    sentence,
    index,
    CANON_GOVERNANCE_CLAUSE_DELIMITER,
  );
  const subject = sentence.slice(clauseStart, index);
  return subject.length > 0 && subject.length <= 4;
}

/** 框架结尾后（允许普通/全角空格）是否紧跟冒号；返回冒号下标。 */
function colonDirectlyAfter(
  sentence: string,
  index: number,
): number | null {
  let cursor = index;
  while (
    cursor < sentence.length &&
    (sentence[cursor] === " " || sentence[cursor] === "\u3000")
  ) {
    cursor += 1;
  }
  return sentence[cursor] === "：" || sentence[cursor] === ":"
    ? cursor
    : null;
}

/**
 * 言语动词 + 逗号等价于冒号：框架所在分句只有短主语和言语动词时，逗号后的
 * 否定属于被转述的内容。例：
 *
 * - 「老渔夫坚称，灯塔熄灭从未发生过。」
 * - 「他低声道，交出钥匙根本没有发生过。」
 * - 「老人道，灯塔熄灭从来没有发生过。」
 *
 * 分句必须以言语动词结尾（可带 道/着/了），前面的主语部分 ≤20 字且不再含
 * 其它框架动词；「少年发誓要离开小岛，…」这类分句不以动词结尾，仍是叙述者
 * 的直接断言。言语之后一旦出现词法意义上的叙述者转折，治理立即结束。
 */
function speechCommaGoverns(sentence: string, matchStart: number): boolean {
  for (let index = 0; index < matchStart; index += 1) {
    if (sentence[index] !== "，" && sentence[index] !== ",") continue;
    const clauseStart = clauseStartBefore(
      sentence,
      index,
      CANON_GOVERNANCE_CLAUSE_DELIMITER,
    );
    if (!isSpeechIntroClause(sentence.slice(clauseStart, index))) continue;
    if (hasNarratorSwitchCue(sentence, index + 1, matchStart)) continue;
    return true;
  }
  return false;
}

/** 言语动词 + 冒号：冒号后的直接引语到句末都受该话语治理。 */
function speechColonGoverns(sentence: string, matchStart: number): boolean {
  for (let index = 0; index < matchStart; index += 1) {
    if (sentence[index] !== "：" && sentence[index] !== ":") continue;
    const clauseStart = clauseStartBefore(
      sentence,
      index,
      CANON_GOVERNANCE_CLAUSE_DELIMITER,
    );
    if (isSpeechIntroClause(sentence.slice(clauseStart, index))) return true;
  }
  return false;
}

/**
 * 后置引述（「…从未发生过，他说。」「…，老人低声道。」）治理同一句前面所有
 * 分句。引述分句必须位于否定之后且足够短；中间若出现叙述者转折，则不再回溯
 * 治理。
 */
function trailingAttributionGoverns(
  sentence: string,
  matchEnd: number,
): boolean {
  const contentEnd = trailingContentEnd(sentence);
  if (contentEnd <= matchEnd) return false;
  const lastClauseStart = clauseStartBefore(
    sentence,
    contentEnd,
    CANON_GOVERNANCE_CLAUSE_DELIMITER,
  );
  if (lastClauseStart <= matchEnd) return false;
  const clause = sentence.slice(lastClauseStart, contentEnd).trim();
  if (!isSpeechIntroClause(clause)) return false;
  return !hasNarratorSwitchCue(sentence, matchEnd, lastClauseStart);
}

function trailingContentEnd(sentence: string): number {
  let end = sentence.length;
  while (end > 0 && (sentence[end - 1] === " " || sentence[end - 1] === "\u3000")) {
    end -= 1;
  }
  return end;
}

/** 该分句是否以言语动词（可带短宾语，如「告诉我」）结束并引出话语。 */
function isSpeechIntroClause(clause: string): boolean {
  const trimmed = clause.replace(/[ \u3000]+$/u, "");
  if (trimmed.length === 0) return false;
  const verbStart = speechVerbStartAtClauseEnd(trimmed);
  if (verbStart !== null && speechPrefixIsShortAndClean(trimmed, verbStart)) {
    return true;
  }
  return isTellingClause(trimmed);
}

/**
 * `告诉` 后面允许一个 ≤4 字的短宾语再接逗号（「他告诉我，…」）；这是该动词
 * 常见的转述结构。宾语更长或含标点时仍按普通叙述处理，避免把「他告诉我
 * 风暴要来，灯塔熄灭从未发生过。」降级。
 */
function isTellingClause(clause: string): boolean {
  const index = clause.lastIndexOf("告诉");
  if (index < 0) return false;
  const object = clause.slice(index + 2);
  if (object.length === 0 || object.length > 4) return false;
  if (/[。！？!?；;，,、：:\n\r]/u.test(object)) return false;
  if (hasCanonSentenceTerminator(object)) return false;
  if (!speechPrefixIsShortAndClean(clause, index)) return false;
  return !prefixContainsFrameCue(object);
}

/** 分句末尾的言语动词起始下标（相对分句）；没有则返回 null。 */
function speechVerbStartAtClauseEnd(clause: string): number | null {
  const candidates = [clause];
  const last = clause.at(-1);
  if (last === "道" || last === "着" || last === "了") {
    candidates.push(clause.slice(0, -1));
  }
  for (const candidate of candidates) {
    for (const verb of CANON_SPEECH_VERBS_BY_LENGTH) {
      if (!candidate.endsWith(verb)) continue;
      const start = candidate.length - verb.length;
      if (!isSpeechVerbAllowedInContext(candidate, start, verb)) continue;
      return start;
    }
  }
  return null;
}

/** 单字言语动词必须排除常见复合词（知道/小说/问题/解答…）。 */
function isSpeechVerbAllowedInContext(
  clause: string,
  start: number,
  verb: string,
): boolean {
  if (verb.length !== 1) return true;
  const blocked = CANON_SPEECH_VERB_BLOCKED_BEFORE[verb];
  const previous = clause[start - 1];
  if (blocked && previous !== undefined && blocked.has(previous)) return false;
  if (verb === "道") {
    return isDaoSpeechVerbAllowed(clause, start);
  }
  return true;
}

/**
 * 单字 `道` 的结构性判定。
 *
 * `道` 既可以是“说道”的言语动词，也可以是“一道/这条道/门道/味道”里的
 * 量词或名词。除名词黑名单外：
 * - 紧邻数字、量词、指示词（一/两/几/这/那/每/某/条…）时，按名词处理；
 * - 紧邻言语类副词/动词字（笑/怒/低/高/大/忙…）时，按言语动词处理；
 * - 其余情况要求 `道` 前面有一个非空的短主语（长度由统一的 20 字上限约束）。
 *
 * 这样「老人道，…」仍是引述，「他走上那条道，…」不会被误当成言语动词。
 */
function isDaoSpeechVerbAllowed(clause: string, start: number): boolean {
  const previous = clause[start - 1];
  if (previous === undefined) return false;
  if (CANON_DAO_MEASURE_OR_DETERMINER_CHARS.has(previous)) return false;
  if (/[0-9０-９]/u.test(previous)) return false;
  if (CANON_DAO_SPEECH_PREFIX_CHARS.has(previous)) return true;
  return start > 0;
}

/** 言语动词前只允许 ≤20 字的短主语，且不能再嵌套另一个框架动词。 */
const CANON_SPEECH_SUBJECT_MAX_CHARS = 20;

/**
 * 言语动词前只允许短主语，且不能再嵌套另一个框架动词。
 *
 * 「他撒谎说」、「她坚持说」里的 撒谎/坚持 紧贴言语动词，视为同一个转述
 * 短语；更早出现的 以为/希望/说 等则说明这不是单纯的主语，不能降级。
 * 20 字上限覆盖「那个总在码头边打盹的老更夫坚称，…」这类长定语主语。
 */
function speechPrefixIsShortAndClean(
  clause: string,
  verbStart: number,
): boolean {
  const prefix = clause.slice(0, verbStart);
  if (prefix.length > CANON_SPEECH_SUBJECT_MAX_CHARS) return false;
  if (hasCanonSentenceTerminator(prefix)) return false;
  return !prefixContainsFrameCue(prefix);
}

function prefixContainsFrameCue(prefix: string): boolean {
  const cues: readonly string[] = [
    ...CANON_DIALOGUE_CUES,
    ...CANON_CHARACTER_ASSERTION_CUES,
    ...CANON_WISH_CUES,
    ...CANON_SPEECH_VERBS,
  ];
  for (const cue of cues) {
    let index = prefix.indexOf(cue);
    while (index >= 0) {
      if (index + cue.length !== prefix.length) return true;
      index = prefix.indexOf(cue, index + 1);
    }
  }
  return false;
}

/**
 * 裸 `说` 的同一分句/冒号治理（逗号引出的言语与后置引述由上方
 * `speechCommaGoverns` / `trailingAttributionGoverns` 处理）：
 * - 与匹配处于同一分句（`他说了…`、`他转述说…`）；或
 * - 紧跟 `：` / `:`（`他说：…`）。
 *
 * “说完/说明/说起/说来/说法/说服/说过了”不是引述动词，因此像
 * 「众人说完后便散了，灯塔熄灭从未发生过。」「这么说来，……」仍会硬拒绝；
 * 「她坚称，交出钥匙从来没有发生过。」则由言语动词 + 逗号规则降级为 warning。
 */
function hasReportingSayCue(
  sentence: string,
  matchStart: number,
  clauseStart: number,
): boolean {
  for (let index = 0; index < matchStart; index += 1) {
    if (sentence[index] !== "说") continue;
    if (isBlockedReportingSay(sentence, index)) continue;
    if (frameCueGoverns(sentence, index, index + 1, matchStart, clauseStart)) {
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

/** `骗` 只在「骗…说」「骗人」「欺骗」中作为转述/谎言框架，且必须治理匹配。 */
function hasDeceptionCue(
  sentence: string,
  matchStart: number,
  clauseStart: number,
): boolean {
  for (const cue of ["欺骗", "骗人"] as const) {
    let index = sentence.indexOf(cue);
    while (index >= 0 && index < matchStart) {
      if (
        frameCueGoverns(
          sentence,
          index,
          index + cue.length,
          matchStart,
          clauseStart,
        )
      ) {
        return true;
      }
      index = sentence.indexOf(cue, index + 1);
    }
  }
  for (let index = 0; index < matchStart; index += 1) {
    if (sentence[index] !== "骗") continue;
    if (sentence[index + 1] === "人") continue;
    if (sentence[index - 1] === "欺") continue;
    // 「骗…说」：中间必须有一个“说”作为转述标记。
    const sayIndex = sentence.indexOf("说", index + 1);
    if (sayIndex < 0 || sayIndex >= matchStart) continue;
    if (frameCueGoverns(sentence, index, index + 1, matchStart, clauseStart)) {
      return true;
    }
  }
  return false;
}

function clauseStartBefore(
  sentence: string,
  index: number,
  delimiter: RegExp,
): number {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (delimiter.test(sentence[cursor]!)) return cursor + 1;
  }
  return 0;
}

function clauseEndAfter(
  sentence: string,
  index: number,
  delimiter: RegExp,
): number {
  for (let cursor = index; cursor < sentence.length; cursor += 1) {
    if (delimiter.test(sentence[cursor]!)) return cursor;
  }
  return sentence.length;
}

const CANON_QUOTE_OPENERS = new Set(Object.keys(CANON_QUOTE_PAIRS));
const CANON_QUOTE_CLOSERS = new Set(Object.values(CANON_QUOTE_PAIRS));

/**
 * 按当前 fail-closed 策略找出成立的引号区间（按 start 升序）。
 *
 * 策略是产品决定，后续可以整体调整；调用方不应再自行写第二套配对逻辑：
 * - 段落 = 两个 \n / \r\n / \r 之间的文本。引号只在同一段内配对，并且只与
 *   同一种风格配对：`“ ”`、`「 」`、`『 』`、`‘ ’` 与 ASCII `" "`。
 * - 段内可以跨句配对（`“…。…。”` 是完整区间）；ASCII `"` 在同一段内交替
 *   开/闭。
 * - 不同风格的嵌套（如 `“…『…』…”`）各自成立。
 * - 关闭引号不匹配栈顶时：若它匹配栈中更深的同风格开引号，就关闭到那一层，
 *   丢弃中间未匹配的开引号（它们不覆盖任何文本）；否则忽略这个孤立关闭引号。
 * - 段末仍未闭合的开引号不覆盖任何文本（按旁白处理）。因此风格混用
 *   （`“…」`）、跨段的开/闭引号都不会产生遮蔽区间。
 * - `’` 单独出现常常是撇号，未匹配时忽略；`‘` 未闭合也不覆盖任何文本。
 *
 * 返回的区间只用于“引号内内容只 warning”的低置信判断；是否值得向读者提示
 * 未闭合引号由 `hasUnpairedQuote` 回答。
 */
export function findQuotedSpans(text: string): QuotedSpan[] {
  return scanQuotedText(text).spans;
}

/**
 * 该段落是否存在未闭合、孤立或风格错配的引号。
 *
 * 与 `findQuotedSpans` 使用同一套 fail-closed 策略；单独的 `’` 按撇号忽略，
 * 不算未配对。传入多段文本时，只要任一段有问题就返回 true。
 */
export function hasUnpairedQuote(paragraph: string): boolean {
  return scanQuotedText(paragraph).unpaired;
}

function scanQuotedText(text: string): {
  spans: QuotedSpan[];
  unpaired: boolean;
} {
  const spans: QuotedSpan[] = [];
  let unpaired = false;
  let paragraphStart = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index < text.length && !isLineBreak(text[index]!)) continue;
    if (scanQuoteParagraph(text, paragraphStart, index, spans)) {
      unpaired = true;
    }
    // \r\n 会在 \r 与 \n 各触发一次；中间的空段不会产生区间或误报。
    paragraphStart = index + 1;
  }
  spans.sort((left, right) => left.start - right.start);
  return { spans, unpaired };
}

/** 扫描一个段落；返回该段落是否存在未闭合/孤立/错配的引号。 */
function scanQuoteParagraph(
  text: string,
  start: number,
  end: number,
  spans: QuotedSpan[],
): boolean {
  const stack: Array<{ close: string; start: number }> = [];
  let unpaired = false;
  for (let index = start; index < end; index += 1) {
    const char = text[index]!;
    const closeIndex = deepestMatchingQuote(stack, char);
    if (closeIndex >= 0) {
      // 丢弃关闭引号内层未匹配的开引号：它们不覆盖任何文本。
      if (closeIndex < stack.length - 1) unpaired = true;
      const open = stack[closeIndex]!;
      stack.length = closeIndex;
      spans.push({ start: open.start, end: index + 1 });
      continue;
    }
    if (CANON_QUOTE_OPENERS.has(char)) {
      stack.push({ close: CANON_QUOTE_PAIRS[char]!, start: index });
      continue;
    }
    // 孤立关闭引号：`’` 常作撇号，忽略；其它关闭引号说明引号写坏了。
    if (CANON_QUOTE_CLOSERS.has(char) && char !== "’") {
      unpaired = true;
    }
  }
  if (stack.length > 0) unpaired = true;
  return unpaired;
}

/** 栈中与 `char` 匹配的最深开引号下标；没有则返回 -1。 */
function deepestMatchingQuote(
  stack: Array<{ close: string; start: number }>,
  char: string,
): number {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index]!.close === char) return index;
  }
  return -1;
}

/**
 * 把成立的引号区间（含嵌套）替换为空格，保留长度与下标；之后才切句。
 *
 * 这里的区间只来自 `findQuotedSpans`，因此未闭合/错配的引号不会遮蔽任何
 * 文本，一个笔误不会让后面的叙述者否定静默降级。引号本身也一并遮蔽，避免
 * 跨引号拼出假匹配。
 */
function maskQuotedSpans(text: string): {
  masked: string;
  quotedSpans: QuotedSpan[];
} {
  const spans = findQuotedSpans(text);
  const depthDelta = new Int32Array(text.length + 1);
  for (const span of spans) {
    depthDelta[span.start] = (depthDelta[span.start] ?? 0) + 1;
    depthDelta[span.end] = (depthDelta[span.end] ?? 0) - 1;
  }
  const chars = text.split("");
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    depth += depthDelta[index] ?? 0;
    if (depth > 0) chars[index] = " ";
  }
  return { masked: chars.join(""), quotedSpans: spans };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function eventFactKey(eventId: string): string {
  return `event:${eventId}`;
}
