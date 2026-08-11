"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import {
  acceptImpactPlanAction,
  generateRipplePreviewAction,
} from "@/app/projects/actions";
import type {
  Event,
  ImpactPlan,
  ImpactPlanArtifact,
  StoryMapArtifact,
  Worldline,
} from "@/domain/schemas";

type RippleSimulatorPanelProps = {
  projectId: string;
  artifact: StoryMapArtifact;
  selectedEvent: Event;
  onClose: () => void;
  onAccepted: (
    worldline: Worldline,
    acceptedArtifact: ImpactPlanArtifact,
  ) => void;
  onEnterWorldline: (worldlineId: string) => void;
};

const divergenceLabels = {
  prevent: "事件未发生",
  choice: "人物做出不同选择",
  outcome: "事件发生但结果不同",
} as const;

const anchorStatusLabels = {
  preserved: "Preserved · 保留",
  rerouted: "Rerouted · 改道",
  threatened: "Threatened · 受威胁",
  incompatible: "Incompatible · 不兼容",
} as const;

export function mapAnchorEvaluationRows(plan: ImpactPlan) {
  return plan.anchorEvaluations.map((evaluation) => {
    const anchor = plan.anchors.find(
      (candidate) => candidate.id === evaluation.anchorId,
    );
    if (!anchor) {
      throw new Error(`Anchor 评估缺少对应结局条件：${evaluation.anchorId}`);
    }
    return { ...evaluation, requirement: anchor.requirement };
  });
}

