import type { EvidenceUnit } from "@/domain/source/evidence-units";

/**
 * 分块抽取用的确定性分块。
 *
 * 思路取自已撤销的 M1-03 `analysis-segments.ts`（a0f10cf）：目标长度 + 最小/最大长度
 * + 短尾回并 + 携带前文上下文。区别在于这里**按 Evidence Unit（自然段）切分**，
 * 而不是按 SourceSection：
 * - 永远不切开一个自然段，模型引用的仍是全书稳定的 Unit ID（M1-02A 已验证有效），
 *   不再使用 M1-03 失败的逐字 exactQuote；
 * - 没有章节标题的长文本（只有一个 Section）也能正常分块。
 */
export const CHUNK_TARGET_CHARS = 6_000;
export const CHUNK_MIN_CHARS = 3_000;
export const CHUNK_MAX_CHARS = 9_000;
/** 单个自然段的硬上限：超过即 fail closed，不切分自然段（Unit ID 必须稳定）。 */
export const CHUNK_HARD_MAX_CHARS = 2 * CHUNK_MAX_CHARS;
/** 每块前面附带的只读上下文自然段数（可以引用，但不负责抽取）。 */
export const CHUNK_CONTEXT_UNITS = 2;

export type EvidenceUnitChunk = {
  id: string;
  index: number;
  /** 本块负责抽取的自然段。 */
  coreUnitIds: string[];
  /** 本块之前的上下文自然段（第一块为空）。 */
  contextUnitIds: string[];
};

export function deriveEvidenceUnitChunks(
  units: EvidenceUnit[],
  options: {
    targetChars?: number;
    minChars?: number;
    maxChars?: number;
    hardMaxChars?: number;
    contextUnits?: number;
  } = {},
): EvidenceUnitChunk[] {
  const target = options.targetChars ?? CHUNK_TARGET_CHARS;
  const min = options.minChars ?? CHUNK_MIN_CHARS;
  const max = options.maxChars ?? CHUNK_MAX_CHARS;
  const hardMax = options.hardMaxChars ?? CHUNK_HARD_MAX_CHARS;
  const contextCount = options.contextUnits ?? CHUNK_CONTEXT_UNITS;
  if (units.length === 0) throw new Error("Evidence Unit 不能为空");
  if (!(min > 0 && min <= target && target <= max)) {
    throw new Error("分块长度参数无效");
  }
  if (hardMax < max) throw new Error("分块硬上限不能小于最大长度");
  const oversized = units.find((unit) => unit.text.length > hardMax);
  if (oversized) {
    throw new Error(
      `Evidence Unit 超出硬上限：${oversized.id} 为 ${oversized.text.length} 字符，硬上限 ${hardMax}；` +
        "不切分自然段以保持 Unit ID 稳定",
    );
  }

  const groups: EvidenceUnit[][] = [];
  let current: EvidenceUnit[] = [];
  let currentLength = 0;
  for (const unit of units) {
    const length = unit.text.length;
    // 超过 max 时即使当前块还没到 min 也必须换块；单个超长自然段随后独占一块。
    const shouldStartNext =
      current.length > 0 &&
      (currentLength + length > max ||
        (currentLength >= min && currentLength >= target));
    if (shouldStartNext) {
      groups.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(unit);
    currentLength += length;
  }
  if (current.length > 0) groups.push(current);
  rebalanceShortTail(groups, min, max);

  const sourceId = units[0]!.sourceId;
  let consumed = 0;
  return groups.map((group, index) => {
    let context = units.slice(Math.max(0, consumed - contextCount), consumed);
    const coreLength = textLength(group);
    consumed += group.length;
    // 先丢最旧的上下文，保证 core + context 尽量不超过 max；core 自身超长时只能清空上下文。
    let totalLength = coreLength + textLength(context);
    while (context.length > 0 && totalLength > max) {
      totalLength -= context[0]!.text.length;
      context = context.slice(1);
    }
    return {
      id: `chunk:${sourceId}:${String(index + 1).padStart(4, "0")}`,
      index,
      coreUnitIds: group.map((unit) => unit.id),
      contextUnitIds: context.map((unit) => unit.id),
    };
  });
}

function rebalanceShortTail(
  groups: EvidenceUnit[][],
  min: number,
  max: number,
): void {
  if (groups.length < 2) return;
  const tail = groups.at(-1)!;
  const previous = groups.at(-2)!;
  if (textLength(tail) >= min) return;
  if (textLength(previous) + textLength(tail) <= max) {
    previous.push(...tail);
    groups.pop();
    return;
  }
  while (textLength(tail) < min && previous.length > 1) {
    const unit = previous.at(-1)!;
    if (
      textLength(previous) - unit.text.length < min ||
      textLength(tail) + unit.text.length > max
    ) {
      break;
    }
    previous.pop();
    tail.unshift(unit);
  }
}

function textLength(units: EvidenceUnit[]): number {
  return units.reduce((total, unit) => total + unit.text.length, 0);
}
