import { z } from "zod";

import type { Source, SourceReference, StoryMap } from "@/domain/schemas";
import {
  deriveEvidenceUnits,
  sourceReferenceForUnit,
  type EvidenceUnit,
} from "@/domain/source/evidence-units";

import type { M1Gold } from "./m1-gold";

/** 宽松（loose）事件/结局 Unit 邻近窗口；Gold 匹配只是近似指标，不是放行门禁。 */
export const UNIT_WINDOW = 2;
/** 严格（strict）匹配要求候选 Evidence Unit 与 gold Unit 精确相等。 */
export const STRICT_UNIT_WINDOW = 0;
/**
 * 严格匹配的内容召回下限：gold label 很短，候选是更长的转述，由 recall 承载命中。
 */
export const STRICT_CONTENT_RECALL = 0.2;
/**
 * 严格匹配的内容精确率下限：拒绝整段抄原文与堆砌
 * （复制一段源文的 precision 通常低于 0.05）。
 */
export const STRICT_CONTENT_PRECISION_FLOOR = 0.08;
/** dense chance baseline：每 3 个 Unit 放一个内容无关事件。 */
export const DENSE_BASELINE_EVENT_STRIDE = 3;

/**
 * 中文高频虚词 / 填充 bigram。strict 内容重合会先剔除这些 token，
 * 避免“他们、已经、因为”这类共同措辞制造虚假重合。
 */
export const CJK_STOPWORD_BIGRAMS: readonly string[] = [
  "一个", "一些", "这个", "那个", "这些", "那些", "他们", "我们", "你们", "自己",
  "没有", "什么", "已经", "因为", "所以", "但是", "然后", "时候", "不是", "就是",
  "还是", "可以", "知道", "起来", "出来", "一样", "这样", "那样", "这里", "那里",
  "之后", "之前", "以后", "事件", "故事", "人物", "结局", "最后", "开始", "发生",
  "如果", "虽然", "而且", "并且", "以及", "于是", "因此", "然而", "不过", "只是",
  "只有", "还有", "也是", "都是", "就会", "不会", "不能", "可能", "应该", "需要",
  "觉得", "看到", "听到", "说道", "说着", "看着", "想着", "走到", "来到", "回到",
  "出去", "进来", "进去", "下来", "上去", "过去", "现在", "当时", "此时", "后来",
  "最终", "终于", "突然", "忽然", "慢慢", "渐渐", "一直", "一定", "一起", "一边",
  "一面", "许多", "很多", "多少", "几个", "一次", "一天", "一年", "地方", "东西",
  "事情", "问题", "办法", "样子", "眼睛", "心里", "心中", "身上", "手里",
];

/** 单个虚词字符；两个都命中时该 bigram 直接丢弃。 */
export const CJK_STOP_CHARS: ReadonlySet<string> = new Set([
  "的", "了", "着", "过", "地", "得", "是", "在", "和", "与", "也", "都",
  "就", "又", "把", "被", "让", "给", "一", "不", "这", "那", "他", "她",
  "它", "我", "你",
]);

const CJK_STOPWORD_BIGRAM_SET = new Set(CJK_STOPWORD_BIGRAMS);
const CJK_CHARACTER_PATTERN = /^\p{Script=Han}$/u;
const ASCII_WORD_PATTERN = /[a-z0-9]+/gu;

/** stuffing baseline 使用的源文高频 non-stopword bigram 数。 */
const STUFFING_BIGRAM_LIMIT = 30;

type NamedCharacter = {
  id: string;
  name: string;
  aliases: string[];
};

const IdPairSchema = z
  .object({
    candidateId: z.string().min(1),
    goldId: z.string().min(1),
  })
  .strict();

const MatchRateSchema = z
  .object({
    matched: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    rate: z.number().min(0).max(1),
  })
  .strict();

const EventMatchSchema = z
  .object({
    goldTotal: z.number().int().nonnegative(),
    candidateTotal: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    recall: z.number().min(0).max(1),
    precision: z.number().min(0).max(1),
    f1: z.number().min(0).max(1),
    matchedPairs: z.array(IdPairSchema),
    unmatchedGoldIds: z.array(z.string().min(1)),
  })
  .strict();

const EdgeMatchSchema = EventMatchSchema.extend({
  hardRecall: MatchRateSchema,
}).strict();

const EndingMatchSchema = EventMatchSchema.extend({
  nonInterpretiveRecall: MatchRateSchema,
}).strict();

const LenientIdentitySchema = z
  .object({
    exactMatches: z.number().int().nonnegative(),
    expectedTotal: z.number().int().nonnegative(),
    candidateTotal: z.number().int().nonnegative(),
    precision: z.number().min(0).max(1),
    recall: z.number().min(0).max(1),
    f1: z.number().min(0).max(1),
    missingExpectedIds: z.array(z.string().min(1)),
    candidateReviewIds: z.array(z.string().min(1)),
    potentialMergeCandidateIds: z.array(z.string().min(1)),
    excludedCandidateIds: z.array(z.string().min(1)),
  })
  .strict();

const MatchMetricsSchema = z
  .object({
    recall: z.number().min(0).max(1),
    precision: z.number().min(0).max(1),
    f1: z.number().min(0).max(1),
  })
  .strict();

const ChanceMatchSchema = z
  .object({
    events: MatchMetricsSchema,
    edges: MatchMetricsSchema,
    endings: MatchMetricsSchema,
  })
  .strict();

const StrictGoldMatchSchema = z
  .object({
    events: EventMatchSchema,
    edges: EdgeMatchSchema,
    endings: EndingMatchSchema,
  })
  .strict();

const ChanceMapScoreSchema = z
  .object({ loose: ChanceMatchSchema, strict: ChanceMatchSchema })
  .strict();

