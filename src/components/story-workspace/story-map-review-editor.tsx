"use client";

import { useMemo, useState, type FormEvent } from "react";

import type { StoryMapReviewQueueItem } from "@/domain/review/derive-story-map-review";
import type {
  Event,
  SourceReference,
  StoryMapArtifact,
  StoryMapRevisionChange,
} from "@/domain/schemas";
import {
  EvidenceUnitPicker,
  type EvidencePickerOption,
} from "./evidence-unit-picker";

export type ReviewEditorSelection =
  | { kind: "queue"; item: StoryMapReviewQueueItem }
  | {
      kind: "tool";
      tool: "character" | "add_event" | "reorder" | "add_edge";
    };

type StoryMapReviewEditorProps = {
  artifact: StoryMapArtifact;
  evidenceOptions: EvidencePickerOption[];
  normalizedText: string;
  onLocateEvidence: (evidence: SourceReference) => void;
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
  selection: ReviewEditorSelection;
};

export function StoryMapReviewEditor({
  artifact,
  evidenceOptions,
  normalizedText,
  onLocateEvidence,
  onRevise,
  pending,
  selection,
}: StoryMapReviewEditorProps) {
  if (selection.kind === "tool") {
    if (selection.tool === "character") {
      return (
        <CharacterEditor
          artifact={artifact}
          characterIds={artifact.storyMap.characters.map((character) => character.id)}
          onRevise={onRevise}
          pending={pending}
          showMerge
        />
      );
    }
    if (selection.tool === "add_event") {
      return (
        <AddEventEditor
          artifact={artifact}
          evidenceOptions={evidenceOptions}
          onRevise={onRevise}
          pending={pending}
        />
      );
    }
    if (selection.tool === "reorder") {
      return (
        <ReorderEditor
          artifact={artifact}
          onRevise={onRevise}
          pending={pending}
        />
      );
    }
    return (
      <AddEdgeEditor
        artifact={artifact}
        evidenceOptions={evidenceOptions}
        onRevise={onRevise}
        pending={pending}
      />
    );
  }

  const { item } = selection;
  if (item.targetKind === "character") {
    return (
      <CharacterEditor
        artifact={artifact}
        characterIds={[item.targetId, ...item.relatedTargetIds]}
        onRevise={onRevise}
        pending={pending}
        showMerge={item.category === "identity_merge_risk"}
      />
    );
  }
  if (item.targetKind === "ending") {
    return (
      <EndingEditor
        artifact={artifact}
        endingId={item.targetId}
        onLocateEvidence={onLocateEvidence}
        onRevise={onRevise}
        pending={pending}
      />
    );
  }
  if (item.targetKind === "edge") {
    return (
      <EdgeEditor
        artifact={artifact}
        edgeId={item.targetId}
        evidenceOptions={evidenceOptions}
        normalizedText={normalizedText}
        onLocateEvidence={onLocateEvidence}
        onRevise={onRevise}
        pending={pending}
      />
    );
  }
  return (
    <EventEditor
      artifact={artifact}
      eventId={item.targetId}
      normalizedText={normalizedText}
      onLocateEvidence={onLocateEvidence}
      onRevise={onRevise}
      pending={pending}
    />
  );
}

function CharacterEditor({
  artifact,
  characterIds,
  onRevise,
  pending,
  showMerge,
}: {
  artifact: StoryMapArtifact;
  characterIds: string[];
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
  showMerge: boolean;
}) {
  const characters = characterIds
    .map((id) => artifact.storyMap.characters.find((character) => character.id === id))
    .filter((character) => character !== undefined);
  const primary = characters[0] ?? artifact.storyMap.characters[0];

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onRevise({
      type: "update_character",
      characterId: primary.id,
      name: String(data.get("name") ?? ""),
      aliases: String(data.get("aliases") ?? "")
        .split(/[，,\n]/u)
        .map((value) => value.trim())
        .filter(Boolean),
      role: String(data.get("role")) as typeof primary.role,
    });
  }

  return (
    <aside className="workspace-panel review-editor-panel">
      <div className="panel-heading">
        <div>
          <span className="panel-kicker">Character Review</span>
          <h2>核对人物身份</h2>
        </div>
      </div>
      {characters.map((character) => {
        const confirmed = artifact.review.characterConfirmations.includes(
          character.id,
        );
        return (
          <article className="character-review-card" key={character.id}>
            <strong>{character.name}</strong>
            <span>{roleLabel(character.role)}</span>
            <small>
              {character.aliases.length > 0
                ? `别名：${character.aliases.join("、")}`
                : "无别名"}
            </small>
            <button
              className="secondary-button"
              disabled={confirmed || pending}
              onClick={() =>
                onRevise({ type: "confirm_character", characterId: character.id })
              }
              type="button"
            >
              {confirmed ? "人物已核对" : "确认人物身份"}
            </button>
          </article>
        );
      })}

      <details className="editor-details">
        <summary>修改人物名称、别名或角色</summary>
        <form className="guided-review-form" onSubmit={submit}>
          <label>
            人物
            <select
              aria-label="要修改的人物"
              defaultValue={primary.id}
              disabled
              name="characterId"
            >
              <option value={primary.id}>{primary.name}</option>
            </select>
          </label>
          <label>
            名称
            <input defaultValue={primary.name} name="name" required />
          </label>
          <label>
            别名（逗号分隔）
            <input defaultValue={primary.aliases.join("，")} name="aliases" />
          </label>
          <label>
            角色
            <select defaultValue={primary.role} name="role">
              <option value="protagonist">主角</option>
              <option value="antagonist">对抗者</option>
              <option value="supporting">配角</option>
              <option value="deceased">已故人物</option>
            </select>
          </label>
          <button className="primary-button" disabled={pending} type="submit">
            保存人物 revision
          </button>
        </form>
      </details>

      {showMerge || artifact.storyMap.characters.length >= 2 ? (
        <MergeCharacterForm
          artifact={artifact}
          initialTargetId={primary.id}
          onRevise={onRevise}
          pending={pending}
        />
      ) : null}
    </aside>
  );
}

