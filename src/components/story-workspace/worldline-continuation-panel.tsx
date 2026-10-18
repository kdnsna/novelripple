"use client";

import { useMemo, useRef, useState, useTransition } from "react";

import {
  generateContinuationDirectionsAction,
  generateContinuationSceneAction,
} from "@/app/projects/actions";
import {
  buildSceneTree,
  getDefaultScenePath,
  getScenePath,
  type SceneNode,
} from "@/domain/continuation/scene-tree";
import { deriveWorldlineDelta } from "@/domain/invariants/validate-continuation";
import type {
  ContextManifest,
  ContextManifestSectionKind,
  ContinuationSceneArtifact,
  ImpactPlanArtifact,
  StoryMapArtifact,
  Worldline,
} from "@/domain/schemas";
import {
  appendContinuationArtifact,
  type ContinuationDirectionBatchView,
  type ContinuationTreeView,
} from "./continuation-tree-view";

type PendingKind = "directions" | "newBatch" | "scene" | "retry";

type AutoRootDirections = {
  loading: boolean;
  error: string | null;
};

type WorldlineContinuationPanelProps = {
  projectId: string;
  storyMapArtifact: StoryMapArtifact;
  worldline: Worldline;
  acceptedImpactPlanArtifact: ImpactPlanArtifact;
  initialContinuation: ContinuationTreeView;
  autoRootDirections: AutoRootDirections;
  onRetryRootDirections: () => void;
  onClose: () => void;
};

const contextSectionLabels: Record<ContextManifestSectionKind, string> = {
  worldline_setup: "世界线设定",
  canon_events: "相关原著事件",
  path_summary: "路径摘要",
  canon_evidence: "原著证据",
  recent_scenes: "最近场景",
  selected_direction: "所选方向",
  anchor_reminder: "锚点提醒",
};