const ChanceBaselineSchema = z
  .object({
    matched: ChanceMapScoreSchema,
    dense: ChanceMapScoreSchema,
    stuffing: ChanceMapScoreSchema,
    sourceCopy: ChanceMapScoreSchema,
    goldAlignedCopy: ChanceMapScoreSchema,
  })
  .strict();

export const M1GoldMatchSchema = z
  .object({
    /** 向后兼容：顶层字段始终是 loose 匹配。 */
    events: EventMatchSchema,
    edges: EdgeMatchSchema,
    endings: EndingMatchSchema,
    strict: StrictGoldMatchSchema,
    chanceBaseline: ChanceBaselineSchema,
    lenientIdentity: LenientIdentitySchema,
  })
  .strict();

export type M1GoldMatch = z.infer<typeof M1GoldMatchSchema>;
export type M1GoldEventMatch = z.infer<typeof EventMatchSchema>;
export type M1GoldEdgeMatch = z.infer<typeof EdgeMatchSchema>;
export type M1GoldEndingMatch = z.infer<typeof EndingMatchSchema>;
export type M1GoldLenientIdentity = z.infer<typeof LenientIdentitySchema>;
export type M1GoldStrictMatch = z.infer<typeof StrictGoldMatchSchema>;
export type M1GoldChanceMatch = z.infer<typeof ChanceMatchSchema>;
export type M1GoldChanceBaseline = z.infer<typeof ChanceBaselineSchema>;

/** 匹配策略参数：loose 只看 Unit 邻近，strict 额外要求精确 Unit 与内容 recall + precision floor。 */
type MatchStrategy = {
  unitWindow: number;
  minimumContentRecall: number | null;
  contentPrecisionFloor: number | null;
  assignmentOrder: "loose" | "strict";
};

const LOOSE_STRATEGY: MatchStrategy = {
  unitWindow: UNIT_WINDOW,
  minimumContentRecall: null,
  contentPrecisionFloor: null,
  assignmentOrder: "loose",
};

const STRICT_STRATEGY: MatchStrategy = {
  unitWindow: STRICT_UNIT_WINDOW,
  minimumContentRecall: STRICT_CONTENT_RECALL,
  contentPrecisionFloor: STRICT_CONTENT_PRECISION_FLOOR,
  assignmentOrder: "strict",
};

export type M1GoldMatchOptions = {
  /** 宽松匹配 Unit 窗口，默认 `UNIT_WINDOW`。 */
  looseUnitWindow?: number;
  /** 严格匹配 Unit 窗口，默认 `STRICT_UNIT_WINDOW`（0）。 */
  strictUnitWindow?: number;
  /** 严格匹配内容 recall 下限，默认 `STRICT_CONTENT_RECALL`。 */
  strictMinimumContentRecall?: number;
  /** 严格匹配内容 precision 下限，默认 `STRICT_CONTENT_PRECISION_FLOOR`。 */
  strictContentPrecisionFloor?: number;
};

type UnitBoundary = {
  unit: number;
  sectionId: string;
  start: number;
  end: number;
};

type ScoredPair = {
  candidateId: string;
  goldId: string;
  sharedUnitCount: number;
  distance: number;
  sharedCharacterCount: number;
  contentScore: number;
};

export function normalizedCharacterNames(value: {
  name: string;
  aliases: string[];
}): string[] {
  return [value.name, ...value.aliases].map(normalizeText);
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, "").toLocaleLowerCase();
}

export function mapCandidateCharactersToGold(
  candidateCharacters: NamedCharacter[],
  goldCharacters: NamedCharacter[],
): {
  candidateToGold: Map<string, string>;
  goldToCandidate: Map<string, string>;
} {
  const candidateToGold = new Map<string, string>();
  const goldToCandidate = new Map<string, string>();
  const matchedCandidateIds = new Set<string>();

  for (const gold of goldCharacters) {
    const goldNames = normalizedCharacterNames(gold);
    const candidate = candidateCharacters.find(
      (item) =>
        !matchedCandidateIds.has(item.id) &&
        normalizedCharacterNames(item).some((name) => goldNames.includes(name)),
    );
    if (!candidate) continue;
    matchedCandidateIds.add(candidate.id);
    candidateToGold.set(candidate.id, gold.id);
    goldToCandidate.set(gold.id, candidate.id);
  }

  return { candidateToGold, goldToCandidate };
}

/**
 * 纯 Gold 匹配器。仅接收已校验的 Gold / Source / Story Map，返回 ID、计数与比例，
 * 不复制任何 Gold 文本。自动匹配是近似指标，不得作为放行门禁。
 *
 * 顶层 events / edges / endings 保持旧行为（loose）；`strict` 使用精确 Unit 与
 * 内容 recall + precision floor，`chanceBaseline` 用内容无关地图给出机会水平。
 */