function MergeCharacterForm({
  artifact,
  initialTargetId,
  onRevise,
  pending,
}: {
  artifact: StoryMapArtifact;
  initialTargetId: string;
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
}) {
  const [targetId, setTargetId] = useState(initialTargetId);
  const secondary = artifact.storyMap.characters.find(
    (character) => character.id !== targetId,
  );

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onRevise({
      type: "merge_characters",
      targetCharacterId: String(data.get("target")),
      mergedCharacterIds: [String(data.get("merged"))],
    });
  }

  return (
    <details className="editor-details">
      <summary>合并两个重复人物</summary>
      <form className="guided-review-form" onSubmit={submit}>
        <label>
          保留人物
          <select
            aria-label="合并后保留人物"
            name="target"
            onChange={(event) => setTargetId(event.target.value)}
            value={targetId}
          >
            {artifact.storyMap.characters.map((character) => (
              <option key={character.id} value={character.id}>
                {character.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          并入人物
          <select aria-label="要并入的人物" defaultValue={secondary?.id} name="merged">
            {artifact.storyMap.characters
              .filter((character) => character.id !== targetId)
              .map((character) => (
                <option key={character.id} value={character.id}>
                  {character.name}
                </option>
              ))}
          </select>
        </label>
        <p>所有 Event participant 引用会重映射，受影响的 Evidence 确认会失效。</p>
        <button className="danger-button" disabled={pending} type="submit">
          合并并创建 revision
        </button>
      </form>
    </details>
  );
}

function EventEditor({
  artifact,
  eventId,
  normalizedText,
  onLocateEvidence,
  onRevise,
  pending,
}: {
  artifact: StoryMapArtifact;
  eventId: string;
  normalizedText: string;
  onLocateEvidence: (evidence: SourceReference) => void;
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
}) {
  const [deleteArmed, setDeleteArmed] = useState(false);
  const event = artifact.storyMap.events.find((candidate) => candidate.id === eventId);
  if (!event) return <MissingTarget />;
  const selectedEventId = event.id;

  function submit(changeEvent: FormEvent<HTMLFormElement>): void {
    changeEvent.preventDefault();
    const data = new FormData(changeEvent.currentTarget);
    const confidenceValue = String(data.get("confidence") ?? "").trim();
    onRevise({
      type: "update_event",
      eventId: selectedEventId,
      title: String(data.get("title") ?? ""),
      summary: String(data.get("summary") ?? ""),
      participants: data.getAll("participants").map(String),
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
            <textarea defaultValue={event.summary} name="summary" required rows={4} />
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
              onClick={() => onRevise({ type: "delete_event", eventId: event.id })}
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

function EdgeEditor({
  artifact,
  edgeId,
  evidenceOptions,
  normalizedText,
  onLocateEvidence,
  onRevise,
  pending,
}: {
  artifact: StoryMapArtifact;
  edgeId: string;
  evidenceOptions: EvidencePickerOption[];
  normalizedText: string;
  onLocateEvidence: (evidence: SourceReference) => void;
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
}) {
  const [replacementEvidence, setReplacementEvidence] =
    useState<SourceReference | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const edge = artifact.storyMap.edges.find((candidate) => candidate.id === edgeId);
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
          <textarea defaultValue={edge.explanation} name="explanation" required rows={4} />
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
      {deleteArmed ? (
        <button
          className="danger-button"
          disabled={pending}
          onClick={() => onRevise({ type: "delete_edge", edgeId: edge.id })}
          type="button"
        >
          确认删除 Edge
        </button>
      ) : (
        <button
          className="danger-text-button"
          onClick={() => setDeleteArmed(true)}
          type="button"
        >
          删除错误 Edge
        </button>
      )}
    </aside>
  );
}

function EndingEditor({
  artifact,
  endingId,
  onLocateEvidence,
  onRevise,
  pending,
}: {
  artifact: StoryMapArtifact;
  endingId: string;
  onLocateEvidence: (evidence: SourceReference) => void;
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
}) {
  const ending = artifact.storyMap.endingCandidates.find(
    (candidate) => candidate.id === endingId,
  );
  if (!ending) return <MissingTarget />;
  const confirmed = artifact.review.endingCandidateConfirmations.includes(ending.id);
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
          key={referenceKey(evidence)}
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

function AddEventEditor({
  artifact,
  evidenceOptions,
  onRevise,
  pending,
}: {
  artifact: StoryMapArtifact;
  evidenceOptions: EvidencePickerOption[];
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
}) {
  const [evidence, setEvidence] = useState<SourceReference | null>(null);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!evidence) return;
    const data = new FormData(event.currentTarget);
    const evidenceKind = String(data.get("evidenceKind")) as Event["evidenceKind"];
    const confidenceValue = String(data.get("confidence") ?? "").trim();
    onRevise({
      type: "add_event",
      title: String(data.get("title") ?? ""),
      summary: String(data.get("summary") ?? ""),
      participants: data.getAll("participants").map(String),
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

function ReorderEditor({
  artifact,
  onRevise,
  pending,
}: {
  artifact: StoryMapArtifact;
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
}) {
  const ordered = useMemo(
    () => [...artifact.storyMap.events].sort((left, right) => left.sequence - right.sequence),
    [artifact.storyMap.events],
  );
  function move(index: number, direction: -1 | 1): void {
    const target = index + direction;
    if (target < 0 || target >= ordered.length) return;
    const eventIds = ordered.map((event) => event.id);
    [eventIds[index], eventIds[target]] = [eventIds[target]!, eventIds[index]!];
    onRevise({ type: "reorder_events", eventIds });
  }
  return (
    <aside className="workspace-panel review-editor-panel">
      <div className="panel-heading">
        <div>
          <span className="panel-kicker">Chronology</span>
          <h2>调整 Event 顺序</h2>
        </div>
      </div>
      <ol className="event-reorder-list">
        {ordered.map((event, index) => (
          <li key={event.id}>
            <span>{event.sequence}</span>
            <strong>{event.title}</strong>
            <button
              aria-label={`上移 ${event.title}`}
              disabled={pending || index === 0}
              onClick={() => move(index, -1)}
              type="button"
            >
              ↑
            </button>
            <button
              aria-label={`下移 ${event.title}`}
              disabled={pending || index === ordered.length - 1}
              onClick={() => move(index, 1)}
              type="button"
            >
              ↓
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function AddEdgeEditor({
  artifact,
  evidenceOptions,
  onRevise,
  pending,
}: {
  artifact: StoryMapArtifact;
  evidenceOptions: EvidencePickerOption[];
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
}) {
  const [evidence, setEvidence] = useState<SourceReference | null>(null);
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!evidence) return;
    const data = new FormData(event.currentTarget);
    onRevise({
      type: "add_edge",
      from: String(data.get("from")),
      to: String(data.get("to")),
      edgeType: String(data.get("edgeType")) as "causes" | "enables" | "foreshadows",
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
                <option key={event.id} value={event.id}>{event.title}</option>
              ))}
            </select>
          </label>
          <label>
            终点 Event
            <select aria-label="Edge 终点 Event" name="to">
              {artifact.storyMap.events.map((event) => (
                <option key={event.id} value={event.id}>{event.title}</option>
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

function EvidenceList({
  artifact,
  evidence,
  normalizedText,
  onLocateEvidence,
  onRevise,
  pending,
  targetId,
  targetKind,
}: {
  artifact: StoryMapArtifact;
  evidence: SourceReference[];
  normalizedText: string;
  onLocateEvidence: (evidence: SourceReference) => void;
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
  targetId: string;
  targetKind: "event" | "edge";
}) {
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
                    referenceKey(item.evidence) === referenceKey(reference),
                )
              : artifact.review.edgeEvidenceConfirmations.some(
                  (item) =>
                    item.edgeId === targetId &&
                    referenceKey(item.evidence) === referenceKey(reference),
                );
          return (
            <article className="review-evidence" key={referenceKey(reference)}>
              <blockquote>{normalizedText.slice(reference.start, reference.end)}</blockquote>
              <small>{reference.sectionId} · {reference.start}—{reference.end} · Hash 已验证</small>
              <div>
                <button className="text-button" onClick={() => onLocateEvidence(reference)} type="button">
                  在原文中定位
                </button>
                <button
                  className="text-button"
                  disabled={confirmed || pending}
                  onClick={() =>
                    onRevise(
                      targetKind === "event"
                        ? { type: "confirm_evidence", eventId: targetId, evidence: reference }
                        : { type: "confirm_edge_evidence", edgeId: targetId, evidence: reference },
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

function MissingTarget() {
  return (
    <aside className="workspace-panel review-editor-panel">
      <p>该核对项目已在当前 revision 中解决，请选择下一项。</p>
    </aside>
  );
}

function roleLabel(role: StoryMapArtifact["storyMap"]["characters"][number]["role"]): string {
  return {
    protagonist: "主角",
    antagonist: "对抗者",
    supporting: "配角",
    deceased: "已故人物",
  }[role];
}

function referenceKey(reference: SourceReference): string {
  return [
    reference.sourceId,
    reference.sectionId,
    reference.start,
    reference.end,
    reference.excerptHash,
  ].join(":");
}
