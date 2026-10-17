import {
  sourceReferenceKey,
  type SourceReference,
} from "@/domain/schemas";

/**
 * 证据候选排序（纯函数、无模型调用）：
 * - Edge：按候选 Unit 到两个端点 Event 现有 Evidence Unit 的最小距离升序，
 *   距离相同按原文 Unit 顺序。
 * - Event：先按到该 Event 现有 Evidence 的距离升序，再按参与人物姓名/别名
 *   在候选文本中的命中数降序，最后按 Unit 顺序。
 *
 * 候选必须保持原文顺序传入；`sourceIndex` 就是排序兜底与上下文预览的位置。
 */
export type EvidenceRankingCandidate = {
  id: string;
  reference: SourceReference;
  text: string;
};

export type EvidenceRankingEvent = {
  id: string;
  evidence: readonly SourceReference[];
  participants?: readonly string[];
};

export type EvidenceRankingCharacter = {
  id: string;
  name: string;
  aliases: readonly string[];
};

export type RankedEvidenceCandidate<
  T extends EvidenceRankingCandidate = EvidenceRankingCandidate,
> = {
  candidate: T;
  /** 候选在原文 Unit 序列中的位置，从 0 开始。 */
  sourceIndex: number;
  /** 到目标已有 Evidence 的最小 Unit 距离；没有锚点时是 null。 */
  distance: number | null;
  /** 参与人物姓名/别名命中数；只用于 Event 排序的次级并列。 */
  nameMatches: number;
};

export function rankEvidenceForEdge<
  T extends EvidenceRankingCandidate,
>(input: {
  candidates: readonly T[];
  events: readonly EvidenceRankingEvent[];
  fromEventId: string;
  toEventId: string;
}): RankedEvidenceCandidate<T>[] {
  const endpointEvidence = [
    ...(input.events.find((event) => event.id === input.fromEventId)?.evidence ??
      []),
    ...(input.events.find((event) => event.id === input.toEventId)?.evidence ??
      []),
  ];
  return rankCandidates(input.candidates, endpointEvidence, () => 0);
}

export function rankEvidenceForEvent<
  T extends EvidenceRankingCandidate,
>(input: {
  candidates: readonly T[];
  event: EvidenceRankingEvent | null | undefined;
  characters: readonly EvidenceRankingCharacter[];
}): RankedEvidenceCandidate<T>[] {
  const labelsByParticipant = (input.event?.participants ?? []).map(
    (participantId) => {
      const character = input.characters.find(
        (candidate) => candidate.id === participantId,
      );
      if (!character) return [];
      return [...new Set([character.name, ...character.aliases])]
        .map((label) => label.trim())
        .filter(Boolean);
    },
  );

  return rankCandidates(
    input.candidates,
    input.event?.evidence ?? [],
    (text) =>
      labelsByParticipant.filter((labels) =>
        labels.some((label) => text.includes(label)),
      ).length,
  );
}

function rankCandidates<T extends EvidenceRankingCandidate>(
  candidates: readonly T[],
  anchorReferences: readonly SourceReference[],
  nameMatchesFor: (text: string) => number,
): RankedEvidenceCandidate<T>[] {
  const indexByReference = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    const key = sourceReferenceKey(candidate.reference);
    if (!indexByReference.has(key)) indexByReference.set(key, index);
  });
  const anchorIndexes = anchorReferences.flatMap((reference) => {
    const index = indexByReference.get(sourceReferenceKey(reference));
    return index === undefined ? [] : [index];
  });

  return candidates
    .map((candidate, sourceIndex) => ({
      candidate,
      sourceIndex,
      distance: minimumDistance(sourceIndex, anchorIndexes),
      nameMatches: nameMatchesFor(candidate.text),
    }))
    .sort(
      (left, right) =>
        compareDistance(left.distance, right.distance) ||
        right.nameMatches - left.nameMatches ||
        left.sourceIndex - right.sourceIndex,
    );
}

function minimumDistance(index: number, anchors: number[]): number | null {
  if (anchors.length === 0) return null;
  let minimum = Number.POSITIVE_INFINITY;
  for (const anchor of anchors) {
    minimum = Math.min(minimum, Math.abs(anchor - index));
  }
  return minimum;
}

function compareDistance(
  left: number | null,
  right: number | null,
): number {
  const leftValue = left ?? Number.POSITIVE_INFINITY;
  const rightValue = right ?? Number.POSITIVE_INFINITY;
  return leftValue - rightValue;
}
