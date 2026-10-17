"use client";

import { useState, useTransition, type FormEvent } from "react";

import {
  acceptImpactPlanAction,
  generateRipplePreviewAction,
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
  suggestions: RippleSuggestionsArtifact | null;
  suggestionsLoading: boolean;
  suggestionsError: string | null;
  needsReviewEndingIds?: string[];
  onClose: () => void;
  onAccepted: (
    worldline: Worldline,
    acceptedArtifact: ImpactPlanArtifact,
  ) => void;
  onEnterWorldline: (worldlineId: string) => void;
  onRetrySuggestions: () => void;
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

const plainAnchorStatusLabels = {
  preserved: "原结局保住了",
  rerouted: "原结局保住了 · 改道",
  threatened: "原结局受到威胁",
  incompatible: "原结局无法保留",
} as const;

const impactScopeLabels = {
  direct: "直接影响",
  downstream: "中期影响",
  ending: "结局影响",
} as const;

type ImpactScope = keyof typeof impactScopeLabels;

/** 旧 Artifact 没有 `uncertainEdgeIds`，数量按 0 处理，界面不显示提示。 */
export function countUncertainRelations(plan: ImpactPlan): number {
  return plan.uncertainEdgeIds?.length ?? 0;
}

export function isUncertainImpact(
  plan: ImpactPlan,
  impactId: string,
): boolean {
  return plan.uncertainImpactIds?.includes(impactId) ?? false;
}

export function summarizeImpactScope(
  plan: ImpactPlan,
  scope: ImpactScope,
): string {
  const impacts = plan.impacts.filter((impact) => impact.scope === scope);
  if (impacts.length === 0) return "无";
  const firstImpact = impacts[0]!;
  const first = isUncertainImpact(plan, firstImpact.id)
    ? `可能：${firstImpact.summary}`
    : firstImpact.summary;
  return impacts.length > 1 ? `${first}（另有 ${impacts.length - 1} 项）` : first;
}

/**
 * 摘要只回答“原结局怎么样了”；完整 Anchor 评估、路径与解释仍在详情中。
 * 多个 Anchor 取最严重的状态，并保留数量提示。
 */
export function summarizePlainAnchorStatus(plan: ImpactPlan): string | null {
  if (plan.mode !== "strict" || plan.anchorEvaluations.length === 0) return null;
  const severity = ["preserved", "rerouted", "threatened", "incompatible"] as const;
  const worst = plan.anchorEvaluations.reduce<(typeof severity)[number]>(
    (current, evaluation) =>
      severity.indexOf(evaluation.status) > severity.indexOf(current)
        ? evaluation.status
        : current,
    "preserved",
  );
  const label = plainAnchorStatusLabels[worst];
  return plan.anchorEvaluations.length > 1
    ? `${plan.anchorEvaluations.length} 个结局 · ${label}`
    : label;
}

export function mapAnchorEvaluationRows(
  plan: ImpactPlan,
): Array<ImpactPlan["anchorEvaluations"][number] & { requirement: string }> {
  const rows: Array<
    ImpactPlan["anchorEvaluations"][number] & { requirement: string }
  > = [];
  for (const evaluation of plan.anchorEvaluations) {
    const anchor = plan.anchors.find(
      (candidate) => candidate.id === evaluation.anchorId,
    );
    if (!anchor) continue; // 容错：缺失的 Anchor 不渲染，而不是抛错炸掉整个面板
    rows.push({ ...evaluation, requirement: anchor.requirement });
  }
  return rows;
}

export function RippleSimulatorPanel({
  projectId,
  artifact,
  selectedEvent,
  suggestions,
  suggestionsLoading,
  suggestionsError,
  needsReviewEndingIds = [],
  onClose,
  onAccepted,
  onEnterWorldline,
  onRetrySuggestions,
}: RippleSimulatorPanelProps) {
  const [divergenceType, setDivergenceType] = useState<
    "prevent" | "choice" | "outcome"
  >("prevent");
  const [instruction, setInstruction] = useState("");
  const [rippleEventId, setRippleEventId] = useState(selectedEvent.id);
  const [mode, setMode] = useState<"strict" | "open">("strict");
  const [endingCandidateIds, setEndingCandidateIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<ImpactPlanArtifact | null>(null);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const storyMap = artifact.storyMap;
  const rippleEvent =
    storyMap.events.find((event) => event.id === rippleEventId) ?? selectedEvent;
  const plan = preview?.impactPlan ?? null;
  const comparison = plan ? deriveImpactPlanComparison(storyMap, plan) : null;
  const uncertainRelationCount = plan ? countUncertainRelations(plan) : 0;
  const uncertainEdgeIds = new Set(plan?.uncertainEdgeIds ?? []);
  const uncertainRelations = storyMap.edges.filter((edge) =>
    uncertainEdgeIds.has(edge.id),
  );
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
      onAccepted(result.worldline, result.acceptedArtifact);
      // 接受后直接进入新 Worldline；方向由工作区自动请求一次。
      onEnterWorldline(result.worldline.id);
    });
  }

  function returnToDivergence(): void {
    setPreview(null);
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
          <section className="ripple-suggestions" aria-label="3 个值得改变的瞬间">
            <div className="ripple-suggestions-heading">
              <div>
                <span className="panel-kicker">读者入口</span>
                <h3>3 个值得改变的瞬间</h3>
                <p>选一个瞬间，直接看它会怎样改变故事。</p>
              </div>
            </div>

            {suggestionsLoading ? (
              <p className="ripple-suggestions-status" role="status">
                正在寻找值得改变的瞬间…
              </p>
            ) : null}

            {suggestionsError ? (
              <div className="ripple-suggestions-error" role="alert">
                <p>{suggestionsError}</p>
                <button
                  className="secondary-button compact-button"
                  disabled={suggestionsLoading}
                  onClick={onRetrySuggestions}
                  type="button"
                >
                  重试
                </button>
              </div>
            ) : null}

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
                      <p>
                        <b>为什么值得改变：</b>
                        {suggestion.whyInteresting}
                      </p>
                      <strong>
                        <b>建议改动：</b>
                        {suggestion.instruction}
                      </strong>
                      <button
                        className="secondary-button compact-button"
                        onClick={() => applySuggestion(suggestion)}
                        type="button"
                      >
                        从这里改变
                      </button>
                    </article>
                  );
                })}
              </div>
            ) : null}

            {!suggestions && !suggestionsLoading && !suggestionsError ? (
              <p>推荐只是候选；生成后不会自动推演或创建 Worldline。</p>
            ) : null}

            <p className="ripple-suggestions-secondary">
              或者，
              <button className="text-button" onClick={onClose} type="button">
                从时间线上自己选一个事件
              </button>
            </p>
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
            <legend>故事会怎样收尾？</legend>
            <label>
              <input
                checked={mode === "strict"}
                name="ripple-mode"
                onChange={() => changeMode("strict")}
                type="radio"
              />
              <span>
                <strong>保留原结局</strong>
                <small>选择要保住的结局；新剧情会绕路回到这些结局</small>
              </span>
            </label>
            <label>
              <input
                checked={mode === "open"}
                name="ripple-mode"
                onChange={() => changeMode("open")}
                type="radio"
              />
              <span>
                <strong>让故事自由发展</strong>
                <small>不锁定结局，涟漪可以改写结尾</small>
              </span>
            </label>
          </fieldset>

          {mode === "strict" ? (
            <fieldset className="anchor-choice-fieldset">
              <legend>选择要保住的结局</legend>
              {storyMap.endingCandidates.map((ending) => (
                <label key={ending.id}>
                  <input
                    checked={endingCandidateIds.includes(ending.id)}
                    onChange={() => toggleEndingCandidate(ending.id)}
                    type="checkbox"
                  />
                  <span>
                    {ending.requirement}
                    {needsReviewEndingIds.includes(ending.id) ? (
                      <em className="review-badge">待核对</em>
                    ) : null}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : (
            <p className="open-mode-note">
              让故事自由发展 · 不锁定结局 Anchor
            </p>
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
              {plan.mode === "strict" ? "保留原结局" : "让故事自由发展"}
            </span>
          </div>

          <section
            className="impact-summary"
            data-testid="impact-summary"
            aria-label="涟漪影响摘要"
          >
            <div className="impact-summary-divergence">
              <span>改变了什么</span>
              <strong>{plan.divergence.instruction}</strong>
            </div>

            {(["direct", "downstream", "ending"] as const).map((scope) => (
              <div className="impact-summary-row" key={scope}>
                <span>{impactScopeLabels[scope]}</span>
                <strong>{summarizeImpactScope(plan, scope)}</strong>
              </div>
            ))}

            {uncertainRelationCount > 0 ? (
              <p
                className="impact-uncertainty-note"
                data-testid="impact-uncertainty-note"
              >
                含 {uncertainRelationCount} 条未精修/不确定关系
              </p>
            ) : null}

            <div className="impact-summary-row impact-summary-anchor">
              <span>{plan.mode === "strict" ? "原结局" : "故事走向"}</span>
              <strong>
                {plan.mode === "strict"
                  ? summarizePlainAnchorStatus(plan) ?? "未提供 Anchor 评估"
                  : "不锁定结局 · 让故事自由发展"}
              </strong>
            </div>

            {preview?.lineage ? (
              <p className="candidate-lineage">基于上一候选重新推演</p>
            ) : null}

            {incompatible ? (
              <div className="blocked-message">
                该分歧与要保留的结局不兼容。保留原结局模式不会强行圆回原结局。
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
                disabled={incompatible || pending}
                onClick={acceptPreview}
                type="button"
              >
                {pending ? "正在进入…" : "进入新世界线"}
              </button>
            </div>
          </section>

          <details className="impact-details" data-testid="impact-details">
            <summary>查看完整影响</summary>
            <div className="impact-details-body">
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
                  <h4>{impactScopeLabels[scope]}</h4>
                  {plan.impacts
                    .filter((impact) => impact.scope === scope)
                    .map((impact) => {
                      const uncertain = isUncertainImpact(plan, impact.id);
                      return (
                        <article
                          className={`impact-item${uncertain ? " impact-uncertain" : ""}`}
                          key={impact.id}
                        >
                          <span className={`change change-${impact.changeType}`}>
                            {impact.changeType === "removed"
                              ? "−"
                              : impact.changeType === "added"
                                ? "+"
                                : "~"}
                          </span>
                          <div>
                            <strong>
                              {impact.summary}
                              {uncertain ? (
                                <em className="review-badge">可能</em>
                              ) : null}
                            </strong>
                            <p><b>为什么：</b>{impact.explanation}</p>
                            <small>
                              因果路径：{formatReasonPath(impact.reasonPath)}
                              {" · "}路径起点：{eventTitles[impact.fromEventId] ?? impact.fromEventId}
                              {" · "}置信度：{Math.round(impact.confidence * 100)}%
                            </small>
                            {uncertain ? (
                              <small className="impact-uncertain-path-note">
                                该路径只由未精修/不确定关系支撑，只能作为可能。
                              </small>
                            ) : null}
                          </div>
                        </article>
                      );
                    })}
                </section>
              ))}

              {uncertainRelations.length > 0 ? (
                <section
                  className="impact-group impact-uncertain-relations"
                  data-testid="impact-uncertain-relations"
                >
                  <h4>不确定关系（{uncertainRelations.length}）</h4>
                  <ul>
                    {uncertainRelations.map((edge) => (
                      <li key={edge.id}>
                        <strong>可能：</strong>
                        {edge.explanation}
                        <small>（未精修/不确定关系，不作为已确认因果）</small>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

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
            </div>
          </details>
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
