"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { ImpactPlan, StoryEvent, Worldline } from "@/domain/schemas";
import {
  createDemoWorldlineAction,
  type CreateDemoWorldlineResult,
} from "@/app/demo/actions";

type RipplePanelProps = {
  selectedEvent: StoryEvent;
  characterNames: Record<string, string>;
  impactPlans: ImpactPlan[];
  selectedPlanId: string;
  onSelectPlan: (planId: string) => void;
  onSelectBenchmarkEvent: () => void;
  initialWorldlines: Worldline[];
};

const divergenceLabels = {
  prevent: "事件不发生",
  alternate_choice: "做出不同选择",
  alternate_outcome: "产生不同结果",
} as const;

const statusLabels = {
  preserved: "Preserved · 保留",
  rerouted: "Rerouted · 改道",
  threatened: "Threatened · 受威胁",
  incompatible: "Incompatible · 不兼容",
} as const;

export function RipplePanel({
  selectedEvent,
  characterNames,
  impactPlans,
  selectedPlanId,
  onSelectPlan,
  onSelectBenchmarkEvent,
  initialWorldlines,
}: RipplePanelProps) {
  const router = useRouter();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<CreateDemoWorldlineResult | null>(null);
  const plan = impactPlans.find((item) => item.id === selectedPlanId) ?? impactPlans[0];
  const isBenchmarkEvent = selectedEvent.id === "event_07";
  const incompatible = plan.anchorEvaluations.some(
    (evaluation) => evaluation.status === "incompatible",
  );
  const mode = plan.anchors.length > 0 ? "strict" : "open";

  function submitWorldline() {
    setResult(null);
    startTransition(async () => {
      const response = await createDemoWorldlineAction({
        impactPlanId: plan.id,
        mode,
      });
      setResult(response);
      if (response.ok) router.refresh();
    });
  }

  return (
    <aside className="workspace-panel detail-panel">
      <div className="panel-heading detail-heading">
        <div>
          <span className="panel-kicker">节点 {selectedEvent.sequence}</span>
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

      {!isBenchmarkEvent ? (
        <div className="empty-ripple-state">
          <span>Foundation 限定</span>
          <p>当前只有节点 07 配置了人工确认的涟漪金标。</p>
          <button
            className="secondary-button"
            onClick={onSelectBenchmarkEvent}
            type="button"
          >
            在地图选择“许澄交出红账”
          </button>
        </div>
      ) : (
        <>
          <div className="divergence-section">
            <div className="subsection-heading">
              <span>改变方式</span>
              <small>{previewOpen ? "可切换方案比较" : "先选择，再预览影响"}</small>
            </div>
            <div className="divergence-options">
              {impactPlans.map((candidate, index) => (
                <button
                  className={candidate.id === plan.id ? "option-active" : ""}
                  key={candidate.id}
                  onClick={() => {
                    onSelectPlan(candidate.id);
                    setResult(null);
                  }}
                  type="button"
                >
                  <span>0{index + 1}</span>
                  <div>
                    <small>{divergenceLabels[candidate.divergence.type]}</small>
                    <strong>{candidate.divergence.instruction}</strong>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {!previewOpen ? (
            <button
              className="primary-button full-width-button"
              onClick={() => setPreviewOpen(true)}
              type="button"
            >
              改变这个节点
              <span aria-hidden="true">→</span>
            </button>
          ) : (
            <div className="ripple-preview" data-testid="ripple-preview">
              <div className="preview-heading">
                <div>
                  <span className="panel-kicker">Ripple Preview</span>
                  <h3>涟漪影响预览</h3>
                </div>
                <span className={`mode-badge mode-${mode}`}>
                  {mode === "strict" ? "严格模式" : "开放模式"}
                </span>
              </div>

              {(["immediate", "midterm", "ending"] as const).map((horizon) => {
                const items = plan.impacts.filter((impact) => impact.horizon === horizon);
                if (items.length === 0) return null;
                return (
                  <section className="impact-group" key={horizon}>
                    <h4>
                      {horizon === "immediate"
                        ? "立即影响"
                        : horizon === "midterm"
                          ? "中期影响"
                          : "结局影响"}
                    </h4>
                    {items.map((impact) => (
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
                          <p>{impact.explanation}</p>
                          <small>{impact.reasonPath.join(" → ")}</small>
                        </div>
                      </article>
                    ))}
                  </section>
                );
              })}

              {plan.anchorEvaluations.map((evaluation) => (
                <section
                  className={`anchor-check anchor-${evaluation.status}`}
                  key={evaluation.anchorId}
                >
                  <div>
                    <span>严格模式检查</span>
                    <strong>{statusLabels[evaluation.status]}</strong>
                  </div>
                  <p>{evaluation.explanation}</p>
                </section>
              ))}

              {plan.uncertainties.length > 0 ? (
                <details className="uncertainties">
                  <summary>{plan.uncertainties.length} 个不确定项</summary>
                  <ul>
                    {plan.uncertainties.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </details>
              ) : null}

              {incompatible ? (
                <div className="blocked-message">
                  该分歧与硬 Anchor 不能同时成立。请修改分歧，或选择开放模式方案。
                </div>
              ) : null}

              <button
                className="primary-button full-width-button"
                disabled={incompatible || pending}
                onClick={submitWorldline}
                type="button"
              >
                {pending ? "正在创建不可变分支…" : "确认影响并创建世界线"}
                {!pending ? <span aria-hidden="true">↗</span> : null}
              </button>

              {result ? (
                <div
                  className={result.ok ? "result-success" : "result-error"}
                  role="status"
                >
                  {result.ok ? (
                    <>
                      <strong>新世界线已保存</strong>
                      <span>{result.worldline.id}</span>
                      <small>重复确认会返回同一分支，不会覆盖原著。</small>
                    </>
                  ) : (
                    result.error
                  )}
                </div>
              ) : null}
            </div>
          )}
        </>
      )}

      <div className="worldline-list">
        <div className="subsection-heading">
          <span>已保存世界线</span>
          <small>{initialWorldlines.length}</small>
        </div>
        {initialWorldlines.map((worldline) => (
          <div className="worldline-row" key={worldline.id}>
            <span className={worldline.status === "canonical" ? "canon-dot" : "branch-dot"} />
            <div>
              <strong>
                {worldline.status === "canonical" ? "原著基线" : worldline.divergence?.instruction}
              </strong>
              <small>
                {worldline.status === "canonical"
                  ? "Canonical · 只读"
                  : `${worldline.mode === "strict" ? "严格" : "开放"} · ${worldline.id}`}
              </small>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
