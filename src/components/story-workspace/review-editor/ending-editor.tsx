"use client";

import { sourceReferenceKey, type SourceReference, type StoryMapArtifact, type StoryMapRevisionChange } from "@/domain/schemas";

import { MissingTarget } from "./missing-target";

type EndingEditorProps = {
  artifact: StoryMapArtifact;
  endingId: string;
  onLocateEvidence: (evidence: SourceReference) => void;
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
};

export function EndingEditor({
  artifact,
  endingId,
  onLocateEvidence,
  onRevise,
  pending,
}: EndingEditorProps) {
  const ending = artifact.storyMap.endingCandidates.find(
    (candidate) => candidate.id === endingId,
  );
  if (!ending) return <MissingTarget />;
  const confirmed = artifact.review.endingCandidateConfirmations.includes(
    ending.id,
  );
  return (
    <aside className="workspace-panel review-editor-panel">
      <div className="panel-heading">
        <div>
          <span className="panel-kicker">Ending Candidate</span>
          <h2>核对结局条件</h2>
        </div>
      </div>
      <p className="event-summary">{ending.requirement}</p>
      {ending.evidence.map((evidence) => (
        <button
          className="secondary-button"
          key={sourceReferenceKey(evidence)}
          onClick={() => onLocateEvidence(evidence)}
          type="button"
        >
          在 Source 中查看 Ending Evidence
        </button>
      ))}
      <button
        className="primary-button full-width-button"
        disabled={confirmed || pending}
        onClick={() =>
          onRevise({
            type: "confirm_ending_candidate",
            endingCandidateId: ending.id,
          })
        }
        type="button"
      >
        {confirmed ? "Ending Candidate 已核对" : "确认 Ending Candidate"}
      </button>
    </aside>
  );
}
