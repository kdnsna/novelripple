import {
  type ContinuationDirection,
  type ImpactPlanArtifact,
  type Source,
  type StoryMap,
  type Worldline,
} from "@/domain/schemas";
import { sha256 } from "@/domain/source/normalize-source";

/**
 * Continuation 上下文预算（M1-06 第五节）。
 *
 * - `CONTINUATION_CONTEXT_MAX_BUDGET_CHARS`：内嵌原文总字符的绝对硬上限（6000）。
 * - `CONTINUATION_CONTEXT_MAX_SOURCE_RATIO`：内嵌原文总字符占 Source 的比例上限。
 *   实际生效预算取两者更小者：`min(6000, floor(len × 0.25))`。
 *
 * 分配时再保留 1 字符余量，因此对任意输入都严格满足
 * `totalChars < source.length × 0.25` 且 `totalChars ≤ 6000`，
 * 从机制上杜绝整书 dump（不依赖 Prompt 自觉）。
 */
export const CONTINUATION_CONTEXT_MAX_BUDGET_CHARS = 6_000;
export const CONTINUATION_CONTEXT_MAX_SOURCE_RATIO = 0.25;

/** 单个人物 Evidence 切片的最大字符数；超出者不入选（证据引用通常为句级）。 */
const MAX_CHARACTER_EVIDENCE_UNIT_CHARS = 600;
const MIN_REPRESENTATIVE_WINDOW_CHARS = 240;
const MAX_REPRESENTATIVE_WINDOW_CHARS = 800;
/** 代表窗口尺寸随 Source 长度缩放：约为原文的 1/24。 */
const REPRESENTATIVE_WINDOW_RATIO_DENOMINATOR = 24;

export type ExcerptWindowKind = "opening" | "middle" | "ending" | "divergence";

/** 确定性代表片段：全部直接切片自 `source.normalizedText`，带完整定位元数据。 */
export type ContinuationExcerpt = {
  kind: ExcerptWindowKind;
  sectionId: string;
  start: number;
  end: number;
  excerptHash: string;
  excerpt: string;
};

/** selected characters 相关 Evidence：Story Map 事件 evidence 引用的原文切片。 */
export type ContinuationCharacterEvidenceExcerpt = {
  characterId: string;
  eventId: string;
  eventTitle: string;
  sectionId: string;
  start: number;
  end: number;
  excerptHash: string;
  excerpt: string;
};

export type ContinuationContextBudget = {
  maxBudgetChars: number;
  maxSourceRatio: number;
  effectiveBudgetChars: number;
  totalChars: number;
};

export type ContinuationContextPacket = {
  sourceId: string;
  representativeExcerpts: ContinuationExcerpt[];
  characterEvidence: ContinuationCharacterEvidenceExcerpt[];
  budget: ContinuationContextBudget;
};

/**
 * 确定性 Context Selector（纯函数）。
 *
 * 无 IO、无随机：同一输入永远产生逐字节相同的输出。
 * 只做确定性的窗口切片与预算封顶，绝不复述整本 Source。
 */
