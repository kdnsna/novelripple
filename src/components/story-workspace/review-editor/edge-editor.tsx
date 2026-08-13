"use client";

import { useState, type FormEvent } from "react";

import type {
  SourceReference,
  StoryMapArtifact,
  StoryMapRevisionChange,
} from "@/domain/schemas";
import { EvidenceUnitPicker, type EvidencePickerOption } from "@/components/story-workspace/evidence-unit-picker";

import { EvidenceList } from "./evidence-list";
import { MissingTarget } from "./missing-target";

type EdgeEditorProps = {
  artifact: StoryMapArtifact;
  edgeId: string;
  evidenceOptions: EvidencePickerOption[];
  normalizedText: string;
  onLocateEvidence: (evidence: SourceReference) => void;
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
};

export function EdgeEditor({
  artifact,
  edgeId,
  evidenceOptions,
  normalizedText,
  onLocateEvidence,
  onRevise,
  pending,
}: EdgeEditorProps) {
  const [replacementEvidence, setReplacementEvidence] =
    useState<SourceReference | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const edge = artifact.storyMap.edges.find(
    (candidate) => candidate.id === edgeId,
  );
  if (!edge) return <MissingTarget />;
  const selectedEdgeId = edge.id;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onRevise({
      type: "update_edge",
      edgeId: selectedEdgeId,
      edgeType: String(data.get("edgeType")) as
        | "causes"
        | "enables"
        | "foreshadows",
      explanation: String(data.get("explanation") ?? ""),
      ...(replacementEvidence ? { evidence: [replacementEvidence] } : {}),
    });
  }

  return (
    <aside className="workspace-panel review-editor-panel">
      <div className="panel-heading">
        <div>
          <span className="panel-kicker">Story Edge</span>
          <h2>{edge.type}</h2>
        </div>
      </div>
      <p className="event-summary">{edge.explanation}</p>
      <EvidenceList
        artifact={artifact}
        evidence={edge.evidence}
        normalizedText={normalizedText}
        onLocateEvidence={onLocateEvidence}
        onRevise={onRevise}
        pending={pending}
        targetId={edge.id}
        targetKind="edge"
      />
      <form className="guided-review-form" onSubmit={submit}>
        <label>
          Edge 类型
          <select defaultValue={edge.type} name="edgeType">
            <option value="causes">causes</option>
            <option value="enables">enables</option>
            <option value="foreshadows">foreshadows</option>
          </select>
        </label>
        <label>
          解释
          <textarea
            defaultValue={edge.explanation}
            name="explanation"
            required
            rows={4}
          />
        </label>
        <EvidenceUnitPicker
          onSelect={setReplacementEvidence}
          options={evidenceOptions}
          selected={replacementEvidence}
        />
        <button className="primary-button" disabled={pending} type="submit">
          保存 Edge revision
        </button>
      </form>
      <div className="destructive-editor-action">
        {deleteArmed ? (
          <>
            <p>删除后该因果关系不再进入地图；旧 revision 保留。</p>
            <button
              className="danger-button"
              disabled={pending}
              onClick={() => onRevise({ type: "delete_edge", edgeId: edge.id })}
              type="button"
            >
              确认删除 Edge
            </button>
          </>
        ) : (
          <button
            className="danger-text-button"
            onClick={() => setDeleteArmed(true)}
            type="button"
          >
            删除错误 Edge
          </button>
        )}
      </div>
    </aside>
  );
}

type AddEdgeEditorProps = {
  artifact: StoryMapArtifact;
  evidenceOptions: EvidencePickerOption[];
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
};

export function AddEdgeEditor({
  artifact,
  evidenceOptions,
  onRevise,
  pending,
}: AddEdgeEditorProps) {
  const [evidence, setEvidence] = useState<SourceReference | null>(null);
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!evidence) return;
    const data = new FormData(event.currentTarget);
    onRevise({
      type: "add_edge",
      from: String(data.get("from")),
      to: String(data.get("to")),
      edgeType: String(data.get("edgeType")) as
        | "causes"
        | "enables"
        | "foreshadows",
      explanation: String(data.get("explanation") ?? ""),
      evidence: [evidence],
    });
  }
  return (
    <aside className="workspace-panel review-editor-panel">
      <div className="panel-heading">
        <div>
          <span className="panel-kicker">Causal Edge</span>
          <h2>新增 Edge</h2>
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
            起点 Event
            <select aria-label="Edge 起点 Event" name="from">
              {artifact.storyMap.events.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            终点 Event
            <select aria-label="Edge 终点 Event" name="to">
              {artifact.storyMap.events.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Edge 类型
            <select name="edgeType">
              <option value="causes">causes</option>
              <option value="enables">enables</option>
              <option value="foreshadows">foreshadows</option>
            </select>
          </label>
          <label>
            解释
            <textarea name="explanation" required rows={4} />
          </label>
          <button className="primary-button" disabled={pending} type="submit">
            新增 Edge revision
          </button>
        </form>
      ) : (
        <p className="editor-empty-guidance">选择 Evidence 后才能填写 Edge。</p>
      )}
    </aside>
  );
}
