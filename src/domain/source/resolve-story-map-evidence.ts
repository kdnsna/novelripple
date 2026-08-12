import {
  StoryMapContentSchema,
  type Source,
  type SourceReference,
  type StoryMapContent,
  type StoryMapContentCandidate,
} from "@/domain/schemas";
import {
  sourceReferenceForUnit,
  type EvidenceUnit,
} from "@/domain/source/evidence-units";

export type EvidenceResolutionIssue = {
  path: string;
  message: string;
};

export type EvidenceUnitResolution =
  | { success: true; references: SourceReference[] }
  | { success: false; issues: EvidenceResolutionIssue[] };

export function resolveEvidenceUnitIds(
  unitIds: string[],
  units: EvidenceUnit[],
  path: string,
): EvidenceUnitResolution {
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const seen = new Set<string>();
  const references: SourceReference[] = [];
  const issues: EvidenceResolutionIssue[] = [];

  for (const [unitIndex, unitId] of unitIds.entries()) {
    if (seen.has(unitId)) {
      issues.push({
        path: `${path}.${unitIndex}`,
        message: "Evidence Unit ID 重复",
      });
      continue;
    }
    seen.add(unitId);

    const unit = unitsById.get(unitId);
    if (!unit) {
      issues.push({
        path: `${path}.${unitIndex}`,
        message: "Evidence 引用了未知 Unit",
      });
      continue;
    }
    references.push(sourceReferenceForUnit(unit));
  }

  return issues.length > 0
    ? { success: false, issues }
    : { success: true, references };
}

export function resolveStoryMapContentCandidate(
  candidate: StoryMapContentCandidate,
  source: Source,
  units: EvidenceUnit[],
):
  | { success: true; content: StoryMapContent }
  | { success: false; issues: EvidenceResolutionIssue[] } {
  const currentSourceUnits = units.filter((unit) =>
    isUnitDerivedFromSource(unit, source),
  );
  const issues: EvidenceResolutionIssue[] = [];

  const events = candidate.events.map((event, eventIndex) => {
    const { evidenceUnitIds, ...content } = event;
    return {
      ...content,
      evidence: resolveUnitIds(
        evidenceUnitIds,
        currentSourceUnits,
        `events.${eventIndex}.evidenceUnitIds`,
        issues,
      ),
    };
  });
  const edges = candidate.edges.map((edge, edgeIndex) => {
    const { evidenceUnitIds, ...content } = edge;
    return {
      ...content,
      evidence: resolveUnitIds(
        evidenceUnitIds,
        currentSourceUnits,
        `edges.${edgeIndex}.evidenceUnitIds`,
        issues,
      ),
    };
  });
  const endingCandidates = candidate.endingCandidates.map(
    (ending, endingIndex) => {
      const { evidenceUnitIds, ...content } = ending;
      return {
        ...content,
        evidence: resolveUnitIds(
          evidenceUnitIds,
          currentSourceUnits,
          `endingCandidates.${endingIndex}.evidenceUnitIds`,
          issues,
        ),
      };
    },
  );

  if (issues.length > 0) return { success: false, issues };

  return {
    success: true,
    content: StoryMapContentSchema.parse({
      title: candidate.title,
      logline: candidate.logline,
      characters: candidate.characters,
      events,
      edges,
      endingCandidates,
    }),
  };
}

function resolveUnitIds(
  unitIds: string[],
  units: EvidenceUnit[],
  path: string,
  issues: EvidenceResolutionIssue[],
): SourceReference[] {
  const resolved = resolveEvidenceUnitIds(unitIds, units, path);
  if (!resolved.success) {
    issues.push(...resolved.issues);
    return [];
  }
  return resolved.references;
}

function isUnitDerivedFromSource(unit: EvidenceUnit, source: Source): boolean {
  if (unit.sourceId !== source.id) return false;
  const section = source.sections.find((item) => item.id === unit.sectionId);
  if (!section) return false;
  if (unit.start < section.start || unit.end > section.end) return false;
  if (unit.start >= unit.end) return false;
  return source.normalizedText.slice(unit.start, unit.end) === unit.text;
}
