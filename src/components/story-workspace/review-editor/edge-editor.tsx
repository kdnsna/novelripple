"use client";

import { useState, type FormEvent } from "react";

import type {
  SourceReference,
  StoryMapArtifact,
  StoryMapRevisionChange,
} from "@/domain/schemas";
import {
  EvidenceUnitPicker,
  type EvidencePickerOption,
} from "@/components/story-workspace/evidence-unit-picker";

import { EdgeTypeHelp } from "./edge-type-help";
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
  const uncertain = artifact.review.uncertainEdgeIds.includes(edge.id);

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
        {uncertain ? <em className="review-badge">不确定</em> : null}
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
        <EdgeTypeHelp />
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
          artifact={artifact}
          onSelect={setReplacementEvidence}
          options={evidenceOptions}
          ranking={{
            kind: "edge",
            fromEventId: edge.from,
            toEventId: edge.to,
          }}
          selected={replacementEvidence}
        />
        <button className="primary-button" disabled={pending} type="submit">
          保存 Edge revision
        </button>
      </form>
      <section className="edge-uncertainty" aria-label="Edge 不确定标记">
        <div className="subsection-heading">
          <span>不确定</span>
          <small>{uncertain ? "已标记" : "可选"}</small>
        </div>
        <p>
          无法可靠归入 causes / enables / foreshadows 时，可以保留这条 Edge 并标记为不确定。
          它会留在待核队列，但不会阻塞直接开始涟漪；普通确认时视为已经看过。
        </p>
        <button
          className="secondary-button"
          disabled={pending}
          onClick={() =>
            onRevise(
              uncertain
                ? { type: "clear_edge_uncertain", edgeId: edge.id }
                : { type: "mark_edge_uncertain", edgeId: edge.id },
            )
          }
          type="button"
        >
          {uncertain ? "清除不确定标记" : "标记为不确定"}
        </button>
      </section>
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
  const [from, setFrom] = useState(artifact.storyMap.events[0]!.id);
  const [to, setTo] = useState(
    artifact.storyMap.events[1]?.id ?? artifact.storyMap.events[0]!.id,
  );

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!evidence) return;
    const data = new FormData(event.currentTarget);
    onRevise({
      type: "add_edge",
      from,
      to,
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
      <form className="guided-review-form" onSubmit={submit}>
        <label>
          起点 Event
          <select
            aria-label="Edge 起点 Event"
            onChange={(event) => setFrom(event.target.value)}
            value={from}
          >
            {artifact.storyMap.events.map((event) => (
              <option key={event.id} value={event.id}>
                {event.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          终点 Event
          <select
            aria-label="Edge 终点 Event"
            onChange={(event) => setTo(event.target.value)}
            value={to}
          >
            {artifact.storyMap.events.map((event) => (
              <option key={event.id} value={event.id}>
                {event.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Edge 类型
          <select defaultValue="causes" name="edgeType">
            <option value="causes">causes</option>
            <option value="enables">enables</option>
            <option value="foreshadows">foreshadows</option>
          </select>
        </label>
        <EdgeTypeHelp />
        <label>
          解释
          <textarea name="explanation" required rows={4} />
        </label>
        <EvidenceUnitPicker
          artifact={artifact}
          onSelect={setEvidence}
          options={evidenceOptions}
          ranking={{
            kind: "edge",
            fromEventId: from,
            toEventId: to,
          }}
          selected={evidence}
        />
        <button
          className="primary-button"
          disabled={pending || !evidence}
          type="submit"
        >
          新增 Edge revision
        </button>
      </form>
      {evidence ? null : (
        <p className="editor-empty-guidance">
          按推荐顺序选择一段原文 Evidence 后才能保存 Edge。
        </p>
      )}
    </aside>
  );
}
