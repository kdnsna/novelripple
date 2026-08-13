"use client";

import { useState, type FormEvent } from "react";

import {
  type Event,
  type SourceReference,
  type StoryMapArtifact,
  type StoryMapRevisionChange,
} from "@/domain/schemas";

import { EvidenceList } from "./review-editor/evidence-list";

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
  const [deleteArmedEdgeId, setDeleteArmedEdgeId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
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
    const participants = formData.getAll("participants").map(String);
    if (participants.length === 0) {
      setFormError("至少选择一位参与人物。");
      return;
    }
    setFormError(null);
    onRevise({
      type: "update_event",
      eventId: selectedEvent.id,
      title: String(formData.get("title") ?? ""),
      summary: String(formData.get("summary") ?? ""),
      participants,
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
          <span key={participant}>
            {characterNames[participant] ?? participant}
          </span>
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

      <EvidenceList
        artifact={artifact}
        evidence={selectedEvent.evidence}
        normalizedText={normalizedText}
        onLocateEvidence={onLocateEvidence}
        onRevise={onRevise}
        pending={pending}
        targetId={selectedEvent.id}
        targetKind="event"
      />

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
              {deleteArmedEdgeId === edge.id ? (
                <>
                  <p>删除后该因果关系不再进入地图；旧 revision 保留。</p>
                  <button
                    className="danger-button"
                    disabled={pending}
                    onClick={() => {
                      setDeleteArmedEdgeId(null);
                      onRevise({ type: "delete_edge", edgeId: edge.id });
                    }}
                    type="button"
                  >
                    确认删除 Edge
                  </button>
                </>
              ) : (
                <button
                  className="danger-text-button"
                  disabled={pending}
                  onClick={() => setDeleteArmedEdgeId(edge.id)}
                  type="button"
                >
                  删除错误 Edge
                </button>
              )}
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
                  defaultChecked={selectedEvent.participants.includes(
                    character.id,
                  )}
                  name="participants"
                  type="checkbox"
                  value={character.id}
                />
                {character.name}
              </label>
            ))}
          </fieldset>
          {formError ? (
            <p className="form-error" role="alert">
              {formError}
            </p>
          ) : null}
          <div className="correction-actions">
            <button
              className="secondary-button"
              disabled={pending}
              onClick={() => {
                setEditing(false);
                setFormError(null);
              }}
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
