"use client";

import { useMemo, useRef, useState, useTransition } from "react";

import {
  generateContinuationDirectionsAction,
  generateContinuationSceneAction,
} from "@/app/projects/actions";
import {
  buildSceneTree,
  derivePathState,
  type SceneNode,
} from "@/domain/continuation/scene-tree";
import {
  buildWorldlineTreeOutline,
  derivePathCharacterTimeline,
  latestBatchForParent,
  listDirectionOptions,
  resolveReadingPath,
  type ContinuationDirectionBatchView,
  type ReadingPosition,
} from "@/domain/continuation/worldline-tree";
import {
  isDirectionBatchStale,
  SETTING_DELTA_STALE_BATCH_MESSAGE,
} from "@/domain/continuation/setting-deltas";
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
  type ContinuationTreeView,
} from "./continuation-tree-view";
import { PathCharacterStates } from "./path-character-states";
import { PathSettingDeltas } from "./path-setting-deltas";
import { WorldlineTreeNav } from "./worldline-tree-nav";
import {
  defaultExpandedTreeIds,
  expandTreeIdsForPath,
} from "./worldline-tree-ui";

type PendingKind =
  | "directions"
  | "newBatch"
  | "scene"
  | "directionRetry"
  | "retry";

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
  setting_deltas: "路径设定增量",
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
  const [position, setPosition] = useState<ReadingPosition>({
    kind: "default",
  });
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

  const characterNames = Object.fromEntries(
    storyMap.characters.map((character) => [character.id, character.name]),
  );
  const eventTitles = Object.fromEntries(
    storyMap.events.map((event) => [event.id, event.title]),
  );

  const tree = useMemo(() => buildSceneTree(view.scenes), [view.scenes]);
  const currentPath = useMemo(
    () => resolveReadingPath(tree, position),
    [position, tree],
  );
  const currentNode = currentPath[currentPath.length - 1] ?? null;
  const currentNodeId = currentNode?.id ?? null;

  /**
   * 展开集合是组件状态：初始为当前路径，位置变化时只并入新路径。
   * 用户手动展开的旁支不会被位置切换丢弃。
   */
  const [expandedIds, setExpandedIds] = useState<Set<string | null>>(() =>
    defaultExpandedTreeIds(currentPath),
  );

  const treeRows = useMemo(
    () =>
      buildWorldlineTreeOutline({
        tree,
        directionBatches: view.directionBatches,
        currentPath,
        expandedIds,
      }),
    [currentPath, expandedIds, tree, view.directionBatches],
  );

  /**
   * baseDelta 与路径状态始终一起派生：任一步失败就整体 fail closed，
   * 不展示半份 Delta 或人物状态。
   */
  const pathDerivation = useMemo(() => {
    try {
      const baseDelta = deriveWorldlineDelta({
        worldline,
        impactPlan: plan,
        storyMap,
      });
      const pathState = derivePathState(baseDelta, currentPath);
      const characters = derivePathCharacterTimeline({
        baseDelta,
        path: currentPath,
        characters: storyMap.characters.map((character) => ({
          id: character.id,
          name: character.name,
        })),
      });
      return { baseDelta, pathState, characters, error: null as string | null };
    } catch {
      return {
        baseDelta: null,
        pathState: null,
        characters: [],
        error: "无法沿当前路径推导状态，请刷新或返回 Evidence 后重试。",
      };
    }
  }, [currentPath, plan, storyMap, worldline]);

  const directionOptions = useMemo(
    () =>
      listDirectionOptions({
        tree,
        directionBatches: view.directionBatches,
        parentSceneId: currentNodeId,
      }),
    [currentNodeId, tree, view.directionBatches],
  );

  /**
   * activeBatchId 只在仍属于当前节点时生效；否则回退到当前节点的最新批次。
   * 这样旧的 activeBatchId 不会把上一个节点的方向显示到新路径上。
   */
  const activeBatchOption = useMemo(() => {
    const selected = activeBatchId
      ? directionOptions.find(
          (option) => option.batch.id === activeBatchId,
        ) ?? null
      : null;
    if (selected) return selected;

    const latest = latestBatchForParent(
      view.directionBatches,
      currentNodeId,
    );
    if (!latest) return null;
    return directionOptions.find((option) => option.batch.id === latest.id) ?? null;
  }, [activeBatchId, currentNodeId, directionOptions, view.directionBatches]);
  const activeBatch = activeBatchOption?.batch ?? null;

  /**
   * 批次是否早于当前设定增量。activeBatch 始终属于当前节点，因此父路径就是
   * currentPath；派生失败时由服务端继续 fail closed，这里不伪装成 stale。
   */
  const activeBatchStale = useMemo(() => {
    if (!activeBatch) return false;
    try {
      return isDirectionBatchStale({
        batch: {
          id: activeBatch.id,
          parentSceneId: activeBatch.parentSceneId,
          createdAt: activeBatch.createdAt,
          ...(activeBatch.settingDeltaFingerprint === undefined
            ? {}
            : {
                settingDeltaFingerprint:
                  activeBatch.settingDeltaFingerprint,
              }),
        },
        tree,
        pathToParent: currentPath,
        deltas: view.settingDeltas,
        lifecycles: view.settingDeltaLifecycles,
      });
    } catch {
      return false;
    }
  }, [
    activeBatch,
    currentPath,
    tree,
    view.settingDeltaLifecycles,
    view.settingDeltas,
  ]);

  function movePosition(next: ReadingPosition): void {
    // 阅读位置只通过这里和 selectGeneratedScene 改变；在此并入新路径的
    // 展开集合，避免用 effect 触发级联渲染。
    setExpandedIds((current) =>
      expandTreeIdsForPath(current, resolveReadingPath(tree, next)),
    );
    setPosition(next);
    setActiveBatchId(null);
    setError(null);
  }

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

  function generateScene(
    batch: ContinuationDirectionBatchView,
    directionId: string,
    retry = false,
  ): void {
    if (!beginPending(retry ? "directionRetry" : "scene", directionId)) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await generateContinuationSceneAction({
          projectId,
          worldlineId: worldline.id,
          directionsArtifactId: batch.id,
          selectedDirectionId: directionId,
          ...(retry ? { retry: true } : {}),
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
    if (!currentNode) return;
    if (!beginPending("retry")) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await generateContinuationSceneAction({
          projectId,
          worldlineId: worldline.id,
          directionsArtifactId: currentNode.directionsArtifactId,
          selectedDirectionId: currentNode.selectedDirectionId,
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
    const nextTree = buildSceneTree([...view.scenes, artifact.continuation]);
    setExpandedIds((current) =>
      expandTreeIdsForPath(
        current,
        resolveReadingPath(nextTree, {
          kind: "scene",
          sceneId: artifact.id,
        }),
      ),
    );
    setView((current) => appendContinuationArtifact(current, artifact));
    setPosition({ kind: "scene", sceneId: artifact.id });
    setActiveBatchId(null);
  }

  function selectSibling(sibling: SceneNode): void {
    movePosition({ kind: "scene", sceneId: sibling.id });
  }

  function moveToTreeRow(id: string | null): void {
    movePosition(id === null ? { kind: "root" } : { kind: "scene", sceneId: id });
  }

  function toggleTreeRow(id: string | null): void {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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

      {tree.nodes.size > 0 ? (
        <WorldlineTreeNav
          onMove={(row) => moveToTreeRow(row.id)}
          onToggle={toggleTreeRow}
          rows={treeRows}
        />
      ) : null}

      <section className="worldline-delta" data-testid="worldline-delta">
        <h3>当前路径 Delta</h3>
        {pathDerivation.error || !pathDerivation.pathState ? (
          <p className="continuation-action-error" role="alert">
            {pathDerivation.error ?? "无法沿当前路径推导状态。"}
          </p>
        ) : (
          <>
            <div>
              <strong>删除/改写的 Canon 事实</strong>
              <ul>
                {pathDerivation.pathState.factsRemoved.map((key) => {
                  const eventId = key.startsWith("event:") ? key.slice(6) : key;
                  return <li key={key}>{eventTitles[eventId] ?? key}</li>;
                })}
              </ul>
            </div>
            <div>
              <strong>新增分支事实</strong>
              <ul>
                {pathDerivation.pathState.factsAdded.map((fact) => (
                  <li key={fact.key}>{fact.statement}</li>
                ))}
              </ul>
            </div>
          </>
        )}
      </section>

      {!pathDerivation.error && pathDerivation.pathState ? (
        <PathCharacterStates states={pathDerivation.characters} />
      ) : null}

      <PathSettingDeltas
        characters={storyMap.characters}
        currentPath={currentPath}
        onArtifactAdded={(artifact) =>
          setView((current) => appendContinuationArtifact(current, artifact))
        }
        projectId={projectId}
        settingDeltaLifecycles={view.settingDeltaLifecycles}
        settingDeltas={view.settingDeltas}
        tree={tree}
        worldlineId={worldline.id}
      />

      {currentPath.length === 0 && !activeBatch ? (
        <section className="continuation-empty">
          <h3>下一步：从分歧点生成 3 个方向</h3>
          <p>
            只读取当前 Worldline、已接受 ImpactPlan、相关原文 Evidence
            和当前状态。
          </p>
          {autoRootDirections.loading ? (
            <p className="ripple-suggestions-status" role="status">
              正在构思 3 个方向…
            </p>
          ) : null}
          {autoRootDirections.error ? (
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
          {!autoRootDirections.loading && !autoRootDirections.error ? (
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
      ) : null}

      {currentPath.length > 0 ? (
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

                {scene.canonWarnings && scene.canonWarnings.length > 0 ? (
                  <ul
                    className="canon-warning-list"
                    data-testid="canon-warnings"
                    role="status"
                  >
                    {scene.canonWarnings.map((warning) => (
                      <li key={`${warning.eventId}:${warning.field}`}>
                        原著一致性提示：{warning.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}

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
      ) : null}

      {currentNode ? (
        <div className="continuation-scene-actions">
          {!activeBatch ? (
            <button
              className="primary-button full-width-button"
              disabled={pending}
              onClick={() => runDirections(currentNode.id, false)}
              type="button"
            >
              {pendingKind === "directions" ? "正在生成方向…" : "继续"}
            </button>
          ) : null}
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
              onClick={() => runDirections(activeBatch.parentSceneId, true)}
              type="button"
            >
              {pendingKind === "newBatch" ? "正在换一批…" : "换一批"}
            </button>
          </div>
          {activeBatchStale ? (
            <p
              className="setting-delta-stale-banner"
              data-testid="setting-delta-stale-banner"
              role="status"
            >
              {SETTING_DELTA_STALE_BATCH_MESSAGE}
            </p>
          ) : null}
          {activeBatch.canonWarnings &&
          activeBatch.canonWarnings.length > 0 ? (
            <ul
              className="canon-warning-list"
              data-testid="canon-warnings"
              role="status"
            >
              {activeBatch.canonWarnings.map((warning) => (
                <li key={`${warning.eventId}:${warning.field}`}>
                  原著一致性提示：{warning.reason}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="direction-card-list">
            {activeBatchOption?.directions.map(({ direction, sceneIds }) => {
              const generated = sceneIds.length > 0;
              return (
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
                  {generated ? (
                    <div className="direction-generated-actions">
                      <button
                        className="secondary-button"
                        disabled={pending}
                        onClick={() => {
                          const sceneId = sceneIds[0];
                          if (sceneId) {
                            movePosition({ kind: "scene", sceneId });
                          }
                        }}
                        type="button"
                      >
                        查看已生成（{sceneIds.length} 版）
                      </button>
                      <button
                        className="text-button"
                        disabled={pending || activeBatchStale}
                        onClick={() =>
                          generateScene(activeBatch, direction.id, true)
                        }
                        type="button"
                      >
                        {pendingKind === "directionRetry" &&
                        pendingDirectionId === direction.id
                          ? "正在再写一版…"
                          : "再写一版"}
                      </button>
                    </div>
                  ) : (
                    <button
                      className="secondary-button"
                      disabled={pending || activeBatchStale}
                      onClick={() => generateScene(activeBatch, direction.id)}
                      type="button"
                    >
                      {pendingKind === "scene" &&
                      pendingDirectionId === direction.id
                        ? "正在生成场景…"
                        : "选择此方向"}
                    </button>
                  )}
                </article>
              );
            })}
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
