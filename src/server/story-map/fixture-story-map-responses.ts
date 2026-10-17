import type { Source, SourceReference, StoryMap } from "@/domain/schemas";
import {
  StoryMapEndingPassCandidateSchema,
  StoryMapExtractionCandidateSchema,
  StoryMapGleaningCandidateSchema,
  StoryMapMergeCandidateSchema,
  StoryMapRosterCandidateSchema,
} from "@/domain/schemas";
import { deriveEvidenceUnitChunks } from "@/domain/source/evidence-unit-chunks";
import {
  deriveEvidenceUnits,
  type EvidenceUnit,
} from "@/domain/source/evidence-units";

/**
 * 把一份已知正确的 Story Map（公开夹具 ripple-001）拆成分块管线每一步的
 * 确定性 Mock 响应，顺序与 generateStoryMap 的调用顺序一致：
 * 每块 extract → 每块 glean（空）→ names → endings → merge。
 * 只用于 Mock 配置与测试，不调用模型。
 */
export function buildFixtureStoryMapResponses(
  source: Source,
  storyMap: StoryMap,
): string[] {
  const units = deriveEvidenceUnits(source);
  const chunks = deriveEvidenceUnitChunks(units);
  const coreChunkOf = new Map<string, number>();
  for (const chunk of chunks) {
    for (const id of chunk.coreUnitIds) coreChunkOf.set(id, chunk.index);
  }
  const toUnitIds = (references: SourceReference[]) =>
    unitIdsForReferences(references, units);
  const eventChunk = new Map(
    storyMap.events.map((event) => [event.id, coreChunkOf.get(toUnitIds(event.evidence)[0]!)!]),
  );

  const extractions = chunks.map((chunk) => {
    const allowed = new Set([...chunk.contextUnitIds, ...chunk.coreUnitIds]);
    const events = storyMap.events
      .filter((event) => eventChunk.get(event.id) === chunk.index)
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ evidence, ...event }) => ({
        ...event,
        evidenceUnitIds: toUnitIds(evidence).filter((id) => allowed.has(id)),
      }));
    const eventIds = new Set(events.map((event) => event.id));
    const participantIds = new Set(events.flatMap((event) => event.participants));
    const edges = storyMap.edges
      .filter((edge) => eventIds.has(edge.from) && eventIds.has(edge.to))
      .map(({ evidence, ...edge }) => ({ ...edge, evidenceUnitIds: toUnitIds(evidence) }))
      .filter((edge) => edge.evidenceUnitIds.every((id) => allowed.has(id)));
    return StoryMapExtractionCandidateSchema.parse({
      title: storyMap.title,
      logline: storyMap.logline,
      characters: storyMap.characters
        .filter((character) => participantIds.has(character.id))
        .map((character) => ({ ...character, kind: "individual" as const })),
      events,
      edges,
    });
  });
  const inChunkEdgeIds = new Set(extractions.flatMap((extraction) => extraction.edges.map((edge) => edge.id)));

  // 与 poolChunkCandidates 的确定性改名规则一致：首次出现保留原 ID，之后为 `<id>__c<n>`。
  const seen = new Set<string>();
  const mergedFrom = new Map<string, string[]>();
  extractions.forEach((extraction, index) => {
    for (const character of extraction.characters) {
      const pooledId = seen.has(character.id) ? `${character.id}__c${index + 1}` : character.id;
      seen.add(character.id);
      mergedFrom.set(character.id, [...(mergedFrom.get(character.id) ?? []), pooledId]);
    }
  });

  const emptyGleaning = JSON.stringify(
    StoryMapGleaningCandidateSchema.parse({ characters: [], events: [], edges: [] }),
  );
  const roster = StoryMapRosterCandidateSchema.parse({
    characters: storyMap.characters
      .filter((character) => mergedFrom.has(character.id))
      .map((character) => ({ ...character, mergedFrom: mergedFrom.get(character.id)! })),
  });
  const endings = StoryMapEndingPassCandidateSchema.parse({
    additionalEvents: [],
    endings: storyMap.endingCandidates.map(({ evidence, ...ending }) => ({
      ...ending,
      evidenceUnitIds: toUnitIds(evidence),
    })),
    characterEndings: [],
  });
  const merge = StoryMapMergeCandidateSchema.parse({
    title: storyMap.title,
    logline: storyMap.logline,
    duplicateEventGroups: [],
    duplicateEndingGroups: [],
    edges: storyMap.edges
      .filter((edge) => !inChunkEdgeIds.has(edge.id))
      .map(({ evidence, ...edge }) => ({ ...edge, evidenceUnitIds: toUnitIds(evidence) })),
  });

  return [
    ...extractions.map((extraction) => JSON.stringify(extraction)),
    ...chunks.map(() => emptyGleaning),
    JSON.stringify(roster),
    JSON.stringify(endings),
    JSON.stringify(merge),
  ];
}

export function unitIdsForReferences(
  references: SourceReference[],
  units: EvidenceUnit[],
): string[] {
  const unitIds = references.map((reference) => {
    const unit = units.find(
      (candidate) =>
        candidate.sectionId === reference.sectionId &&
        candidate.start <= reference.start &&
        candidate.end >= reference.end,
    );
    if (!unit) throw new Error("Fixture Evidence 缺少对应 Unit");
    return unit.id;
  });
  return [...new Set(unitIds)];
}
