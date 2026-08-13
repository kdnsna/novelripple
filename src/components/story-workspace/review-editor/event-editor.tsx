"use client";

import { useState, type FormEvent } from "react";

import type {
  Event,
  SourceReference,
  StoryMapArtifact,
  StoryMapRevisionChange,
} from "@/domain/schemas";
import {
  EvidenceUnitPicker,
  type EvidencePickerOption,
} from "@/components/story-workspace/evidence-unit-picker";

import { EvidenceList } from "./evidence-list";
import { MissingTarget } from "./missing-target";

type EventEditorProps = {
  artifact: StoryMapArtifact;
  eventId: string;
  normalizedText: string;
  onLocateEvidence: (evidence: SourceReference) => void;
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
};

export function EventEditor({
  artifact,
  eventId,
  normalizedText,
  onLocateEvidence,
  onRevise,
  pending,
}: EventEditorProps) {
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const event = artifact.storyMap.events.find(
    (candidate) => candidate.id === eventId,
  );
  if (!event) return <MissingTarget />;
  const selectedEventId = event.id;

  function submit(changeEvent: FormEvent<HTMLFormElement>): void {
    changeEvent.preventDefault();
    const data = new FormData(changeEvent.currentTarget);
    const participants = data.getAll("participants").map(String);
    if (participants.length === 0) {
      setFormError("至少选择一位参与人物。");
      return;
    }
    setFormError(null);
    const confidenceValue = String(data.get("confidence") ?? "").trim();
    onRevise({
      type: "update_event",
      eventId: selectedEventId,
      title: String(data.get("title") ?? ""),
      summary: String(data.get("summary") ?? ""),
      participants,
      stateChanges: String(data.get("stateChanges") ?? "")
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
      evidenceKind: String(data.get("evidenceKind")) as Event["evidenceKind"],
      ...(confidenceValue ? { confidence: Number(confidenceValue) } : {}),
    });
  }

  return (
    <aside className="workspace-panel review-editor-panel">
      <div className="panel-heading detail-heading">
        <div>
          <span className="panel-kicker">Event {event.sequence}</span>
          <h2>{event.title}</h2>
        </div>
        <span className="confidence-badge">
          {event.evidenceKind === "inference"
            ? `${Math.round((event.confidence ?? 0) * 100)}%`
            : "Fact"}
        </span>
      </div>
      <p className="event-summary">{event.summary}</p>
      <EvidenceList
        artifact={artifact}
        evidence={event.evidence}
        normalizedText={normalizedText}
        onLocateEvidence={onLocateEvidence}
        onRevise={onRevise}
        pending={pending}
        targetId={event.id}
        targetKind="event"
      />
      <details className="editor-details">
        <summary>修正 Event</summary>
        <form className="guided-review-form" onSubmit={submit}>
          <label>
            事件标题
            <input defaultValue={event.title} name="title" required />
          </label>
          <label>
            事件摘要
            <textarea
              defaultValue={event.summary}
              name="summary"
              required
              rows={4}
            />
          </label>
          <label>
            状态变化（每行一项）
            <textarea
              defaultValue={event.stateChanges.join("\n")}
              name="stateChanges"
              rows={3}
            />
          </label>
          <label>
            Evidence 类型
            <select defaultValue={event.evidenceKind} name="evidenceKind">
              <option value="fact">fact</option>
              <option value="inference">inference</option>
            </select>
          </label>
          <label>
            推断置信度
            <input
              defaultValue={event.confidence}
              max="1"
              min="0"
              name="confidence"
              step="0.01"
              type="number"
            />
          </label>
          <fieldset>
            <legend>参与人物</legend>
            {artifact.storyMap.characters.map((character) => (
              <label key={character.id}>
                <input
                  defaultChecked={event.participants.includes(character.id)}
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
          <button className="primary-button" disabled={pending} type="submit">
            保存 Event revision
          </button>
        </form>
      </details>
      <div className="destructive-editor-action">
        {deleteArmed ? (
          <>
            <p>会同时移除关联 Edge 和 Ending Candidate；旧 revision 保留。</p>
            <button
              className="danger-button"
              disabled={pending}
              onClick={() =>
                onRevise({ type: "delete_event", eventId: event.id })
              }
              type="button"
            >
              确认删除 Event
            </button>
          </>
        ) : (
          <button
            className="danger-text-button"
            onClick={() => setDeleteArmed(true)}
            type="button"
          >
            删除错误 Event
          </button>
        )}
      </div>
    </aside>
  );
}

type AddEventEditorProps = {
  artifact: StoryMapArtifact;
  evidenceOptions: EvidencePickerOption[];
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
};

export function AddEventEditor({
  artifact,
  evidenceOptions,
  onRevise,
  pending,
}: AddEventEditorProps) {
  const [evidence, setEvidence] = useState<SourceReference | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!evidence) return;
    const data = new FormData(event.currentTarget);
    const participants = data.getAll("participants").map(String);
    if (participants.length === 0) {
      setFormError("至少选择一位参与人物。");
      return;
    }
    setFormError(null);
    const evidenceKind = String(data.get("evidenceKind")) as Event["evidenceKind"];
    const confidenceValue = String(data.get("confidence") ?? "").trim();
    onRevise({
      type: "add_event",
      title: String(data.get("title") ?? ""),
      summary: String(data.get("summary") ?? ""),
      participants,
      stateChanges: String(data.get("stateChanges") ?? "")
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
      evidenceKind,
      ...(confidenceValue ? { confidence: Number(confidenceValue) } : {}),
      evidence: [evidence],
    });
  }

  return (
    <aside className="workspace-panel review-editor-panel">
      <div className="panel-heading">
        <div>
          <span className="panel-kicker">Missing Event</span>
          <h2>补充遗漏 Event</h2>
        </div>
      </div>
      <EvidenceUnitPicker
        onSelect={setEvidence}
        options={evidenceOptions}
        selected={evidence}
      />
      {evidence ? (
        <form className="guided-review-form" onSubmit={submit}>
          <label>
            事件标题
            <input name="title" required />
          </label>
          <label>
            事件摘要
            <textarea name="summary" required rows={4} />
          </label>
          <label>
            状态变化（每行一项）
            <textarea name="stateChanges" rows={3} />
          </label>
          <label>
            Evidence 类型
            <select defaultValue="fact" name="evidenceKind">
              <option value="fact">fact</option>
              <option value="inference">inference</option>
            </select>
          </label>
          <label>
            推断置信度
            <input max="1" min="0" name="confidence" step="0.01" type="number" />
          </label>
          <fieldset>
            <legend>参与人物</legend>
            {artifact.storyMap.characters.map((character) => (
              <label key={character.id}>
                <input name="participants" type="checkbox" value={character.id} />
                {character.name}
              </label>
            ))}
          </fieldset>
          {formError ? (
            <p className="form-error" role="alert">
              {formError}
            </p>
          ) : null}
          <button className="primary-button" disabled={pending} type="submit">
            新增 Event revision
          </button>
        </form>
      ) : (
        <p className="editor-empty-guidance">选择 Evidence 后才能填写 Event。</p>
      )}
    </aside>
  );
}
