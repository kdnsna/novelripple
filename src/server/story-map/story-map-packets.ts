import type { SourceSection } from "@/domain/schemas";
import type { AnalysisSegment } from "@/domain/source/analysis-segments";
import type {
  ResolvedSegmentCandidate,
  TemporaryEvidenceReference,
} from "@/domain/source/resolve-story-map-evidence";

export function buildAnalysisSegmentPacket(input: {
  sourceId: string;
  normalizedText: string;
  sections: SourceSection[];
  segment: AnalysisSegment;
}): string {
  const sections = input.sections
    .filter(
      (section) =>
        section.start >= input.segment.contextStart &&
        section.end <= input.segment.contextEnd,
    )
    .map((section) => ({
      id: section.id,
      title: section.title,
      ownership: input.segment.sectionIds.includes(section.id)
        ? "core"
        : "context",
      text: input.normalizedText.slice(section.start, section.end),
    }));

  return [
    `<analysis_segment id="${input.segment.id}" sourceId="${input.sourceId}" coreStart="${input.segment.coreStart}" coreEnd="${input.segment.coreEnd}">`,
    JSON.stringify(sections),
    "</analysis_segment>",
  ].join("\n");
}

export function buildGlobalReconcilePacket(input: {
  sourceId: string;
  sections: SourceSection[];
  segments: AnalysisSegment[];
  candidates: ResolvedSegmentCandidate[];
  references: TemporaryEvidenceReference[];
}): string {
  return [
    `<story_map_reconcile sourceId="${input.sourceId}">`,
    "<section_index>",
    JSON.stringify(
      input.sections.map(({ id, title, start, end }) => ({
        id,
        title,
        start,
        end,
      })),
    ),
    "</section_index>",
    "<analysis_segments>",
    JSON.stringify(
      input.segments.map(
        ({ id, sectionIds, coreStart, coreEnd, contextStart, contextEnd }) => ({
          id,
          sectionIds,
          coreStart,
          coreEnd,
          contextStart,
          contextEnd,
        }),
      ),
    ),
    "</analysis_segments>",
    "<temporary_evidence_references>",
    JSON.stringify(
      input.references.map(({ id, reference }) => ({ id, ...reference })),
    ),
    "</temporary_evidence_references>",
    "<segment_candidates>",
    JSON.stringify(input.candidates),
    "</segment_candidates>",
    "</story_map_reconcile>",
  ].join("\n");
}
