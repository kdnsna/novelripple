"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import {
  acceptImpactPlanAction,
  generateRipplePreviewAction,
  generateRippleSuggestionsAction,
  regenerateRipplePreviewAction,
} from "@/app/projects/actions";
import { deriveImpactPlanComparison } from "@/domain/ripple/derive-impact-plan-comparison";
import type {
  Event,
  ImpactPlan,
  ImpactPlanArtifact,
  RippleSuggestionsArtifact,
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
  const [rippleEventId, setRippleEventId] = useState(selectedEvent.id);
  const [mode, setMode] = useState<"strict" | "open">("strict");
  const [endingCandidateIds, setEndingCandidateIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<ImpactPlanArtifact | null>(null);
  const [suggestions, setSuggestions] =
    useState<RippleSuggestionsArtifact | null>(null);
  const [feedback, setFeedback] = useState("");
  const [acceptedWorldline, setAcceptedWorldline] = useState<Worldline | null>(
    null,
  );
  const [acceptedArtifact, setAcceptedArtifact] =
    useState<ImpactPlanArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const storyMap = artifact.storyMap;
  const rippleEvent =
    storyMap.events.find((event) => event.id === rippleEventId) ?? selectedEvent;
  const plan = preview?.impactPlan ?? null;
  const comparison = plan ? deriveImpactPlanComparison(storyMap, plan) : null;
  const characterNames = Object.fromEntries(
    storyMap.characters.map((character) => [character.id, character.name]),
  );
  const eventTitles = Object.fromEntries(
    storyMap.events.map((event) => [event.id, event.title]),
  );
  const formatReasonPath = (reasonPath: string[]) =>
    reasonPath.map((eventId) => eventTitles[eventId] ?? eventId).join(" → ");
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
        eventId: rippleEvent.id,
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

  function generateSuggestions(): void {
    setError(null);
    startTransition(async () => {
      const result = await generateRippleSuggestionsAction({
        projectId,
        storyMapArtifactId: artifact.id,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSuggestions(result.artifact);
    });
  }

  function applySuggestion(
    suggestion: RippleSuggestionsArtifact["suggestions"][number],
  ): void {
    setRippleEventId(suggestion.eventId);
    setDivergenceType(suggestion.divergenceType);
    setInstruction(suggestion.instruction);
    setPreview(null);
    setFeedback("");
    setError(null);
  }

  function regeneratePreview(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!preview) return;
    setError(null);
    startTransition(async () => {
      const result = await regenerateRipplePreviewAction({
        projectId,
        priorCandidateArtifactId: preview.id,
        feedback,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPreview(result.artifact);
      setFeedback("");
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
          <span className="panel-kicker">Ripple Simulator · 事件 {rippleEvent.sequence}</span>
          <h2>{rippleEvent.title}</h2>
        </div>
        <button className="text-button" onClick={onClose} type="button">
          返回 Evidence
        </button>
      </div>

      <p className="event-summary">{rippleEvent.summary}</p>

      {!plan ? (
        <>
          <section className="ripple-suggestions" aria-label="推荐分叉点">
            <div className="ripple-suggestions-heading">
              <div>
                <span className="panel-kicker">不知道从哪里改？</span>
                <h3>先看三个值得改变的节点</h3>
              </div>
              <button
                className="secondary-button"
                disabled={pending}
                onClick={generateSuggestions}
                type="button"
              >
                {pending ? "正在生成…" : "生成 3 个推荐分叉点"}
              </button>
            </div>
            {suggestions ? (
              <div className="ripple-suggestion-list">
                {suggestions.suggestions.map((suggestion) => {
                  const event = storyMap.events.find(
                    (candidate) => candidate.id === suggestion.eventId,
                  );
                  return (
                    <article
                      className="ripple-suggestion-card"
                      key={`${suggestions.id}:${suggestion.eventId}`}
                    >
                      <div>
                        <span>{divergenceLabels[suggestion.divergenceType]}</span>
                        <small>Anchor 风险：{suggestion.anchorRisk}</small>
                      </div>
                      <h4>{event?.title ?? suggestion.eventId}</h4>
                      <strong>{suggestion.instruction}</strong>
                      <p>{suggestion.whyInteresting}</p>
                      <button
                        className="secondary-button compact-button"
                        onClick={() => applySuggestion(suggestion)}
                        type="button"
                      >
                        使用这个建议
                      </button>
                    </article>
                  );
                })}
              </div>
            ) : (
              <p>推荐只是候选；生成后不会自动推演或创建 Worldline。</p>
            )}
          </section>

        <form className="ripple-form" onSubmit={generatePreview}>
          <label htmlFor={`divergence-type-${rippleEvent.id}`}>分歧类型</label>
          <select
            id={`divergence-type-${rippleEvent.id}`}
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

          <label htmlFor={`divergence-instruction-${rippleEvent.id}`}>
            改变内容
          </label>
          <textarea
            id={`divergence-instruction-${rippleEvent.id}`}
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
        </>
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

          {preview?.lineage ? (
            <p className="candidate-lineage">基于上一候选重新推演</p>
          ) : null}

          {comparison ? (
            <section className="impact-comparison" aria-label="原路径与新路径">
              <div>
                <h4>原路径</h4>
                <ol>
                  {comparison.originalPath.map((event) => (
                    <li key={event.eventId}>{event.title}</li>
                  ))}
                </ol>
              </div>
              <div>
                <h4>新路径</h4>
                <ol>
                  {comparison.newPath.map((impact) => (
                    <li key={impact.impactId}>{impact.summary}</li>
                  ))}
                </ol>
              </div>
              {(
                [
                  ["removed", "删除"],
                  ["modified", "修改"],
                  ["added", "新增"],
                  ["preserved", "保持不变的关键事实"],
                ] as const
              ).map(([changeType, label]) => (
                <div key={changeType}>
                  <h4>{label}</h4>
                  {comparison.changes[changeType].length > 0 ? (
                    <ul>
                      {comparison.changes[changeType].map((change) => (
                        <li key={change.impactId}>{change.summary}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>无</p>
                  )}
                </div>
              ))}
            </section>
          ) : null}

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
                        因果路径：{formatReasonPath(impact.reasonPath)}
                        {" · "}路径起点：{eventTitles[impact.fromEventId] ?? impact.fromEventId}
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
              <small>
                Anchor 因果路径：{formatReasonPath(evaluation.reasonPath)}
              </small>
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

          <form className="impact-feedback" onSubmit={regeneratePreview}>
            <label htmlFor={`impact-feedback-${preview!.id}`}>
              指出一个关键判断问题
            </label>
            <textarea
              id={`impact-feedback-${preview!.id}`}
              maxLength={2_000}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="只写一条明确修正，不会进入聊天"
              required
              rows={3}
              value={feedback}
            />
            <button
              className="secondary-button"
              disabled={pending || feedback.trim().length === 0}
              type="submit"
            >
              {pending ? "正在重新推演…" : "根据反馈重新推演"}
            </button>
          </form>

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