export function selectContinuationContext(input: {
  storyMap: StoryMap;
  source: Source;
  worldline: Worldline;
  acceptedImpactPlan: ImpactPlanArtifact;
  selectedDirection: ContinuationDirection;
}): ContinuationContextPacket {
  const text = input.source.normalizedText;
  const length = text.length;
  const divergenceEventId =
    input.worldline.divergence?.eventId ??
    input.acceptedImpactPlan.impactPlan.divergence.eventId;

  const effectiveBudget = Math.min(
    CONTINUATION_CONTEXT_MAX_BUDGET_CHARS,
    Math.floor(length * CONTINUATION_CONTEXT_MAX_SOURCE_RATIO),
  );
  // 严格小于 len × ratio 的分配余量：totalChars ≤ effectiveBudget - 1。
  const strictCap = Math.max(0, effectiveBudget - 1);

  let windowCap = clamp(
    Math.floor(length / REPRESENTATIVE_WINDOW_RATIO_DENOMINATOR),
    MIN_REPRESENTATIVE_WINDOW_CHARS,
    MAX_REPRESENTATIVE_WINDOW_CHARS,
  );
  windowCap = Math.min(windowCap, Math.floor(strictCap / 4));

  const representativeExcerpts: ContinuationExcerpt[] = [];
  if (windowCap >= 1 && length > 0) {
    // 开头代表片段：正文前部固定窗口。
    representativeExcerpts.push(
      sliceExcerpt("opening", 0, Math.min(length, windowCap)),
    );

    // 中段代表片段：正文中段固定比例位置窗口。
    const middleStart = clamp(
      Math.floor(length / 2) - Math.floor(windowCap / 2),
      0,
      length,
    );
    representativeExcerpts.push(
      sliceExcerpt("middle", middleStart, Math.min(length, middleStart + windowCap)),
    );

    // 结尾代表片段：正文末尾窗口。
    const endingStart = Math.max(0, length - windowCap);
    representativeExcerpts.push(sliceExcerpt("ending", endingStart, length));

    // divergence 周边片段：divergence event 的第一条 evidence 定位处窗口。
    const divergenceEvent = input.storyMap.events.find(
      (event) => event.id === divergenceEventId,
    );
    const divergenceReference = divergenceEvent?.evidence[0];
    if (divergenceReference) {
      const center =
        divergenceReference.start +
        Math.floor((divergenceReference.end - divergenceReference.start) / 2);
      const start = clamp(center - Math.floor(windowCap / 2), 0, length);
      representativeExcerpts.push(
        sliceExcerpt("divergence", start, Math.min(length, start + windowCap)),
      );
    }
  }

  let remaining = strictCap - totalCharsOf(representativeExcerpts);
  const characterEvidence: ContinuationCharacterEvidenceExcerpt[] = [];
  const seenExcerptHashes = new Set(
    representativeExcerpts.map((excerpt) => excerpt.excerptHash),
  );
  for (const characterId of unique(input.selectedDirection.affectedCharacterIds)) {
    for (const event of input.storyMap.events) {
      if (!event.participants.includes(characterId)) continue;
      for (const reference of event.evidence) {
        if (remaining <= 0) break;
        if (
          reference.start < 0 ||
          reference.end > length ||
          reference.start >= reference.end
        ) {
          continue;
        }
        const excerpt = text.slice(reference.start, reference.end);
        if (
          excerpt.length === 0 ||
          excerpt.length > MAX_CHARACTER_EVIDENCE_UNIT_CHARS ||
          excerpt.length > remaining
        ) {
          continue;
        }
        const excerptHash = sha256(excerpt);
        if (seenExcerptHashes.has(excerptHash)) continue;
        seenExcerptHashes.add(excerptHash);
        characterEvidence.push({
          characterId,
          eventId: event.id,
          eventTitle: event.title,
          sectionId: reference.sectionId,
          start: reference.start,
          end: reference.end,
          excerptHash,
          excerpt,
        });
        remaining -= excerpt.length;
      }
      if (remaining <= 0) break;
    }
    if (remaining <= 0) break;
  }

  const totalChars =
    totalCharsOf(representativeExcerpts) + totalCharsOf(characterEvidence);

  return {
    sourceId: input.source.id,
    representativeExcerpts,
    characterEvidence,
    budget: {
      maxBudgetChars: CONTINUATION_CONTEXT_MAX_BUDGET_CHARS,
      maxSourceRatio: CONTINUATION_CONTEXT_MAX_SOURCE_RATIO,
      effectiveBudgetChars: effectiveBudget,
      totalChars,
    },
  };

  function sliceExcerpt(
    kind: ExcerptWindowKind,
    start: number,
    end: number,
  ): ContinuationExcerpt {
    const excerpt = text.slice(start, end);
    return {
      kind,
      sectionId: sectionIdAt(input.source, start),
      start,
      end,
      excerptHash: sha256(excerpt),
      excerpt,
    };
  }
}

/** 返回包含指定偏移的 Section id；没有匹配时返回固定兜底 id。 */
function sectionIdAt(source: Source, offset: number): string {
  for (const section of source.sections) {
    if (offset >= section.start && offset < section.end) return section.id;
  }
  return source.sections[source.sections.length - 1]?.id ?? "section_unknown";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function totalCharsOf(excerpts: { excerpt: string }[]): number {
  let total = 0;
  for (const excerpt of excerpts) total += excerpt.excerpt.length;
  return total;
}