export function RippleSimulatorPanel({
  projectId,
  artifact,
  selectedEvent,
  onClose,
  onAccepted,
  onEnterWorldline,
}: RippleSimulatorPanelProps) {
  const router = useRouter();
  const [divergenceType, setDivergenceType] = useState<
    "prevent" | "choice" | "outcome"
  >("prevent");
  const [instruction, setInstruction] = useState("");
  const [mode, setMode] = useState<"strict" | "open">("strict");
  const [endingCandidateIds, setEndingCandidateIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<ImpactPlanArtifact | null>(null);
  const [acceptedWorldline, setAcceptedWorldline] = useState<Worldline | null>(
    null,
  );
  const [acceptedArtifact, setAcceptedArtifact] =
    useState<ImpactPlanArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const storyMap = artifact.storyMap;
  const plan = preview?.impactPlan ?? null;
  const characterNames = Object.fromEntries(
    storyMap.characters.map((character) => [character.id, character.name]),
  );
  const eventTitles = Object.fromEntries(
    storyMap.events.map((event) => [event.id, event.title]),
  );
  const incompatible =
    plan?.anchorEvaluations.some(
      (evaluation) => evaluation.status === "incompatible",
    ) ?? false;
  function changeMode(nextMode: "strict" | "open"): void {
    setMode(nextMode);
    if (nextMode === "open") setEndingCandidateIds([]);
    setError(null);
  }

  function toggleEndingCandidate(id: string): void {
    setEndingCandidateIds((current) =>
      current.includes(id)
        ? current.filter((candidateId) => candidateId !== id)
        : [...current, id],
    );
  }

  function generatePreview(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    setAcceptedWorldline(null);
    startTransition(async () => {
      const result = await generateRipplePreviewAction({
        projectId,
        storyMapArtifactId: artifact.id,
        eventId: selectedEvent.id,
        type: divergenceType,
        instruction,
        mode,
        endingCandidateIds,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPreview(result.artifact);
    });
  }

  function acceptPreview(): void {
    if (!preview) return;
    setError(null);
    startTransition(async () => {
      const result = await acceptImpactPlanAction({
        projectId,
        candidateArtifactId: preview.id,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAcceptedWorldline(result.worldline);
      setAcceptedArtifact(result.acceptedArtifact);
      onAccepted(result.worldline, result.acceptedArtifact);
      router.refresh();
    });
  }

  function returnToDivergence(): void {
    setPreview(null);
    setAcceptedWorldline(null);
    setAcceptedArtifact(null);
    setError(null);
  }

  return (
    <aside className="workspace-panel detail-panel ripple-simulator-panel">
      <div className="panel-heading detail-heading">
        <div>
          <span className="panel-kicker">Ripple Simulator · 事件 {selectedEvent.sequence}</span>
          <h2>{selectedEvent.title}</h2>
        </div>
        <button className="text-button" onClick={onClose} type="button">
          返回 Evidence
        </button>
      </div>

      <p className="event-summary">{selectedEvent.summary}</p>

      {!plan ? (
        <form className="ripple-form" onSubmit={generatePreview}>
          <label htmlFor={`divergence-type-${selectedEvent.id}`}>分歧类型</label>
          <select
            id={`divergence-type-${selectedEvent.id}`}
            onChange={(event) =>
              setDivergenceType(
                event.target.value as "prevent" | "choice" | "outcome",
              )
            }
            value={divergenceType}
          >
            {Object.entries(divergenceLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>

          <label htmlFor={`divergence-instruction-${selectedEvent.id}`}>
            改变内容
          </label>
          <textarea
            id={`divergence-instruction-${selectedEvent.id}`}
            maxLength={500}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="用一句话说明这个事件怎样改变"
            required
            rows={4}
            value={instruction}
          />

          <fieldset className="ripple-mode-fieldset">
            <legend>推演模式</legend>
            <label>
              <input
                checked={mode === "strict"}
                name="ripple-mode"
                onChange={() => changeMode("strict")}
                type="radio"
              />
              严格模式
            </label>
            <label>
              <input
                checked={mode === "open"}
                name="ripple-mode"
                onChange={() => changeMode("open")}
                type="radio"
              />
              完全开放模式
            </label>
          </fieldset>

          {mode === "strict" ? (
            <fieldset className="anchor-choice-fieldset">
              <legend>选择一个或多个结局 Anchor</legend>
              {storyMap.endingCandidates.map((ending) => (
                <label key={ending.id}>
                  <input
                    checked={endingCandidateIds.includes(ending.id)}
                    onChange={() => toggleEndingCandidate(ending.id)}
                    type="checkbox"
                  />
                  <span>{ending.requirement}</span>
                </label>
              ))}
            </fieldset>
          ) : (
            <p className="open-mode-note">开放模式 · 无结局 Anchor</p>
          )}

          <button
            className="primary-button full-width-button"
            disabled={
              pending ||
              instruction.trim().length === 0 ||
              (mode === "strict" && endingCandidateIds.length === 0)
            }
            type="submit"
          >
            {pending ? "正在推演…" : "生成 Ripple Preview"}
          </button>
        </form>
      ) : (
        <div className="ripple-preview" data-testid="ripple-preview">
          <div className="preview-heading">
            <div>
              <span className="panel-kicker">Ripple Preview</span>
              <h3>涟漪影响预览</h3>
            </div>
            <span className={`mode-badge mode-${plan.mode}`}>
              {plan.mode === "strict" ? "严格模式" : "开放模式 · 无结局 Anchor"}
            </span>
          </div>

          <section className="impact-group changed-what">
            <h4>改变了什么</h4>
            <strong>{plan.divergence.instruction}</strong>
          </section>

          {(["direct", "downstream", "ending"] as const).map((scope) => (
            <section className="impact-group" key={scope}>
              <h4>
                {scope === "direct"
                  ? "直接影响"
                  : scope === "downstream"
                    ? "中期影响"
                    : "结局影响"}
              </h4>
              {plan.impacts
                .filter((impact) => impact.scope === scope)
                .map((impact) => (
                  <article className="impact-item" key={impact.id}>
                    <span className={`change change-${impact.changeType}`}>
                      {impact.changeType === "removed"
                        ? "−"
                        : impact.changeType === "added"
                          ? "+"
                          : "~"}
                    </span>
                    <div>
                      <strong>{impact.summary}</strong>
                      <p><b>为什么：</b>{impact.explanation}</p>
                      <small>
                        起点：{eventTitles[impact.fromEventId] ?? impact.fromEventId}
                        {" · "}路径：{impact.reasonPath.join(" → ")}
                        {" · "}置信度：{Math.round(impact.confidence * 100)}%
                      </small>
                    </div>
                  </article>
                ))}
            </section>
          ))}

          {mapAnchorEvaluationRows(plan).map((evaluation) => (
            <section
              className={`anchor-check anchor-${evaluation.status}`}
              key={evaluation.anchorId}
            >
              <div>
                <span>Anchor · {evaluation.requirement}</span>
                <strong>{anchorStatusLabels[evaluation.status]}</strong>
              </div>
              <p>{evaluation.explanation}</p>
              <small>{evaluation.reasonPath.join(" → ")}</small>
            </section>
          ))}

          <section className="impact-group compact-impact-list">
            <h4>人物状态变化</h4>
            <ul>
              {plan.characterChanges.map((change) => (
                <li key={`${change.characterId}:${change.summary}`}>
                  <strong>{characterNames[change.characterId] ?? change.characterId}</strong>
                  {"："}{change.summary}
                </li>
              ))}
            </ul>
          </section>

          <section className="impact-group compact-impact-list">
            <h4>线索变化</h4>
            <ul>
              {plan.threadChanges.opened.map((thread) => (
                <li key={`opened:${thread}`}><strong>开启：</strong>{thread}</li>
              ))}
              {plan.threadChanges.closed.map((thread) => (
                <li key={`closed:${thread}`}><strong>关闭：</strong>{thread}</li>
              ))}
            </ul>
          </section>

          {plan.uncertainties.length > 0 ? (
            <details className="uncertainties">
              <summary>{plan.uncertainties.length} 个不确定项</summary>
              <ul>
                {plan.uncertainties.map((uncertainty) => (
                  <li key={uncertainty}>{uncertainty}</li>
                ))}
              </ul>
            </details>
          ) : null}

          {incompatible ? (
            <div className="blocked-message">
              该分歧与硬 Anchor 不兼容。严格模式不会强行圆回原结局。
            </div>
          ) : (
            <p className="preview-write-boundary">接受前不会创建 Worldline</p>
          )}

          <div className="ripple-preview-actions">
            <button
              className="secondary-button"
              disabled={pending}
              onClick={returnToDivergence}
              type="button"
            >
              返回修改 Divergence
            </button>
            <button
              className="primary-button"
              disabled={incompatible || pending || acceptedWorldline !== null}
              onClick={acceptPreview}
              type="button"
            >
              {pending
                ? "正在创建…"
                : acceptedWorldline
                  ? "ImpactPlan 已接受"
                  : "接受 ImpactPlan 并创建 Worldline"}
            </button>
          </div>

          {acceptedWorldline ? (
            <div className="result-success" role="status">
              <strong>新 Worldline 已创建</strong>
              <span>{acceptedWorldline.id}</span>
              <small>重复接受会返回同一分支，Canon 保持只读。</small>
              <button
                className="secondary-button"
                disabled={!acceptedArtifact}
                onClick={() => {
                  if (acceptedArtifact) onEnterWorldline(acceptedWorldline.id);
                }}
                type="button"
              >
                进入新 Worldline
              </button>
            </div>
          ) : null}
        </div>
      )}

      {error ? (
        <p className="workspace-action-error" role="alert">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
