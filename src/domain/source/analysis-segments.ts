import type { Source, SourceSection } from "@/domain/schemas";

export const ANALYSIS_CORE_MIN = 6_000;
export const ANALYSIS_CORE_TARGET = 8_000;
export const ANALYSIS_CORE_MAX = 10_000;

export type AnalysisSegment = {
  id: string;
  sourceId: string;
  sectionIds: string[];
  coreStart: number;
  coreEnd: number;
  contextStart: number;
  contextEnd: number;
};

export function deriveAnalysisSegments(source: Source): AnalysisSegment[] {
  const sections = validateAndSortSections(source);
  const groups = groupCoreSections(sections);
  rebalanceShortTail(groups);

  return groups.map((core, index) => {
    const first = core[0]!;
    const last = core.at(-1)!;
    const firstSectionIndex = sections.findIndex(
      (section) => section.id === first.id,
    );
    const context = index === 0 ? undefined : sections[firstSectionIndex - 1];

    return {
      id: `analysis_segment:${source.id}:${String(index + 1).padStart(4, "0")}`,
      sourceId: source.id,
      sectionIds: core.map((section) => section.id),
      coreStart: first.start,
      coreEnd: last.end,
      contextStart: context?.start ?? first.start,
      contextEnd: last.end,
    };
  });
}

function validateAndSortSections(source: Source): SourceSection[] {
  const sections = [...source.sections].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const ids = new Set<string>();

  for (const [index, section] of sections.entries()) {
    if (ids.has(section.id)) {
      throw new Error(`SourceSection ID 重复：${section.id}`);
    }
    ids.add(section.id);

    if (
      !Number.isInteger(section.start) ||
      !Number.isInteger(section.end) ||
      section.start < 0 ||
      section.start >= section.end ||
      section.end > source.normalizedText.length
    ) {
      throw new Error(`SourceSection 范围无效：${section.id}`);
    }

    const previous = sections[index - 1];
    if (previous && section.start < previous.end) {
      throw new Error(
        `SourceSection 范围重叠：${previous.id} / ${section.id}`,
      );
    }
  }

  if (sections.length === 0) throw new Error("SourceSection 不能为空");
  return sections;
}

function groupCoreSections(sections: SourceSection[]): SourceSection[][] {
  const groups: SourceSection[][] = [];
  let current: SourceSection[] = [];

  for (const section of sections) {
    if (current.length === 0) {
      current = [section];
      continue;
    }

    const currentLength = rangeLength(current);
    const candidateLength = section.end - current[0]!.start;
    const shouldStartNext =
      currentLength >= ANALYSIS_CORE_MIN &&
      (currentLength >= ANALYSIS_CORE_TARGET ||
        candidateLength > ANALYSIS_CORE_MAX);

    if (shouldStartNext) {
      groups.push(current);
      current = [section];
    } else {
      current.push(section);
    }
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

function rebalanceShortTail(groups: SourceSection[][]): void {
  if (groups.length < 2) return;
  const tail = groups.at(-1)!;
  const previous = groups.at(-2)!;
  if (rangeLength(tail) >= ANALYSIS_CORE_MIN) return;

  const combinedLength = tail.at(-1)!.end - previous[0]!.start;
  if (combinedLength <= ANALYSIS_CORE_MAX) {
    previous.push(...tail);
    groups.pop();
    return;
  }

  while (rangeLength(tail) < ANALYSIS_CORE_MIN && previous.length > 1) {
    const section = previous.at(-1)!;
    const previousWithoutSection = section.start - previous[0]!.start;
    const tailWithSection = tail.at(-1)!.end - section.start;
    if (
      previousWithoutSection < ANALYSIS_CORE_MIN ||
      tailWithSection > ANALYSIS_CORE_MAX
    ) {
      break;
    }
    previous.pop();
    tail.unshift(section);
  }
}

function rangeLength(sections: SourceSection[]): number {
  return sections.at(-1)!.end - sections[0]!.start;
}