export function matchM1Gold(input: {
  gold: M1Gold;
  source: Source;
  storyMap: StoryMap;
  /** 人物 identity 评分使用的 gold；缺省时使用 Gold characters。 */
  expectedCharacters?: NamedCharacter[];
  options?: M1GoldMatchOptions;
}): M1GoldMatch {
  const evidenceUnits = deriveEvidenceUnits(input.source);
  const units = toUnitBoundaries(evidenceUnits);
  const looseStrategy = resolveStrategy(LOOSE_STRATEGY, input.options);
  const strictStrategy = resolveStrategy(STRICT_STRATEGY, input.options);

  const loose = evaluateGoldMatch({
    gold: input.gold,
    storyMap: input.storyMap,
    units,
    sourceId: input.source.id,
    strategy: looseStrategy,
  });
  const strict = evaluateGoldMatch({
    gold: input.gold,
    storyMap: input.storyMap,
    units,
    sourceId: input.source.id,
    strategy: strictStrategy,
  });
  const chanceMaps = buildM1ChanceBaselines({
    gold: input.gold,
    units: evidenceUnits,
  });
  const scoreChanceMap = (storyMap: StoryMap) => ({
    loose: compactChanceMatch(
      evaluateGoldMatch({
        gold: input.gold,
        storyMap,
        units,
        sourceId: input.source.id,
        strategy: looseStrategy,
      }),
    ),
    strict: compactChanceMatch(
      evaluateGoldMatch({
        gold: input.gold,
        storyMap,
        units,
        sourceId: input.source.id,
        strategy: strictStrategy,
      }),
    ),
  });
  const chanceBaseline = {
    matched: scoreChanceMap(chanceMaps.matched),
    dense: scoreChanceMap(chanceMaps.dense),
    stuffing: scoreChanceMap(chanceMaps.stuffing),
    sourceCopy: scoreChanceMap(chanceMaps.sourceCopy),
    goldAlignedCopy: scoreChanceMap(chanceMaps.goldAlignedCopy),
  };
  const lenientIdentity = scoreLenientIdentity({
    expectedCharacters: input.expectedCharacters ?? input.gold.characters,
    candidateCharacters: input.storyMap.characters,
    mentionedOnlyNames: input.gold.mentionedOnly.map((item) => item.name),
  });

  return M1GoldMatchSchema.parse({
    events: loose.events,
    edges: loose.edges,
    endings: loose.endings,
    strict,
    chanceBaseline,
    lenientIdentity,
  });
}

function resolveStrategy(
  base: MatchStrategy,
  options: M1GoldMatchOptions | undefined,
): MatchStrategy {
  if (!options) return base;
  return {
    ...base,
    unitWindow:
      base.assignmentOrder === "strict"
        ? (options.strictUnitWindow ?? base.unitWindow)
        : (options.looseUnitWindow ?? base.unitWindow),
    minimumContentRecall:
      base.assignmentOrder === "strict"
        ? (options.strictMinimumContentRecall ?? base.minimumContentRecall)
        : base.minimumContentRecall,
    contentPrecisionFloor:
      base.assignmentOrder === "strict"
        ? (options.strictContentPrecisionFloor ?? base.contentPrecisionFloor)
        : base.contentPrecisionFloor,
  };
}

function evaluateGoldMatch(input: {
  gold: M1Gold;
  storyMap: StoryMap;
  units: UnitBoundary[];
  sourceId: string;
  strategy: MatchStrategy;
}): {
  events: M1GoldEventMatch;
  edges: M1GoldEdgeMatch;
  endings: M1GoldEndingMatch;
} {
  const { candidateToGold } = mapCandidateCharactersToGold(
    input.storyMap.characters,
    input.gold.characters,
  );
  const events = matchEvents({
    gold: input.gold,
    storyMap: input.storyMap,
    units: input.units,
    sourceId: input.sourceId,
    candidateToGold,
    strategy: input.strategy,
  });
  const edges = matchEdges({
    gold: input.gold,
    storyMap: input.storyMap,
    candidateEventToGold: events.candidateToGold,
    strategy: input.strategy,
  });
  const endings = matchEndings({
    gold: input.gold,
    storyMap: input.storyMap,
    units: input.units,
    sourceId: input.sourceId,
    candidateToGold,
    strategy: input.strategy,
  });
  return { events: events.score, edges, endings };
}

function compactChanceMatch(value: {
  events: M1GoldEventMatch;
  edges: M1GoldEdgeMatch;
  endings: M1GoldEndingMatch;
}): M1GoldChanceMatch {
  return {
    events: pickMetrics(value.events),
    edges: pickMetrics(value.edges),
    endings: pickMetrics(value.endings),
  };
}

function pickMetrics(value: { recall: number; precision: number; f1: number }) {
  return { recall: value.recall, precision: value.precision, f1: value.f1 };
}

function toUnitBoundaries(units: readonly EvidenceUnit[]): UnitBoundary[] {
  return units.map((unit, index) => ({
    unit: index + 1,
    sectionId: unit.sectionId,
    start: unit.start,
    end: unit.end,
  }));
}

export type ContentOverlap = {
  recall: number;
  precision: number;
  f1: number;
};

/**
 * strict 内容信号：CJK 字符 bigram + 小写 ASCII 词，剔除中文停用 bigram
 * 与人物名（gold 和 candidate 的全部 name / alias）。
 * recall = |G∩C| / |G|，precision = |G∩C| / |C|（均为 token SET）；
 * 任一侧为空则全部为 0。
 */
export function contentOverlap(
  goldText: string,
  candidateText: string,
  characterNames: readonly string[] = [],
): ContentOverlap {
  const goldTokens = new Set(contentTokens(goldText, characterNames));
  const candidateTokens = new Set(contentTokens(candidateText, characterNames));
  if (goldTokens.size === 0 || candidateTokens.size === 0) {
    return { recall: 0, precision: 0, f1: 0 };
  }
  const shared = intersectionSize(goldTokens, candidateTokens);
  const precision = divide(shared, candidateTokens.size);
  const recall = divide(shared, goldTokens.size);
  return { recall, precision, f1: f1Score(precision, recall) };
}

function passesContentCheck(
  score: ContentOverlap | null,
  strategy: MatchStrategy,
): boolean {
  if (strategy.minimumContentRecall === null) return true;
  if (!score) return false;
  return (
    score.recall >= strategy.minimumContentRecall &&
    score.precision >= (strategy.contentPrecisionFloor ?? 0)
  );
}

