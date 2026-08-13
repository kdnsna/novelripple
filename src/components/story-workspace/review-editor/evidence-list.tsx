"use client";

import {
  sourceReferenceKey,
  type SourceReference,
  type StoryMapArtifact,
  type StoryMapRevisionChange,
} from "@/domain/schemas";

type EvidenceListProps = {
  artifact: StoryMapArtifact;
  evidence: SourceReference[];
  normalizedText: string;
  onLocateEvidence: (evidence: SourceReference) => void;
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
  targetId: string;
  targetKind: "event" | "edge";
};

/**
 * Event 与 Edge 共用的 Evidence 列表：展示原文片段、定位与确认。
 * StoryMapDetails 与核对编辑器都必须使用这一份实现，避免交互语义漂移。
 */
export function EvidenceList({
  artifact,
  evidence,
  normalizedText,
  onLocateEvidence,
  onRevise,
  pending,
  targetId,
  targetKind,
}: EvidenceListProps) {
  return (
    <section className="review-detail-section">
      <div className="subsection-heading">
        <span>Evidence</span>
        <small>{evidence.length} 处</small>
      </div>
      <div className="review-evidence-list">
        {evidence.map((reference, index) => {
          const confirmed =
            targetKind === "event"
              ? artifact.review.evidenceConfirmations.some(
                  (item) =>
                    item.eventId === targetId &&
                    sourceReferenceKey(item.evidence) ===
                      sourceReferenceKey(reference),
                )
              : artifact.review.edgeEvidenceConfirmations.some(
                  (item) =>
                    item.edgeId === targetId &&
                    sourceReferenceKey(item.evidence) ===
                      sourceReferenceKey(reference),
                );
          return (
            <article
              className="review-evidence"
              key={sourceReferenceKey(reference)}
            >
              <blockquote>
                {normalizedText.slice(reference.start, reference.end)}
              </blockquote>
              <small>
                {reference.sectionId} · {reference.start}—{reference.end} ·
                Hash 已验证
              </small>
              <div>
                <button
                  className="text-button"
                  onClick={() => onLocateEvidence(reference)}
                  type="button"
                >
                  在原文中定位
                </button>
                <button
                  className="text-button"
                  disabled={confirmed || pending}
                  onClick={() =>
                    onRevise(
                      targetKind === "event"
                        ? {
                            type: "confirm_evidence",
                            eventId: targetId,
                            evidence: reference,
                          }
                        : {
                            type: "confirm_edge_evidence",
                            edgeId: targetId,
                            evidence: reference,
                          },
                    )
                  }
                  type="button"
                >
                  {confirmed
                    ? "Evidence 已确认"
                    : targetKind === "event"
                      ? `确认 Evidence ${index + 1}`
                      : `确认 Edge Evidence ${index + 1}`}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
