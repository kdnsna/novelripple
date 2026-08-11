import {
  SourceReferenceSchema,
  StoryMapContentSchema,
  type EvidenceClaim,
  type Source,
  type SourceReference,
  type StoryMapContent,
  type StoryMapContentCandidate,
} from "@/domain/schemas";
import { sha256 } from "@/domain/source/normalize-source";

export type EvidenceResolutionIssue = {
  path: string;
  message: string;
};

export type EvidenceClaimResolution =
  | { success: true; reference: SourceReference }
  | { success: false; issue: EvidenceResolutionIssue };

export function resolveEvidenceClaim(
  claim: EvidenceClaim,
  source: Source,
  path: string,
): EvidenceClaimResolution {
  const section = source.sections.find((item) => item.id === claim.sectionId);
  if (!section) {
    return {
      success: false,
      issue: {
        path: `${path}.sectionId`,
        message: `Evidence 引用了未知 Section：${claim.sectionId}`,
      },
    };
  }

  const sectionText = source.normalizedText.slice(section.start, section.end);
  const firstIndex = sectionText.indexOf(claim.exactQuote);
  if (firstIndex < 0) {
    return {
      success: false,
      issue: {
        path: `${path}.exactQuote`,
        message: "Evidence 摘录未在声明的 Section 中找到",
      },
    };
  }

  if (sectionText.indexOf(claim.exactQuote, firstIndex + 1) >= 0) {
    return {
      success: false,
      issue: {
        path: `${path}.exactQuote`,
        message: "Evidence 摘录在声明的 Section 中不唯一",
      },
    };
  }

  const start = section.start + firstIndex;
  const end = start + claim.exactQuote.length;
  return {
    success: true,
    reference: SourceReferenceSchema.parse({
      sourceId: source.id,
      sectionId: section.id,
      start,
      end,
      excerptHash: sha256(claim.exactQuote),
    }),
  };
}

export function resolveStoryMapContentCandidate(
  candidate: StoryMapContentCandidate,
  source: Source,
):
  | { success: true; content: StoryMapContent }
  | { success: false; issues: EvidenceResolutionIssue[] } {
  const issues: EvidenceResolutionIssue[] = [];

  const events = candidate.events.map((event, eventIndex) => ({
    ...event,
    evidence: resolveClaims(
      event.evidence,
      source,
      `events.${eventIndex}.evidence`,
      issues,
    ),
  }));
  const edges = candidate.edges.map((edge, edgeIndex) => ({
    ...edge,
    evidence: resolveClaims(
      edge.evidence,
      source,
      `edges.${edgeIndex}.evidence`,
      issues,
    ),
  }));
  const endingCandidates = candidate.endingCandidates.map(
    (ending, endingIndex) => ({
      ...ending,
      evidence: resolveClaims(
        ending.evidence,
        source,
        `endingCandidates.${endingIndex}.evidence`,
        issues,
      ),
    }),
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

function resolveClaims(
  claims: EvidenceClaim[],
  source: Source,
  path: string,
  issues: EvidenceResolutionIssue[],
): SourceReference[] {
  const references: SourceReference[] = [];

  for (const [claimIndex, claim] of claims.entries()) {
    const result = resolveEvidenceClaim(
      claim,
      source,
      `${path}.${claimIndex}`,
    );
    if (result.success) references.push(result.reference);
    else issues.push(result.issue);
  }

  return references;
}