function contentTokens(
  value: string,
  characterNames: readonly string[],
): string[] {
  const masked = maskStopwordBigrams(
    maskCharacterNames(
      value.normalize("NFC").toLowerCase(),
      characterNames,
    ),
  );
  const tokens: string[] = [];
  for (const match of masked.matchAll(ASCII_WORD_PATTERN)) {
    tokens.push(match[0]);
  }
  const compact = masked.replace(/[\s\p{P}\p{S}]+/gu, "");
  const chars = [...compact];
  for (let index = 0; index + 1 < chars.length; index += 1) {
    const left = chars[index]!;
    const right = chars[index + 1]!;
    if (!CJK_CHARACTER_PATTERN.test(left) || !CJK_CHARACTER_PATTERN.test(right)) {
      continue;
    }
    const bigram = `${left}${right}`;
    if (isStopwordBigram(bigram)) continue;
    tokens.push(bigram);
  }
  return tokens;
}

/**
 * 先遮掉停用 bigram，再生成相邻 bigram，避免“他们我们”被拼出“们我”
 * 这类跨停用词的假重合；剩余全虚词 bigram 仍由 `isStopwordBigram` 兜底。
 */
function maskStopwordBigrams(value: string): string {
  let masked = value;
  for (const bigram of CJK_STOPWORD_BIGRAM_SET) {
    masked = masked.split(bigram).join("\u0000");
  }
  return masked;
}

/** 用 NUL 占位符遮掉人物名，既不会生成名字 bigram，也不会跨名字拼接。 */
function maskCharacterNames(
  value: string,
  characterNames: readonly string[],
): string {
  const keys = characterNames
    .map((name) =>
      name
        .normalize("NFC")
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, ""),
    )
    .filter((name) => name.length > 0)
    .sort((left, right) => right.length - left.length);
  let masked = value;
  for (const key of new Set(keys)) {
    masked = masked.split(key).join("\u0000");
  }
  return masked;
}

function isStopwordBigram(bigram: string): boolean {
  if (CJK_STOPWORD_BIGRAM_SET.has(bigram)) return true;
  const chars = [...bigram];
  return chars.every((character) => CJK_STOP_CHARS.has(character));
}

