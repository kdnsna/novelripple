"use client";

import { useMemo, useState, useTransition } from "react";

import {
  generateContinuationDirectionsAction,
  generateContinuationSceneAction,
} from "@/app/projects/actions";
import { deriveWorldlineDelta } from "@/domain/invariants/validate-continuation";
import type {
  ContinuationArtifact,
  ContinuationDirectionsArtifact,
  ContinuationSceneArtifact,
  ImpactPlanArtifact,
  StoryMapArtifact,
  Worldline,
} from "@/domain/schemas";

type WorldlineContinuationPanelProps = {
  projectId: string;
  storyMapArtifact: StoryMapArtifact;
  worldline: Worldline;
  acceptedImpactPlanArtifact: ImpactPlanArtifact;
  initialArtifacts: ContinuationArtifact[];
  onClose: () => void;
};

export function WorldlineContinuationPanel({
  projectId,
  storyMapArtifact,
  worldline,
  acceptedImpactPlanArtifact,
  initialArtifacts,
  onClose,
}: WorldlineContinuationPanelProps) {
  const [directionsArtifact, setDirectionsArtifact] =
    useState<ContinuationDirectionsArtifact | null>(() =>
      findDirections(initialArtifacts),
    );
  const [sceneArtifact, setSceneArtifact] =
    useState<ContinuationSceneArtifact | null>(() =>
      findScene(initialArtifacts),
    );
  const [selectedDirectionId, setSelectedDirectionId] = useState<string | null>(
    () => findScene(initialArtifacts)?.continuation.selectedDirectionId ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const storyMap = storyMapArtifact.storyMap;
  const plan = acceptedImpactPlanArtifact.impactPlan;
  const currentState = useMemo(
    () =>
      deriveWorldlineDelta({
        worldline,
        impactPlan: plan,
        storyMap,
      }),
    [plan, storyMap, worldline],
  );
  const characterNames = Object.fromEntries(
    storyMap.characters.map((character) => [character.id, character.name]),
  );
  const eventTitles = Object.fromEntries(
    storyMap.events.map((event) => [event.id, event.title]),
  );

  function generateDirections(): void {
    setError(null);
    startTransition(async () => {
      const result = await generateContinuationDirectionsAction({
        projectId,
        worldlineId: worldline.id,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDirectionsArtifact(result.artifact);
    });
  }

  function generateScene(directionId: string): void {
    if (!directionsArtifact) return;
    setError(null);
    const previousSelectedDirectionId = selectedDirectionId;
    setSelectedDirectionId(directionId);
    startTransition(async () => {
      const result = await generateContinuationSceneAction({
        projectId,
        worldlineId: worldline.id,
        directionsArtifactId: directionsArtifact.id,
        selectedDirectionId: directionId,
      });
      if (!result.ok) {
        setSelectedDirectionId(previousSelectedDirectionId);
        setError(result.error);
        return;
      }
      setSelectedDirectionId(result.artifact.continuation.selectedDirectionId);
      setSceneArtifact(result.artifact);
    });
  }

  return (
    <aside
      className="workspace-panel detail-panel continuation-panel"
      data-testid="worldline-continuation"
    >
      <div className="panel-heading detail-heading">
        <div>
          <span className="panel-kicker">Worldline · 基线 + Delta</span>
          <h2>单场景 Continuation</h2>
        </div>
        <button className="text-button" onClick={onClose} type="button">
          返回 Evidence
        </button>
      </div>

      <ol className="worldline-chain" aria-label="Worldline 路径">
        <li>
          <span>Canon</span>
          <strong>Story Map v{storyMapArtifact.version}</strong>
          <small>只读基线</small>
        </li>
        <li>
          <span>Divergence</span>
          <strong>{plan.divergence.instruction}</strong>
          <small>{plan.divergence.type}</small>
        </li>
        <li>
          <span>当前 Worldline</span>
          <strong>{worldline.id}</strong>
          <small>{plan.mode === "strict" ? "严格模式" : "开放模式"}</small>
        </li>
      </ol>

      <section className="worldline-delta" data-testid="worldline-delta">
        <h3>当前 Delta</h3>
        <div>
          <strong>删除/改写的 Canon 事实</strong>
          <ul>
            {currentState.factsRemoved.map((key) => {
              const eventId = key.startsWith("event:") ? key.slice(6) : key;
              return <li key={key}>{eventTitles[eventId] ?? key}</li>;
            })}
          </ul>
        </div>
        <div>
          <strong>新增分支事实</strong>
          <ul>
            {currentState.factsAdded.map((fact) => (
              <li key={fact.key}>{fact.statement}</li>
            ))}
          </ul>
        </div>
      </section>

      {!directionsArtifact ? (
        <section className="continuation-empty">
          <h3>下一步：生成 3 个未来方向</h3>
          <p>
            只读取当前 Worldline、已接受 ImpactPlan、相关原文 Evidence
            和当前状态。
          </p>
          <button
            className="primary-button full-width-button"
            disabled={pending}
            onClick={generateDirections}
            type="button"
          >
            {pending ? "正在生成方向…" : "生成 3 个后续方向"}
          </button>
        </section>
      ) : (
        <section className="continuation-directions">
          <div className="continuation-section-heading">
            <span className="panel-kicker">3 个后续方向</span>
            <h3>选择本次唯一场景</h3>
          </div>
          <div className="direction-card-list">
            {directionsArtifact.continuation.directions.map((direction) => (
              <article
                className={`direction-card ${
                  selectedDirectionId === direction.id ? "selected" : ""
                }`}
                key={direction.id}
              >
                <h4>{direction.title}</h4>
                <p>{direction.premise}</p>
                <small>
                  影响人物：
                  {direction.affectedCharacterIds
                    .map((id) => characterNames[id] ?? id)
                    .join("、")}
                </small>
                <p className="direction-consequence">
                  <strong>预期后果：</strong>
                  {direction.expectedConsequence}
                </p>
                <button
                  className="secondary-button"
                  disabled={pending || sceneArtifact !== null}
                  onClick={() => generateScene(direction.id)}
                  type="button"
                >
                  {sceneArtifact?.continuation.selectedDirectionId ===
                  direction.id
                    ? "已生成此场景"
                    : pending && selectedDirectionId === direction.id
                      ? "正在生成场景…"
                      : "选择此方向"}
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      {sceneArtifact ? (
        <article className="continuation-scene" data-testid="continuation-scene">
          <span className="panel-kicker">当前场景 · 1 / 1</span>
          <h3>{sceneArtifact.continuation.title}</h3>
          <div className="scene-prose">
            {sceneArtifact.continuation.prose
              .split(/\n+/)
              .filter(Boolean)
              .map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
          </div>
          <details className="state-patch-details">
            <summary>查看 State Patch</summary>
            <dl>
              <div>
                <dt>新增事实</dt>
                <dd>
                  {sceneArtifact.continuation.statePatch.factsAdded
                    .map((fact) => fact.statement)
                    .join("；") || "无"}
                </dd>
              </div>
              <div>
                <dt>删除事实</dt>
                <dd>
                  {sceneArtifact.continuation.statePatch.factsRemoved.join(
                    "；",
                  ) || "无"}
                </dd>
              </div>
              <div>
                <dt>人物变化</dt>
                <dd>
                  {sceneArtifact.continuation.statePatch.characterChanges
                    .map(
                      (change) =>
                        `${characterNames[change.characterId] ?? change.characterId}：${change.summary}`,
                    )
                    .join("；") || "无"}
                </dd>
              </div>
              <div>
                <dt>线索变化</dt>
                <dd>
                  开启：
                  {sceneArtifact.continuation.statePatch.threadsOpened.join(
                    "；",
                  ) || "无"}
                  <br />
                  关闭：
                  {sceneArtifact.continuation.statePatch.threadsClosed.join(
                    "；",
                  ) || "无"}
                </dd>
              </div>
            </dl>
          </details>
          <p className="m0-continuation-boundary">
            M0 在此停止：本世界线只生成一个场景，不提供无限续写。
          </p>
        </article>
      ) : null}

      {error ? (
        <p className="workspace-action-error" role="alert">
          {error}
        </p>
      ) : null}
    </aside>
  );
}

function findDirections(
  artifacts: ContinuationArtifact[],
): ContinuationDirectionsArtifact | null {
  const artifact = artifacts.find(
    (candidate) => candidate.artifactType === "directions",
  );
  return artifact?.artifactType === "directions" ? artifact : null;
}

function findScene(
  artifacts: ContinuationArtifact[],
): ContinuationSceneArtifact | null {
  const artifact = artifacts.find(
    (candidate) => candidate.artifactType === "scene",
  );
  return artifact?.artifactType === "scene" ? artifact : null;
}
