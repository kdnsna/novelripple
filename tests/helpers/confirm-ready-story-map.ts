import { deriveStoryMapReview } from "@/domain/review/derive-story-map-review";
import type { Source, StoryMapArtifact } from "@/domain/schemas";
import {
  confirmStoryMapArtifact,
  createStoryMapRevision,
} from "@/server/repositories/story-map-artifact-repository";

export function completeReviewAndConfirm(input: {
  projectId: string;
  source: Source;
  artifact: StoryMapArtifact;
}): StoryMapArtifact {
  let latest = input.artifact;
  const initial = deriveStoryMapReview(latest, input.source);

  for (const characterId of initial.coreCharacterIds) {
    latest = createStoryMapRevision({
      projectId: input.projectId,
      artifactId: latest.id,
      change: { type: "confirm_character", characterId },
    });
  }
  for (const ending of latest.storyMap.endingCandidates) {
    latest = createStoryMapRevision({
      projectId: input.projectId,
      artifactId: latest.id,
      change: {
        type: "confirm_ending_candidate",
        endingCandidateId: ending.id,
      },
    });
  }
  for (const requirement of deriveStoryMapReview(latest, input.source)
    .importantEvidence) {
    latest = createStoryMapRevision({
      projectId: input.projectId,
      artifactId: latest.id,
      change:
        requirement.targetKind === "event"
          ? {
              type: "confirm_evidence",
              eventId: requirement.targetId,
              evidence: requirement.evidence,
            }
          : {
              type: "confirm_edge_evidence",
              edgeId: requirement.targetId,
              evidence: requirement.evidence,
            },
    });
  }

  return confirmStoryMapArtifact({
    projectId: input.projectId,
    artifactId: latest.id,
  });
}