/** 源文中最常见、非停用的 CJK bigram；按频次降序、token 升序稳定输出。 */
function mostFrequentContentBigrams(
  units: readonly EvidenceUnit[],
  limit: number,
): string[] {
  const counts = new Map<string, number>();
  for (const unit of units) {
    for (const token of contentTokens(unit.text, [])) {
      if (!isCjkBigram(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || compareIds(left[0], right[0]))
    .slice(0, limit)
    .map(([token]) => token);
}

function isCjkBigram(value: string): boolean {
  const chars = [...value];
  return (
    chars.length === 2 &&
    chars.every((character) => CJK_CHARACTER_PATTERN.test(character))
  );
}

/**
 * 内容无关的机会基线（不调用模型）：
 * - matched：事件数量与 gold 相同、Unit 在全篇均匀铺开，边按 gold 数量上限串联，
 *   结局数量与 gold 相同并落在最后 20% 的 Unit；
 * - dense：每 3 个 Unit 一个空事件；
 * - stuffing：与 matched 相同布局，但标题/摘要/结局要求都填入源文最高频的 30 个
 *   非停用 bigram；
 * - sourceCopy：与 matched 相同布局，但直接复制证据 Unit 的原文；
 * - goldAlignedCopy：oracle-position 复制基线。事件与结局直接使用 gold 的证据
 *   Unit 位置（gold 事件 / 结局自身的 Unit，按顺序去重），标题/摘要/结局要求
 *   复制这些 Unit 的原文。它使用 gold 位置，预期高于其它基线，用来衡量“在正确
 *   位置纯抄原文”能拿到多少分。
 * 五者都使用全部 gold 人物作为参与者，并分别用 loose / strict 评分。
 */
export function buildM1ChanceBaselines(input: {
  gold: M1Gold;
  units: readonly EvidenceUnit[];
}): {
  matched: StoryMap;
  dense: StoryMap;
  stuffing: StoryMap;
  sourceCopy: StoryMap;
  goldAlignedCopy: StoryMap;
} {
  const stuffingText = mostFrequentContentBigrams(
    input.units,
    STUFFING_BIGRAM_LIMIT,
  ).join(" ");
  return {
    matched: buildMatchedChanceBaseline(input.gold, input.units, {
      mapId: "chance_matched",
      eventPrefix: "chance_event",
      edgePrefix: "chance_edge",
      endingPrefix: "chance_ending",
      title: "机会基线",
      logline: "内容无关的机会基线地图",
      text: {
        eventTitle: (index) => `事件 ${index + 1}`,
        eventSummary: () => "...",
        endingRequirement: () => "...",
      },
    }),
    dense: buildDenseChanceBaseline(input.gold, input.units),
    stuffing: buildMatchedChanceBaseline(input.gold, input.units, {
      mapId: "chance_stuffing",
      eventPrefix: "stuffing_event",
      edgePrefix: "stuffing_edge",
      endingPrefix: "stuffing_ending",
      title: "填充基线",
      logline: "用源文高频 bigram 填充的对抗基线",
      text: {
        eventTitle: () => stuffingText,
        eventSummary: () => stuffingText,
        endingRequirement: () => stuffingText,
      },
    }),
    sourceCopy: buildMatchedChanceBaseline(input.gold, input.units, {
      mapId: "chance_source_copy",
      eventPrefix: "source_copy_event",
      edgePrefix: "source_copy_edge",
      endingPrefix: "source_copy_ending",
      title: "原文复制基线",
      logline: "直接复制证据 Unit 原文的对抗基线",
      text: {
        eventTitle: (_index, unit) => firstCharacters(unit.text, 20),
        eventSummary: (_index, unit) => unit.text,
        endingRequirement: (_index, unit) => unit.text,
      },
    }),
    goldAlignedCopy: buildGoldAlignedCopyBaseline(input.gold, input.units),
  };
}

type MatchedBaselineText = {
  eventTitle: (index: number, unit: EvidenceUnit) => string;
  eventSummary: (index: number, unit: EvidenceUnit) => string;
  endingRequirement: (index: number, unit: EvidenceUnit) => string;
};

type MatchedBaselineConfig = {
  mapId: string;
  eventPrefix: string;
  edgePrefix: string;
  endingPrefix: string;
  title: string;
  logline: string;
  text: MatchedBaselineText;
};

function buildMatchedChanceBaseline(
  gold: M1Gold,
  units: readonly EvidenceUnit[],
  config: MatchedBaselineConfig,
): StoryMap {
  const characters = chanceCharacters(gold);
  const participants = characters.map((character) => character.id);
  const eventCount =
    units.length > 0 && participants.length > 0 ? gold.events.length : 0;
  const events = Array.from({ length: eventCount }, (_, index) => {
    const unit = evenlySpacedUnit(units, index, eventCount);
    return chanceEvent(
      index,
      unit,
      participants,
      config.eventPrefix,
      config.text.eventTitle(index, unit),
      config.text.eventSummary(index, unit),
    );
  });
  const edgeCount = Math.min(
    gold.causalLinks.length,
    Math.max(0, eventCount - 1),
  );
  const edges = Array.from({ length: edgeCount }, (_, index) => ({
    id: `${config.edgePrefix}_${index + 1}`,
    from: events[index]!.id,
    to: events[index + 1]!.id,
    type: "causes" as const,
    explanation: "机会基线",
    confidence: 1,
    confirmed: true,
    evidence: [
      sourceReferenceForUnit(evenlySpacedUnit(units, index, eventCount)),
    ],
  }));
  const endingCount = events.length > 0 ? gold.endings.length : 0;
  const endingUnits = lastTwentyPercentUnits(units);
  const endingCandidates = Array.from({ length: endingCount }, (_, index) => {
    const eventIndex = Math.max(
      0,
      Math.min(events.length - 1, events.length - endingCount + index),
    );
    const unit =
      endingUnits[
        Math.round(
          (index * Math.max(0, endingUnits.length - 1)) /
            Math.max(1, endingCount - 1),
        )
      ] ?? units.at(-1)!;
    return {
      id: `${config.endingPrefix}_${index + 1}`,
      targetEventId: events[eventIndex]!.id,
      requirement: config.text.endingRequirement(index, unit),
      evidence: [sourceReferenceForUnit(unit)],
    };
  });

  return chanceStoryMap({
    id: config.mapId,
    title: config.title,
    logline: config.logline,
    sourceId: units[0]?.sourceId ?? "chance_source",
    characters,
    events,
    edges,
    endingCandidates,
  });
}

function firstCharacters(value: string, count: number): string {
  return [...value].slice(0, count).join("");
}

/** 按 gold evidence 顺序取 Unit，并按 unit 号去重。 */
function goldUnitsInOrder(
  evidence: ReadonlyArray<{ unit: number }>,
  units: readonly EvidenceUnit[],
): EvidenceUnit[] {
  const seen = new Set<number>();
  const result: EvidenceUnit[] = [];
  for (const item of evidence) {
    if (seen.has(item.unit)) continue;
    seen.add(item.unit);
    const unit = units[item.unit - 1];
    if (unit) result.push(unit);
  }
  return result;
}

/**
 * oracle-position 复制基线：直接使用 gold 的事件 / 结局证据 Unit 位置，
 * 复制这些 Unit 的原文。它预期高于其它基线，只衡量“位置正确时纯抄原文”的得分。
 */
function buildGoldAlignedCopyBaseline(
  gold: M1Gold,
  units: readonly EvidenceUnit[],
): StoryMap {
  const characters = chanceCharacters(gold);
  const participants = characters.map((character) => character.id);
  const eventUnits = gold.events.map((event) =>
    goldUnitsInOrder(event.evidence, units),
  );
  const events = gold.events.map((_goldEvent, index) => {
    const copiedUnits = eventUnits[index]!;
    const text = copiedUnits.map((unit) => unit.text).join("");
    return {
      id: `gold_aligned_copy_event_${index + 1}`,
      title: firstCharacters(text, 20),
      summary: text,
      sequence: index + 1,
      participants,
      stateChanges: [],
      evidenceKind: "fact" as const,
      evidence: copiedUnits.map(sourceReferenceForUnit),
    };
  });
  const edgeCount = Math.min(
    gold.causalLinks.length,
    Math.max(0, events.length - 1),
  );
  const edges = Array.from({ length: edgeCount }, (_, index) => ({
    id: `gold_aligned_copy_edge_${index + 1}`,
    from: events[index]!.id,
    to: events[index + 1]!.id,
    type: "causes" as const,
    explanation: "Gold 对齐复制基线",
    confidence: 1,
    confirmed: true,
    evidence: [
      sourceReferenceForUnit(eventUnits[index]![0] ?? units[0]!),
    ],
  }));
  // 结局指向 sequence 最大的 gold 对齐事件，与 matched 基线的串联方式一致。
  const targetEvent = events.at(-1);
  const endingCandidates = targetEvent
    ? gold.endings.map((ending, index) => {
        const copiedUnits = goldUnitsInOrder(ending.evidence, units);
        return {
          id: `gold_aligned_copy_ending_${index + 1}`,
          targetEventId: targetEvent.id,
          requirement: copiedUnits.map((unit) => unit.text).join(""),
          evidence: copiedUnits.map(sourceReferenceForUnit),
        };
      })
    : [];

  return chanceStoryMap({
    id: "chance_gold_aligned_copy",
    title: "Gold 对齐复制基线",
    logline: "使用 gold 位置直接复制证据 Unit 原文的 oracle 基线",
    sourceId: units[0]?.sourceId ?? "chance_source",
    characters,
    events,
    edges,
    endingCandidates,
  });
}

function buildDenseChanceBaseline(
  gold: M1Gold,
  units: readonly EvidenceUnit[],
): StoryMap {
  const characters = chanceCharacters(gold);
  const participants = characters.map((character) => character.id);
  const eventCount =
    participants.length > 0
      ? Math.ceil(units.length / DENSE_BASELINE_EVENT_STRIDE)
      : 0;
  const events = Array.from({ length: eventCount }, (_, index) =>
    chanceEvent(
      index,
      units[index * DENSE_BASELINE_EVENT_STRIDE]!,
      participants,
      "chance_event",
      `事件 ${index + 1}`,
      "...",
    ),
  );
  return chanceStoryMap({
    id: "chance_dense",
    title: "机会基线",
    logline: "内容无关的机会基线地图",
    sourceId: units[0]?.sourceId ?? "chance_source",
    characters,
    events,
    edges: [],
    endingCandidates: [],
  });
}

function chanceCharacters(gold: M1Gold): StoryMap["characters"] {
  return gold.characters.map((character, index) => ({
    id: `chance_char_${index + 1}`,
    name: character.name,
    aliases: [...character.aliases],
    role: "supporting",
    initialState: "机会基线占位状态",
  }));
}

function chanceEvent(
  index: number,
  unit: EvidenceUnit,
  participants: string[],
  idPrefix: string,
  title: string,
  summary: string,
): StoryMap["events"][number] {
  return {
    id: `${idPrefix}_${index + 1}`,
    title,
    summary,
    sequence: index + 1,
    participants,
    stateChanges: [],
    evidenceKind: "fact",
    evidence: [sourceReferenceForUnit(unit)],
  };
}

function chanceStoryMap(input: {
  id: string;
  title: string;
  logline: string;
  sourceId: string;
  characters: StoryMap["characters"];
  events: StoryMap["events"];
  edges: StoryMap["edges"];
  endingCandidates: StoryMap["endingCandidates"];
}): StoryMap {
  return {
    schemaVersion: 1,
    id: input.id,
    sourceId: input.sourceId,
    version: 1,
    status: "draft",
    title: input.title,
    logline: input.logline,
    characters: input.characters,
    events: input.events,
    edges: input.edges,
    endingCandidates: input.endingCandidates,
  };
}

function evenlySpacedUnit(
  units: readonly EvidenceUnit[],
  index: number,
  count: number,
): EvidenceUnit {
  if (count <= 1) return units[0]!;
  return units[Math.round((index * (units.length - 1)) / (count - 1))]!;
}

function lastTwentyPercentUnits(
  units: readonly EvidenceUnit[],
): readonly EvidenceUnit[] {
  return units.slice(Math.floor(units.length * 0.8));
}

function referenceUnitIndices(
  reference: SourceReference,
  units: UnitBoundary[],
  sourceId: string,
): number[] {
  if (reference.sourceId !== sourceId || reference.start >= reference.end) {
    return [];
  }
  return units
    .filter(
      (unit) =>
        unit.sectionId === reference.sectionId &&
        reference.start < unit.end &&
        unit.start < reference.end,
    )
    .map((unit) => unit.unit);
}

function referenceUnits(
  references: SourceReference[],
  units: UnitBoundary[],
  sourceId: string,
): Set<number> {
  const result = new Set<number>();
  for (const reference of references) {
    for (const unit of referenceUnitIndices(reference, units, sourceId)) {
      result.add(unit);
    }
  }
  return result;
}

function goldEventUnits(event: { evidence: Array<{ unit: number }> }): Set<number> {
  return new Set(event.evidence.map((item) => item.unit));
}

function minimumDistance(left: Set<number>, right: Set<number>): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const leftUnit of left) {
    for (const rightUnit of right) {
      minimum = Math.min(minimum, Math.abs(leftUnit - rightUnit));
    }
  }
  return minimum;
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let size = 0;
  for (const value of left) {
    if (right.has(value)) size += 1;
  }
  return size;
}

function sharedUnitCount(left: Set<number>, right: Set<number>): number {
  let size = 0;
  for (const value of left) {
    if (right.has(value)) size += 1;
  }
  return size;
}

function compareLoosePairs(left: ScoredPair, right: ScoredPair): number {
  return (
    right.sharedUnitCount - left.sharedUnitCount ||
    left.distance - right.distance ||
    right.sharedCharacterCount - left.sharedCharacterCount ||
    compareIds(left.candidateId, right.candidateId) ||
    compareIds(left.goldId, right.goldId)
  );
}

/** 严格匹配按内容 recall 优先、Unit 距离其次做一对一贪心。 */
function compareStrictPairs(left: ScoredPair, right: ScoredPair): number {
  return (
    right.contentScore - left.contentScore ||
    left.distance - right.distance ||
    right.sharedUnitCount - left.sharedUnitCount ||
    right.sharedCharacterCount - left.sharedCharacterCount ||
    compareIds(left.candidateId, right.candidateId) ||
    compareIds(left.goldId, right.goldId)
  );
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assignPairs<T extends ScoredPair>(
  pairs: T[],
  strategy: MatchStrategy,
): Array<{ candidateId: string; goldId: string }> {
  const assignedCandidateIds = new Set<string>();
  const assignedGoldIds = new Set<string>();
  const result: Array<{ candidateId: string; goldId: string }> = [];
  const compare =
    strategy.assignmentOrder === "strict"
      ? compareStrictPairs
      : compareLoosePairs;

  for (const pair of [...pairs].sort(compare)) {
    if (
      assignedCandidateIds.has(pair.candidateId) ||
      assignedGoldIds.has(pair.goldId)
    ) {
      continue;
    }
    assignedCandidateIds.add(pair.candidateId);
    assignedGoldIds.add(pair.goldId);
    result.push({ candidateId: pair.candidateId, goldId: pair.goldId });
  }

  return result.sort(
    (left, right) =>
      compareIds(left.candidateId, right.candidateId) ||
      compareIds(left.goldId, right.goldId),
  );
}

function matchEvents(input: {
  gold: M1Gold;
  storyMap: StoryMap;
  units: UnitBoundary[];
  sourceId: string;
  candidateToGold: Map<string, string>;
  strategy: MatchStrategy;
}): {
  score: M1GoldEventMatch;
  candidateToGold: Map<string, string>;
} {
  const pairs: ScoredPair[] = [];
  const characterNames = [
    ...input.gold.characters.flatMap((character) => [
      character.name,
      ...character.aliases,
    ]),
    ...input.storyMap.characters.flatMap((character) => [
      character.name,
      ...character.aliases,
    ]),
  ];

  for (const candidate of input.storyMap.events) {
    const candidateUnits = referenceUnits(
      candidate.evidence,
      input.units,
      input.sourceId,
    );
    if (candidateUnits.size === 0) continue;
    const candidateGoldCharacters = new Set(
      candidate.participants
        .map((participant) => input.candidateToGold.get(participant))
        .filter((characterId): characterId is string => characterId !== undefined),
    );

    for (const gold of input.gold.events) {
      const goldUnits = goldEventUnits(gold);
      if (goldUnits.size === 0) continue;
      const distance = minimumDistance(candidateUnits, goldUnits);
      if (distance > input.strategy.unitWindow) continue;
      const characterIds = new Set(gold.characterIds);
      const sharedCharacterCount = intersectionSize(
        candidateGoldCharacters,
        characterIds,
      );
      if (characterIds.size > 0 && sharedCharacterCount === 0) continue;
      const content = input.strategy.minimumContentRecall === null
        ? null
        : contentOverlap(
            gold.label,
            `${candidate.title} ${candidate.summary}`,
            characterNames,
          );
      if (!passesContentCheck(content, input.strategy)) continue;
      pairs.push({
        candidateId: candidate.id,
        goldId: gold.id,
        sharedUnitCount: sharedUnitCount(candidateUnits, goldUnits),
        distance,
        sharedCharacterCount,
        contentScore: content?.recall ?? 0,
      });
    }
  }

  const matchedPairs = assignPairs(pairs, input.strategy);
  const candidateToGold = new Map(
    matchedPairs.map((pair) => [pair.candidateId, pair.goldId] as const),
  );
  const matchedGoldIds = new Set(matchedPairs.map((pair) => pair.goldId));
  const score = buildMatchScore(
    matchedPairs,
    input.gold.events.map((event) => event.id),
    input.storyMap.events.length,
    new Set(matchedGoldIds),
  );

  return { score, candidateToGold };
}

function matchEdges(input: {
  gold: M1Gold;
  storyMap: StoryMap;
  candidateEventToGold: Map<string, string>;
  strategy: MatchStrategy;
}): M1GoldEdgeMatch {
  const pairs: ScoredPair[] = [];

  for (const edge of input.storyMap.edges) {
    const from = input.candidateEventToGold.get(edge.from);
    const to = input.candidateEventToGold.get(edge.to);
    if (!from || !to) continue;
    for (const link of input.gold.causalLinks) {
      if (link.from !== from || link.to !== to) continue;
      pairs.push({
        candidateId: edge.id,
        goldId: link.id,
        sharedUnitCount: 0,
        distance: 0,
        sharedCharacterCount: 0,
        contentScore: 0,
      });
    }
  }

  const matchedPairs = assignPairs(pairs, input.strategy);
  const matchedGoldIds = new Set(matchedPairs.map((pair) => pair.goldId));
  const goldIds = input.gold.causalLinks.map((link) => link.id);
  const score = buildMatchScore(
    matchedPairs,
    goldIds,
    input.storyMap.edges.length,
    matchedGoldIds,
  );
  const hardGoldIds = new Set(
    input.gold.causalLinks
      .filter((link) => link.strength === "hard")
      .map((link) => link.id),
  );
  const hardMatched = [...matchedGoldIds].filter((id) =>
    hardGoldIds.has(id),
  ).length;

  return {
    ...score,
    hardRecall: rateScore(hardMatched, hardGoldIds.size),
  };
}

function matchEndings(input: {
  gold: M1Gold;
  storyMap: StoryMap;
  units: UnitBoundary[];
  sourceId: string;
  candidateToGold: Map<string, string>;
  strategy: MatchStrategy;
}): M1GoldEndingMatch {
  const pairs: ScoredPair[] = [];
  const eventsById = new Map(
    input.storyMap.events.map((event) => [event.id, event] as const),
  );
  const characterNames = [
    ...input.gold.characters.flatMap((character) => [
      character.name,
      ...character.aliases,
    ]),
    ...input.storyMap.characters.flatMap((character) => [
      character.name,
      ...character.aliases,
    ]),
  ];

  for (const ending of input.storyMap.endingCandidates) {
    const targetEvent = eventsById.get(ending.targetEventId);
    const candidateUnits = referenceUnits(
      ending.evidence,
      input.units,
      input.sourceId,
    );
    // strict 只看结局自身的 Evidence Unit；loose 仍允许通过目标事件定位。
    if (input.strategy.minimumContentRecall === null && targetEvent) {
      for (const unit of referenceUnits(
        targetEvent.evidence,
        input.units,
        input.sourceId,
      )) {
        candidateUnits.add(unit);
      }
    }
    if (candidateUnits.size === 0) continue;

    const candidateGoldCharacters = new Set<string>();
    for (const participant of targetEvent?.participants ?? []) {
      const characterId = input.candidateToGold.get(participant);
      if (characterId) candidateGoldCharacters.add(characterId);
    }
    const requirement = normalizeText(ending.requirement);
    for (const candidateCharacter of input.storyMap.characters) {
      const goldId = input.candidateToGold.get(candidateCharacter.id);
      if (!goldId) continue;
      const goldCharacter = input.gold.characters.find(
        (item) => item.id === goldId,
      );
      const names = new Set([
        ...normalizedCharacterNames(candidateCharacter),
        ...(goldCharacter ? normalizedCharacterNames(goldCharacter) : []),
      ]);
      if ([...names].some((name) => name.length > 0 && requirement.includes(name))) {
        candidateGoldCharacters.add(goldId);
      }
    }

    for (const gold of input.gold.endings) {
      const goldUnits = new Set(gold.evidence.map((item) => item.unit));
      if (goldUnits.size === 0) continue;
      const distance = minimumDistance(candidateUnits, goldUnits);
      if (distance > input.strategy.unitWindow) continue;
      const goldCharacterIds = new Set(gold.characterIds);
      const sharedCharacterCount = intersectionSize(
        candidateGoldCharacters,
        goldCharacterIds,
      );
      if (goldCharacterIds.size > 0 && sharedCharacterCount === 0) continue;
      const content = input.strategy.minimumContentRecall === null
        ? null
        : contentOverlap(gold.label, ending.requirement, characterNames);
      if (!passesContentCheck(content, input.strategy)) continue;
      pairs.push({
        candidateId: ending.id,
        goldId: gold.id,
        sharedUnitCount: sharedUnitCount(candidateUnits, goldUnits),
        distance,
        sharedCharacterCount,
        contentScore: content?.recall ?? 0,
      });
    }
  }

  const matchedPairs = assignPairs(pairs, input.strategy);
  const matchedGoldIds = new Set(matchedPairs.map((pair) => pair.goldId));
  const score = buildMatchScore(
    matchedPairs,
    input.gold.endings.map((ending) => ending.id),
    input.storyMap.endingCandidates.length,
    matchedGoldIds,
  );
  const nonInterpretiveGoldIds = new Set(
    input.gold.endings
      .filter((ending) => !ending.interpretive)
      .map((ending) => ending.id),
  );
  const nonInterpretiveMatched = [...matchedGoldIds].filter((id) =>
    nonInterpretiveGoldIds.has(id),
  ).length;

  return {
    ...score,
    nonInterpretiveRecall: rateScore(
      nonInterpretiveMatched,
      nonInterpretiveGoldIds.size,
    ),
  };
}

function buildMatchScore(
  matchedPairs: Array<{ candidateId: string; goldId: string }>,
  goldIds: string[],
  candidateTotal: number,
  matchedGoldIds: Set<string>,
): {
  goldTotal: number;
  candidateTotal: number;
  matched: number;
  recall: number;
  precision: number;
  f1: number;
  matchedPairs: Array<{ candidateId: string; goldId: string }>;
  unmatchedGoldIds: string[];
} {
  const matched = matchedPairs.length;
  const recall = divide(matched, goldIds.length);
  const precision = divide(matched, candidateTotal);
  return {
    goldTotal: goldIds.length,
    candidateTotal,
    matched,
    recall,
    precision,
    f1: f1Score(precision, recall),
    matchedPairs,
    unmatchedGoldIds: goldIds.filter((id) => !matchedGoldIds.has(id)),
  };
}

function scoreLenientIdentity(input: {
  expectedCharacters: NamedCharacter[];
  candidateCharacters: NamedCharacter[];
  mentionedOnlyNames: string[];
}): M1GoldLenientIdentity {
  const matchedExpectedIds = new Set<string>();
  const matchedCandidateIds = new Set<string>();

  for (const expected of input.expectedCharacters) {
    const expectedNames = normalizedCharacterNames(expected);
    const candidate = input.candidateCharacters.find(
      (item) =>
        !matchedCandidateIds.has(item.id) &&
        normalizedCharacterNames(item).some((name) =>
          expectedNames.includes(name),
        ),
    );
    if (!candidate) continue;
    matchedExpectedIds.add(expected.id);
    matchedCandidateIds.add(candidate.id);
  }

  const mentionedOnlyNames = new Set(
    input.mentionedOnlyNames.map(normalizeText),
  );
  const mentionedOnlyCandidateIds = input.candidateCharacters
    .filter((candidate) =>
      normalizedCharacterNames(candidate).some((name) =>
        mentionedOnlyNames.has(name),
      ),
    )
    .map((candidate) => candidate.id);
  const excludedCandidateIds = mentionedOnlyCandidateIds.filter(
    (id) => !matchedCandidateIds.has(id),
  );
  const candidateTotal =
    input.candidateCharacters.length - excludedCandidateIds.length;
  const exactMatches = matchedExpectedIds.size;
  const precision = divide(exactMatches, candidateTotal);
  const recall = divide(exactMatches, input.expectedCharacters.length);

  return {
    exactMatches,
    expectedTotal: input.expectedCharacters.length,
    candidateTotal,
    precision,
    recall,
    f1: f1Score(precision, recall),
    missingExpectedIds: input.expectedCharacters
      .filter((item) => !matchedExpectedIds.has(item.id))
      .map((item) => item.id),
    candidateReviewIds: input.candidateCharacters
      .filter((item) => !matchedCandidateIds.has(item.id))
      .map((item) => item.id),
    potentialMergeCandidateIds: input.candidateCharacters
      .filter((candidate) => {
        const candidateNames = normalizedCharacterNames(candidate);
        return (
          input.expectedCharacters.filter((expected) =>
            normalizedCharacterNames(expected).some((name) =>
              candidateNames.includes(name),
            ),
          ).length > 1
        );
      })
      .map((item) => item.id),
    excludedCandidateIds,
  };
}

function rateScore(matched: number, total: number) {
  return { matched, total, rate: divide(matched, total) };
}

function divide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function f1Score(precision: number, recall: number): number {
  return precision + recall === 0
    ? 0
    : (2 * precision * recall) / (precision + recall);
}

