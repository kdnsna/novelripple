"use client";

import { useState, type FormEvent } from "react";

import type {
  Event,
  SourceReference,
  StoryMapArtifact,
  StoryMapRevisionChange,
} from "@/domain/schemas";

type StoryMapDetailsProps = {
  artifact: StoryMapArtifact;
  normalizedText: string;
  selectedEvent: Event;
  pending: boolean;
  onLocateEvidence: (evidence: SourceReference) => void;
  onRevise: (change: StoryMapRevisionChange) => void;
};

export function StoryMapDetails({
  artifact,
  normalizedText,
  selectedEvent,
  pending,
  onLocateEvidence,
  onRevise,
}: StoryMapDetailsProps) {
  const [editing, setEditing] = useState(false);
  const storyMap = artifact.storyMap;
  const characterNames = Object.fromEntries(
    storyMap.characters.map((character) => [character.id, character.name]),
  );
  const relatedEdges = storyMap.edges.filter(
    (edge) => edge.from === selectedEvent.id || edge.to === selectedEvent.id,
  );

  function submitEventCorrection(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    onRevise({
      type: "update_event",
      eventId: selectedEvent.id,
      title: String(formData.get("title") ?? ""),
      summary: String(formData.get("summary") ?? ""),
      participants: formData.getAll("participants").map(String),
    });
  }

  return (
    <aside className="workspace-panel detail-panel">
      <div className="panel-heading detail-heading">
        <div>
          <span className="panel-kicker">事件 {selectedEvent.sequence}</span>
          <h2>{selectedEvent.title}</h2>
        </div>
        <span className="confidence-badge">
          {selectedEvent.evidenceKind === "inference"
            ? `${Math.round((selectedEvent.confidence ?? 0) * 100)}%`
            : "Fact"}
        </span>
      </div>

      <p className="event-summary">{selectedEvent.summary}</p>
      <div className="participant-row">
        {selectedEvent.participants.map((participant) => (
          <span key={participant}>{characterNames[participant] ?? participant}</span>
        ))}
      </div>

      <section className="review-detail-section">
        <div className="subsection-heading">
          <span>状态变化</span>
          <small>{selectedEvent.stateChanges.length}</small>
        </div>
        <ul className="state-change-list">
          {selectedEvent.stateChanges.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
      </section>

      <section className="review-detail-section">
        <div className="subsection-heading">
          <span>Evidence</span>
          <small>{selectedEvent.evidence.length} 处</small>
        </div>
        <div className="review-evidence-list">
          {selectedEvent.evidence.map((evidence, index) => {
            const confirmed = artifact.review.evidenceConfirmations.some(
              (confirmation) =>
                confirmation.eventId === selectedEvent.id &&
                sameSourceReference(confirmation.evidence, evidence),
            );
            return (
              <article className="review-evidence" key={evidenceKey(evidence)}>
                <blockquote>
                  {normalizedText.slice(evidence.start, evidence.end)}
                </blockquote>
                <small>
                  {evidence.sectionId} · {evidence.start}—{evidence.end} · Hash 已验证
                </small>
                <div>
                  <button
                    className="text-button"
                    onClick={() => onLocateEvidence(evidence)}
                    type="button"
                  >
                    在原文中定位
                  </button>
                  <button
                    className="text-button"
                    disabled={confirmed || pending}
                    onClick={() =>
                      onRevise({
                        type: "confirm_evidence",
                        eventId: selectedEvent.id,
                        evidence,
                      })
                    }
                    type="button"
                  >
                    {confirmed ? "Evidence 已确认" : `确认 Evidence ${index + 1}`}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="review-detail-section">
        <div className="subsection-heading">
          <span>关联 StoryEdge</span>
          <small>{relatedEdges.length}</small>
        </div>
        <div className="review-edge-list">
          {relatedEdges.map((edge) => (
            <article key={edge.id}>
              <strong>{edge.type}</strong>
              <p>{edge.explanation}</p>
              <button
                className="danger-text-button"
                disabled={pending}
                onClick={() =>
                  onRevise({ type: "delete_edge", edgeId: edge.id })
                }
                type="button"
              >
                删除明显错误的 Edge
              </button>
            </article>
          ))}
        </div>
      </section>

      {editing ? (
        <form className="event-correction-form" onSubmit={submitEventCorrection}>
          <label htmlFor={`event-title-${selectedEvent.id}`}>事件标题</label>
          <input
            defaultValue={selectedEvent.title}
            id={`event-title-${selectedEvent.id}`}
            maxLength={200}
            name="title"
            required
          />
          <label htmlFor={`event-summary-${selectedEvent.id}`}>事件摘要</label>
          <textarea
            defaultValue={selectedEvent.summary}
            id={`event-summary-${selectedEvent.id}`}
            maxLength={2_000}
            name="summary"
            required
            rows={5}
          />
          <fieldset>
            <legend>参与人物</legend>
            {storyMap.characters.map((character) => (
              <label key={character.id}>
                <input
                  defaultChecked={selectedEvent.participants.includes(character.id)}
                  name="participants"
                  type="checkbox"
                  value={character.id}
                />
                {character.name}
              </label>
            ))}
          </fieldset>
          <div className="correction-actions">
            <button
              className="secondary-button"
              disabled={pending}
              onClick={() => setEditing(false)}
              type="button"
            >
              取消
            </button>
            <button className="primary-button" disabled={pending} type="submit">
              {pending ? "正在保存…" : "保存为新 revision"}
            </button>
          </div>
        </form>
      ) : (
        <button
          className="secondary-button review-edit-button"
          onClick={() => setEditing(true)}
          type="button"
        >
          修正事件
        </button>
      )}
    </aside>
  );
}

function sameSourceReference(left: SourceReference, right: SourceReference): boolean {
  return evidenceKey(left) === evidenceKey(right);
}

function evidenceKey(evidence: SourceReference): string {
  return [
    evidence.sourceId,
    evidence.sectionId,
    evidence.start,
    evidence.end,
    evidence.excerptHash,
  ].join(":");
}