export function WorldlineContinuationPanel({
  projectId,
  storyMapArtifact,
  worldline,
  acceptedImpactPlanArtifact,
  initialContinuation,
  autoRootDirections,
  onRetryRootDirections,
  onClose,
}: WorldlineContinuationPanelProps) {
  const [view, setView] = useState(initialContinuation);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [pendingKind, setPendingKind] = useState<PendingKind | null>(null);
  const [pendingDirectionId, setPendingDirectionId] = useState<string | null>(
    null,
  );
  /**
   * useTransition 的 pending 在下一帧才可见；用 ref 同步拦住同一 tick 的
   * 双击，避免重复发起服务端请求。
   */
  const pendingRef = useRef(false);

  function beginPending(
    kind: PendingKind,
    directionId: string | null = null,
  ): boolean {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPendingKind(kind);
    setPendingDirectionId(directionId);
    return true;
  }

  function endPending(): void {
    pendingRef.current = false;
    setPendingKind(null);
    setPendingDirectionId(null);
  }

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

  const tree = useMemo(() => buildSceneTree(view.scenes), [view.scenes]);
  const defaultPath = useMemo(() => getDefaultScenePath(tree), [tree]);
  const selectedNode = selectedSceneId
    ? tree.nodes.get(selectedSceneId) ?? null
    : null;
  const currentPath = useMemo(
    () => (selectedNode ? getScenePath(tree, selectedNode.id) : defaultPath),
    [defaultPath, selectedNode, tree],
  );
  const selectedScene = currentPath[currentPath.length - 1] ?? null;

  const rootBatch = latestBatchForParent(view.directionBatches, null);
  const activeBatch = activeBatchId
    ? view.directionBatches.find((batch) => batch.id === activeBatchId) ?? null
    : selectedScene
      ? null
      : rootBatch;

  function runDirections(parentSceneId: string | null, newBatch: boolean): void {
    if (!beginPending(newBatch ? "newBatch" : "directions")) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await generateContinuationDirectionsAction({
          projectId,
          worldlineId: worldline.id,
          parentSceneId,
          newBatch,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setView((current) =>
          appendContinuationArtifact(current, result.artifact),
        );
        setActiveBatchId(result.artifact.id);
      } finally {
        endPending();
      }
    });
  }

  function generateScene(batch: ContinuationDirectionBatchView, directionId: string): void {
    if (!beginPending("scene", directionId)) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await generateContinuationSceneAction({
          projectId,
          worldlineId: worldline.id,
          directionsArtifactId: batch.id,
          selectedDirectionId: directionId,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        selectGeneratedScene(result.artifact);
      } finally {
        endPending();
      }
    });
  }

  function retrySelectedScene(): void {
    if (!selectedScene) return;
    if (!beginPending("retry")) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await generateContinuationSceneAction({
          projectId,
          worldlineId: worldline.id,
          directionsArtifactId: selectedScene.directionsArtifactId,
          selectedDirectionId: selectedScene.selectedDirectionId,
          retry: true,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        selectGeneratedScene(result.artifact);
      } finally {
        endPending();
      }
    });
  }

  function selectGeneratedScene(artifact: ContinuationSceneArtifact): void {
    setView((current) => appendContinuationArtifact(current, artifact));
    setSelectedSceneId(artifact.id);
    setActiveBatchId(null);
  }

  function selectSibling(sibling: SceneNode): void {
    setSelectedSceneId(sibling.id);
    setActiveBatchId(null);
    setError(null);
  }

  return (
    <aside
      className="workspace-panel detail-panel continuation-panel"
      data-testid="worldline-continuation"
    >
      <div className="panel-heading detail-heading">
        <div>
          <span className="panel-kicker">Worldline · 场景节点树</span>
          <h2>续写当前路径</h2>
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
          <small>
            {plan.mode === "strict" ? "保留原结局" : "让故事自由发展"}
          </small>
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

      {currentPath.length === 0 ? (
        <section className="continuation-empty">
          <h3>下一步：从分歧点生成 3 个方向</h3>
          <p>
            只读取当前 Worldline、已接受 ImpactPlan、相关原文 Evidence
            和当前状态。
          </p>
          {!activeBatch && autoRootDirections.loading ? (
            <p className="ripple-suggestions-status" role="status">
              正在构思 3 个方向…
            </p>
          ) : null}
          {!activeBatch && autoRootDirections.error ? (
            <div className="ripple-suggestions-error" role="alert">
              <p className="continuation-action-error">
                {autoRootDirections.error}
              </p>
              <button
                className="secondary-button compact-button"
                onClick={onRetryRootDirections}
                type="button"
              >
                重试
              </button>
            </div>
          ) : null}
          {!activeBatch &&
          !autoRootDirections.loading &&
          !autoRootDirections.error ? (
            <button
              className="primary-button full-width-button"
              disabled={pending}
              onClick={() => runDirections(null, false)}
              type="button"
            >
              {pendingKind === "directions"
                ? "正在生成方向…"
                : "生成 3 个后续方向"}
            </button>
          ) : null}
        </section>
      ) : (
        <section
          className="continuation-path"
          aria-label="当前场景路径"
          data-testid="continuation-path"
        >
          {currentPath.map((scene, index) => {
            const isSelected = index === currentPath.length - 1;
            const siblings =
              tree.childrenByParent.get(scene.parentSceneId) ?? [];
            const siblingIndex = siblings.findIndex(
              (sibling) => sibling.id === scene.id,
            );
            return (
              <article
                className={`path-scene ${isSelected ? "selected" : ""}`}
                data-testid={
                  isSelected ? "continuation-scene" : "continuation-path-scene"
                }
                key={scene.id}
              >
                <div className="path-scene-meta">
                  <span className="panel-kicker">
                    第 {scene.depth} 幕
                    {scene.origin === "retry" ? " · 重试" : ""}
                  </span>
                  {siblings.length > 1 ? (
                    <div
                      className="scene-sibling-nav"
                      data-testid="scene-siblings"
                    >
                      <button
                        aria-label="上一个兄弟场景"
                        disabled={siblingIndex <= 0}
                        onClick={() => {
                          const sibling = siblings[siblingIndex - 1];
                          if (sibling) selectSibling(sibling);
                        }}
                        type="button"
                      >
                        ‹
                      </button>
                      <span>
                        {siblingIndex + 1}/{siblings.length}
                      </span>
                      <button
                        aria-label="下一个兄弟场景"
                        disabled={siblingIndex >= siblings.length - 1}
                        onClick={() => {
                          const sibling = siblings[siblingIndex + 1];
                          if (sibling) selectSibling(sibling);
                        }}
                        type="button"
                      >
                        ›
                      </button>
                    </div>
                  ) : null}
                </div>

                <h3>{scene.title}</h3>
                <div className="scene-prose">
                  {scene.prose
                    .split(/\n+/)
                    .filter(Boolean)
                    .map((paragraph) => (
                      <p key={paragraph}>{paragraph}</p>
                    ))}
                </div>

                {isSelected ? (
                  <>
                    <details className="state-patch-details">
                      <summary>查看 State Patch</summary>
                      <dl>
                        <div>
                          <dt>新增事实</dt>
                          <dd>
                            {scene.statePatch.factsAdded
                              .map((fact) => fact.statement)
                              .join("；") || "无"}
                          </dd>
                        </div>
                        <div>
                          <dt>删除事实</dt>
                          <dd>
                            {scene.statePatch.factsRemoved.join("；") || "无"}
                          </dd>
                        </div>
                        <div>
                          <dt>人物变化</dt>
                          <dd>
                            {scene.statePatch.characterChanges
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
                            {scene.statePatch.threadsOpened.join("；") || "无"}
                            <br />
                            关闭：
                            {scene.statePatch.threadsClosed.join("；") || "无"}
                          </dd>
                        </div>
                      </dl>
                    </details>

                    {scene.contextManifest ? (
                      <ContextViewer manifest={scene.contextManifest} />
                    ) : null}
                  </>
                ) : null}
              </article>
            );
          })}
        </section>
      )}

      {selectedScene ? (
        <div className="continuation-scene-actions">
          <button
            className="primary-button full-width-button"
            disabled={pending}
            onClick={() => runDirections(selectedScene.id, false)}
            type="button"
          >
            {pendingKind === "directions" ? "正在生成方向…" : "继续"}
          </button>
          <button
            className="secondary-button"
            disabled={pending}
            onClick={retrySelectedScene}
            type="button"
          >
            {pendingKind === "retry" ? "正在重试本幕…" : "重试本幕"}
          </button>
        </div>
      ) : null}

      {activeBatch ? (
        <section
          className="continuation-directions"
          data-testid="continuation-directions"
        >
          <div className="continuation-section-heading">
            <div>
              <span className="panel-kicker">
                方向批次 {activeBatch.batchIndex + 1}
              </span>
              <h3>选择一个方向生成本幕</h3>
            </div>
            <button
              className="text-button"
              disabled={pending}
              onClick={() =>
                runDirections(activeBatch.parentSceneId, true)
              }
              type="button"
            >
              {pendingKind === "newBatch" ? "正在换一批…" : "换一批"}
            </button>
          </div>
          <div className="direction-card-list">
            {activeBatch.directions.map((direction) => (
              <article className="direction-card" key={direction.id}>
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
                  disabled={pending}
                  onClick={() => generateScene(activeBatch, direction.id)}
                  type="button"
                >
                  {pendingKind === "scene" &&
                  pendingDirectionId === direction.id
                    ? "正在生成场景…"
                    : "选择此方向"}
                </button>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {error ? (
        <p
          className="workspace-action-error continuation-action-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </aside>
  );
}

function ContextViewer({ manifest }: { manifest: ContextManifest }) {
  return (
    <details className="context-viewer" data-testid="context-viewer">
      <summary>上下文</summary>
      <div className="context-viewer-body">
        <p>
          预算使用 {manifest.budget.percentageUsed}% ·{" "}
          {manifest.budget.totalChars}/{manifest.budget.maxChars} 字符
        </p>
        <ul>
          {manifest.sections.map((section) => (
            <li data-kind={section.kind} key={section.kind}>
              <strong>{contextSectionLabels[section.kind]}</strong>
              <span>
                {section.included ? "已包含" : "未包含"} · {section.chars} 字符
                {section.trimmed ? " · 已裁剪" : ""} · 丢弃{" "}
                {section.droppedItemIds.length} 项
              </span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

function latestBatchForParent(
  batches: readonly ContinuationDirectionBatchView[],
  parentSceneId: string | null,
): ContinuationDirectionBatchView | null {
  let latest: ContinuationDirectionBatchView | null = null;
  for (const batch of batches) {
    if (batch.parentSceneId !== parentSceneId) continue;
    if (
      !latest ||
      latest.batchIndex < batch.batchIndex ||
      (latest.batchIndex === batch.batchIndex &&
        (latest.createdAt < batch.createdAt ||
          (latest.createdAt === batch.createdAt && latest.id < batch.id)))
    ) {
      latest = batch;
    }
  }
  return latest;
}
