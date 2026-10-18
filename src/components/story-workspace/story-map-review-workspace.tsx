"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  confirmStoryMapAction,
  generateContinuationDirectionsAction,
  generateRippleSuggestionsAction,
  quickStartRippleAction,
  reviseStoryMapAction,
  type StoryMapActionResult,
} from "@/app/projects/actions";
import type { EvidencePickerOption } from "@/components/story-workspace/evidence-unit-picker";
import {
  appendContinuationArtifact,
  emptyContinuationTreeView,
  type ContinuationTreeView,
} from "@/components/story-workspace/continuation-tree-view";
import {
  deriveStoryMapReview,
  type DerivedStoryMapReview,
  type StoryMapReviewQueueItem,
} from "@/domain/review/derive-story-map-review";
import { deriveStoryMapRefinementState } from "@/domain/review/derive-story-map-refinement";
import {
  sourceReferenceKey,
  type ContinuationDirectionsArtifact,
  type Event,
  type ImpactPlanArtifact,
  type RippleSuggestionsArtifact,
  type Source,
  type SourceReference,
  type StoryMapArtifact,
  type StoryMapRevisionChange,
  type Worldline,
  type WorldlineBookmark,
  type WorldlineCharacterStatusOverride,
} from "@/domain/schemas";
import { RippleSimulatorPanel } from "./ripple-simulator-panel";
import { SourceReader } from "./source-reader";
import { StoryMapCanvas } from "./story-map-canvas";
import { StoryMapDetails } from "./story-map-details";
import { StoryMapReadiness } from "./story-map-readiness";
import {
  StoryMapReviewEditor,
  type ReviewEditorSelection,
} from "./review-editor";
import { StoryMapReviewQueue } from "./story-map-review-queue";
import { WorldlineContinuationPanel } from "./worldline-continuation-panel";

type StoryMapReviewWorkspaceProps = {
  projectId: string;
  source: Source;
  initialArtifact: StoryMapArtifact;
  initialRippleOpen: boolean;
  evidenceOptions: EvidencePickerOption[];
  initialWorldlines: Worldline[];
  initialImpactPlanArtifacts: ImpactPlanArtifact[];
  /** 已持久化的建议批次，按 batchIndex 升序；空数组表示当前 revision 还没有建议。 */
  initialRippleSuggestionBatches: RippleSuggestionsArtifact[];
  initialContinuationTrees: ContinuationTreeView[];
  initialWorldlineBookmarks: WorldlineBookmark[];
  initialCharacterStatusOverrides: WorldlineCharacterStatusOverride[];
  rippleSuggestionBatchLimit: number;
};

type SuggestionsState = {
  artifactId: string;
  batches: RippleSuggestionsArtifact[];
  loading: boolean;
  error: string | null;
};

type RootDirectionsState = {
  status: "loading" | "loaded" | "error";
  artifact: ContinuationDirectionsArtifact | null;
  error: string | null;
};

export function StoryMapReviewWorkspace({
  projectId,
  source,
  initialArtifact,
  initialRippleOpen,
  evidenceOptions,
  initialWorldlines,
  initialImpactPlanArtifacts,
  initialRippleSuggestionBatches,
  initialContinuationTrees,
  initialWorldlineBookmarks,
  initialCharacterStatusOverrides,
  rippleSuggestionBatchLimit,
}: StoryMapReviewWorkspaceProps) {
  const router = useRouter();
  // artifact 是本地状态：revision 成功后立即快进（不等待导航），
  // 外部导航或页面刷新时再从 props 同步。两者以 id 相等为幂等条件。
  const [artifact, setArtifact] = useState(initialArtifact);
  const storyMap = artifact.storyMap;
  const derivedReview = useMemo(
    () => deriveStoryMapReview(artifact, source),
    [artifact, source],
  );
  const refinementState = useMemo(
    () => deriveStoryMapRefinementState(artifact, derivedReview),
    [artifact, derivedReview],
  );
  const defaultSelection = selectDefaultReviewItem(derivedReview);
  const [selection, setSelection] = useState<ReviewEditorSelection>(defaultSelection);
  const [viewMode, setViewMode] = useState<"review" | "graph">(
    initialRippleOpen ? "graph" : "review",
  );
  const [selectedEventId, setSelectedEventId] = useState(
    eventIdForSelection(defaultSelection, artifact) ?? storyMap.events[0].id,
  );
  const [characterFilter, setCharacterFilter] = useState("");
  const [activeEvidence, setActiveEvidence] = useState<SourceReference | null>(
    evidenceForSelection(defaultSelection, artifact) ??
      storyMap.events[0].evidence[0] ??
      null,
  );
  const [result, setResult] = useState<StoryMapActionResult | null>(null);
  const [rippleOpen, setRippleOpen] = useState(
    storyMap.status === "confirmed" && initialRippleOpen,
  );
  const [worldlines, setWorldlines] = useState(initialWorldlines);
  const [impactPlanArtifacts, setImpactPlanArtifacts] = useState(
    initialImpactPlanArtifacts,
  );
  const [activeWorldlineId, setActiveWorldlineId] = useState<string | null>(null);
  // Suggestions 与根方向请求都提升到工作区：面板关闭/重开、切换 Event 或
  // 场景面板重挂载都不应重新发起付费生成。状态按实体 id 归属，只有当前
  // Story Map artifact / worldline 匹配时才传给面板。
  const [suggestionsState, setSuggestionsState] = useState<SuggestionsState>(
    () => ({
      artifactId: initialArtifact.id,
      batches: initialRippleSuggestionBatches,
      loading: false,
      error: null,
    }),
  );
  const suggestionsAutoRequested = useRef<Set<string>>(new Set());
  const [rootDirectionsByWorldline, setRootDirectionsByWorldline] = useState<
    Record<string, RootDirectionsState>
  >({});
  const rootDirectionsAutoRequested = useRef<Set<string>>(new Set());
  // 单一 pending 是有意设计：revision 操作很短，禁用全部 mutation 按钮
  // 可以防止同一工作区并发提交产生交错 revision（服务端仍有 stale 校验兜底）。
  // AI 生成类操作在各自面板内拥有独立的 useTransition。
  const [pending, startTransition] = useTransition();

  const requestSuggestions = useCallback(
    async (
      artifactId: string,
      idempotencyKey?: string,
    ): Promise<RippleSuggestionsArtifact | null> => {
      setSuggestionsState((current) =>
        current.artifactId === artifactId
          ? { ...current, loading: true, error: null }
          : current,
      );
      try {
        const response = await generateRippleSuggestionsAction({
          projectId,
          storyMapArtifactId: artifactId,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
        if (!response.ok) {
          setSuggestionsState((current) =>
            current.artifactId === artifactId
              ? { ...current, loading: false, error: response.error }
              : current,
          );
          return null;
        }
        setSuggestionsState((current) =>
          current.artifactId === artifactId
            ? {
                ...current,
                loading: false,
                batches: mergeSuggestionBatch(
                  current.batches,
                  response.artifact,
                ),
                error: null,
              }
            : current,
        );
        return response.artifact;
      } catch {
        setSuggestionsState((current) =>
          current.artifactId === artifactId
            ? {
                ...current,
                loading: false,
                error: "Ripple Suggestions 生成失败，请重试。",
              }
            : current,
        );
        return null;
      }
    },
    [projectId],
  );

  const requestRootDirections = useCallback(
    async (worldlineId: string): Promise<void> => {
      setRootDirectionsByWorldline((current) => {
        const previous = current[worldlineId];
        if (previous?.status === "loading") return current;
        return {
          ...current,
          [worldlineId]: {
            status: "loading",
            artifact: previous?.artifact ?? null,
            error: null,
          },
        };
      });
      try {
        const response = await generateContinuationDirectionsAction({
          projectId,
          worldlineId,
          parentSceneId: null,
          newBatch: false,
        });
        setRootDirectionsByWorldline((current) => ({
          ...current,
          [worldlineId]: response.ok
            ? { status: "loaded", artifact: response.artifact, error: null }
            : {
                status: "error",
                artifact: current[worldlineId]?.artifact ?? null,
                error: response.error,
              },
        }));
      } catch {
        setRootDirectionsByWorldline((current) => ({
          ...current,
          [worldlineId]: {
            status: "error",
            artifact: current[worldlineId]?.artifact ?? null,
            error: "Continuation 方向生成失败，请重试。",
          },
        }));
      }
    },
    [projectId],
  );

  // 当前 revision 还没有建议时自动生成一次。请求真正发出前先写 guard，
  // 因此 StrictMode、Event 切换和面板重挂载都不会再次自动请求；失败后只有
  // 用户点击“重试”才会重新请求。
  useEffect(() => {
    if (!rippleOpen || artifact.storyMap.status !== "confirmed") return;
    if (suggestionsState.artifactId !== artifact.id) return;
    if (
      suggestionsState.batches.length > 0 ||
      suggestionsState.loading ||
      suggestionsState.error
    ) {
      return;
    }
    if (suggestionsAutoRequested.current.has(artifact.id)) return;
    suggestionsAutoRequested.current.add(artifact.id);
    void requestSuggestions(artifact.id);
  }, [artifact.id, artifact.storyMap.status, requestSuggestions, rippleOpen, suggestionsState]);

  // 进入一条还没有根方向批次的 Worldline 时自动请求一次。服务端会复用
  // 已有批次并合并并发调用；guard 保证关闭/重开面板不会重复请求。
  function enterWorldline(worldlineId: string): void {
    setRippleOpen(false);
    setActiveWorldlineId(worldlineId);
    if (rootDirectionsAutoRequested.current.has(worldlineId)) return;
    const existingTree = initialContinuationTrees.find(
      (tree) => tree.worldlineId === worldlineId,
    );
    if (
      existingTree?.directionBatches.some(
        (batch) => batch.parentSceneId === null,
      )
    ) {
      return;
    }
    rootDirectionsAutoRequested.current.add(worldlineId);
    void requestRootDirections(worldlineId);
  }

  // props 同步（渲染期状态调整模式）：
  // - 本地 revision 快进后再由 replace 导航送回同一 artifact：只刷新派生数据列表；
  // - 真正的外部导航（Source 版本 / revision 链接）送来不同 artifact：整体迁移状态；
  // - 视图模式（viewMode）是纯 UI 状态，永远不在 artifact 变化时被重置——
  //   这正是“revision 后不重挂载工作区”的保证。
  const [syncedPropArtifactId, setSyncedPropArtifactId] = useState(
    initialArtifact.id,
  );
  if (syncedPropArtifactId !== initialArtifact.id) {
    setSyncedPropArtifactId(initialArtifact.id);
    if (initialArtifact.id !== artifact.id) {
      const nextReview = deriveStoryMapReview(initialArtifact, source);
      const nextSelection = selectDefaultReviewItem(nextReview);
      setArtifact(initialArtifact);
      setSelection(nextSelection);
      setRippleOpen(
        initialArtifact.storyMap.status === "confirmed" && initialRippleOpen,
      );
      setCharacterFilter("");
      setActiveWorldlineId(null);
      setSelectedEventId(
        eventIdForSelection(nextSelection, initialArtifact) ??
          initialArtifact.storyMap.events[0].id,
      );
      setActiveEvidence(
        evidenceForSelection(nextSelection, initialArtifact) ??
          initialArtifact.storyMap.events[0].evidence[0] ??
          null,
      );
      setSuggestionsState({
        artifactId: initialArtifact.id,
        batches: initialRippleSuggestionBatches,
        loading: false,
        error: null,
      });
    } else if (initialRippleSuggestionBatches.length > 0) {
      // 同一 artifact 的服务端数据刷新（例如生成建议后的 revalidate）可以
      // 补上本地还没有的批次，但不覆盖已加载的本地结果。
      setSuggestionsState((current) =>
        current.artifactId === initialArtifact.id && current.batches.length === 0
          ? { ...current, batches: initialRippleSuggestionBatches }
          : current,
      );
    }
    setWorldlines(initialWorldlines);
    setImpactPlanArtifacts(initialImpactPlanArtifacts);
  }

  const visibleEvents = useMemo(
    () =>
      characterFilter
        ? storyMap.events.filter((event) =>
            event.participants.includes(characterFilter),
          )
        : storyMap.events,
    [characterFilter, storyMap.events],
  );
  const selectedEvent =
    visibleEvents.find((event) => event.id === selectedEventId) ??
    visibleEvents[0] ??
    storyMap.events[0];
  const selectedEvidence =
    activeEvidence &&
    selectedEvent.evidence.some(
      (evidence) =>
        sourceReferenceKey(evidence) === sourceReferenceKey(activeEvidence),
    )
      ? activeEvidence
      : selectedEvent.evidence[0] ?? null;
  const activeWorldlines = worldlines.filter(
    (worldline) => worldline.status === "active",
  );
  const childWorldlineCount = activeWorldlines.length;
  const activeWorldline = activeWorldlines.find(
    (worldline) => worldline.id === activeWorldlineId,
  );
  const activeImpactPlanArtifact = activeWorldline?.acceptedImpactPlanId
    ? impactPlanArtifacts.find(
        (impactPlan) => impactPlan.id === activeWorldline.acceptedImpactPlanId,
      )
    : null;
  const activeSuggestions =
    suggestionsState.artifactId === artifact.id ? suggestionsState : null;
  const rootDirectionsState = activeWorldline
    ? rootDirectionsByWorldline[activeWorldline.id] ?? null
    : null;
  const activeContinuation = activeWorldline
    ? withRootDirections(
        initialContinuationTrees.find(
          (tree) => tree.worldlineId === activeWorldline.id,
        ) ?? emptyContinuationTreeView(activeWorldline.id),
        rootDirectionsState?.artifact ?? null,
      )
    : null;

  function selectEvent(event: Event): void {
    setSelectedEventId(event.id);
    setActiveEvidence(event.evidence[0] ?? null);
    setSelection({ kind: "event", eventId: event.id });
    setResult(null);
    setActiveWorldlineId(null);
    setRippleOpen(false);
  }

  function selectQueueItem(item: StoryMapReviewQueueItem): void {
    const nextSelection: ReviewEditorSelection = { kind: "queue", item };
    setSelection(nextSelection);
    const eventId = eventIdForSelection(nextSelection, artifact);
    if (eventId) setSelectedEventId(eventId);
    setActiveEvidence(
      evidenceForSelection(nextSelection, artifact) ??
        storyMap.events.find((event) => event.id === eventId)?.evidence[0] ??
        null,
    );
    setResult(null);
  }

  function selectTool(
    tool: "character" | "add_event" | "reorder" | "add_edge",
  ): void {
    setSelection({ kind: "tool", tool });
    setResult(null);
  }

  function filterByCharacter(characterId: string): void {
    setCharacterFilter(characterId);
    const filteredEvents = characterId
      ? storyMap.events.filter((event) =>
          event.participants.includes(characterId),
        )
      : storyMap.events;
    const nextEvent =
      filteredEvents.find((event) => event.id === selectedEventId) ??
      filteredEvents[0];
    if (!nextEvent) return;
    setSelectedEventId(nextEvent.id);
    setActiveEvidence(nextEvent.evidence[0] ?? null);
  }

  function artifactUrl(artifactId: string, openRipple: boolean): string {
    const url = new URL(window.location.href);
    url.searchParams.set("source", source.id);
    url.searchParams.set("artifact", artifactId);
    url.searchParams.delete("generated");
    if (openRipple) url.searchParams.set("ripple", "opened");
    else url.searchParams.delete("ripple");
    return url.pathname + url.search + url.hash;
  }

  /**
   * revision 成功后迁移本地视图状态，而不是重挂载整个工作区。
   * 当前队列项已核对（或已不存在）时推进到下一个待核项，保持引导流前进；
   * 纯工具选择与图中 Event 选择保持不变。
   */
  function adoptArtifact(nextArtifact: StoryMapArtifact): void {
    const nextReview = deriveStoryMapReview(nextArtifact, source);
    const nextStoryMap = nextArtifact.storyMap;
    setArtifact(nextArtifact);
    if (nextArtifact.id !== artifact.id) {
      setSuggestionsState({
        artifactId: nextArtifact.id,
        batches:
          nextArtifact.id === initialArtifact.id
            ? initialRippleSuggestionBatches
            : [],
        loading: false,
        error: null,
      });
    }
    setSelection((current) => {
      if (current.kind === "event") {
        return nextStoryMap.events.some((event) => event.id === current.eventId)
          ? current
          : selectDefaultReviewItem(nextReview);
      }
      if (current.kind === "tool") return current;
      const nextItem = nextReview.queue.find(
        (candidate) => candidate.id === current.item.id,
      );
      if (!nextItem || nextItem.status !== "pending") {
        return selectDefaultReviewItem(nextReview);
      }
      return { kind: "queue", item: nextItem };
    });
    setCharacterFilter((current) =>
      nextStoryMap.characters.some((character) => character.id === current)
        ? current
        : "",
    );
    setSelectedEventId((current) =>
      nextStoryMap.events.some((event) => event.id === current)
        ? current
        : nextStoryMap.events[0].id,
    );
    setActiveEvidence((current) => {
      if (!current) return nextStoryMap.events[0].evidence[0] ?? null;
      const event = nextStoryMap.events.find((candidate) =>
        candidate.evidence.some(
          (evidence) =>
            sourceReferenceKey(evidence) === sourceReferenceKey(current),
        ),
      );
      return event ? current : nextStoryMap.events[0].evidence[0] ?? null;
    });
  }

  function revise(change: StoryMapRevisionChange): void {
    setResult(null);
    startTransition(async () => {
      const response = await reviseStoryMapAction({
        projectId,
        artifactId: artifact.id,
        change,
      });
      setResult(response);
      if (response.ok) {
        adoptArtifact(response.artifact);
        // 单一往返：action 不再 revalidatePath，页面数据由这次 replace 导航刷新。
        router.replace(artifactUrl(response.artifact.id, false), { scroll: false });
      }
    });
  }

  function confirm(): void {
    setResult(null);
    startTransition(async () => {
      const response = await confirmStoryMapAction({
        projectId,
        artifactId: artifact.id,
      });
      setResult(response);
      if (response.ok) {
        adoptArtifact(response.artifact);
        setViewMode("graph");
        setActiveWorldlineId(null);
        setRippleOpen(true);
        router.replace(artifactUrl(response.artifact.id, true), { scroll: false });
      }
    });
  }

  function quickStart(): void {
    setResult(null);
    startTransition(async () => {
      const response = await quickStartRippleAction({
        projectId,
        artifactId: artifact.id,
      });
      setResult(response);
      if (response.ok) {
        adoptArtifact(response.artifact);
        setViewMode("graph");
        setActiveWorldlineId(null);
        setRippleOpen(true);
        router.replace(artifactUrl(response.artifact.id, true), { scroll: false });
      }
    });
  }

  return (
    <section className="review-workspace" aria-label="Story Workspace">
      <div className="review-workspace-toolbar guided-review-toolbar">
        <div>
          <span className="panel-kicker">人工确认 · 不覆盖 AI 原始版本</span>
          <strong>
            Story Map v{artifact.version} · {storyMap.status}
          </strong>
        </div>
        <div className="view-mode-switch" aria-label="Story Map 视图">
          {viewMode === "review" ? (
            <button
              className="secondary-button compact-button"
              onClick={() => setViewMode("graph")}
              type="button"
            >
              查看完整图
            </button>
          ) : (
            <button
              className="secondary-button compact-button"
              onClick={() => setViewMode("review")}
              type="button"
            >
              返回核对队列
            </button>
          )}
        </div>
        <div className="review-confirmation">
          {storyMap.status === "confirmed" ? (
            <>
              <span className="ripple-gate-open">已通过 Ripple 前置确认门</span>
              <span>
                {childWorldlineCount === 0
                  ? "尚未创建子 Worldline"
                  : `已创建 ${childWorldlineCount} 条子 Worldline`}
              </span>
              {activeWorldlines[0] ? (
                <button
                  className="secondary-button compact-button"
                  onClick={() => {
                    setViewMode("graph");
                    enterWorldline(activeWorldlines[0]!.id);
                  }}
                  type="button"
                >
                  继续最近 Worldline
                </button>
              ) : null}
              <button
                className="primary-button compact-button"
                onClick={() => {
                  setViewMode("graph");
                  setActiveWorldlineId(null);
                  setRippleOpen(true);
                }}
                type="button"
              >
                为所选事件创建 Ripple
              </button>
            </>
          ) : (
            <>
              <button
                className="secondary-button compact-button"
                disabled={pending}
                onClick={quickStart}
                type="button"
              >
                {pending ? "正在开始…" : "直接开始涟漪"}
              </button>
              <button
                className="primary-button compact-button"
                disabled={pending || !derivedReview.readiness.readyForRipple}
                onClick={confirm}
                type="button"
              >
                {pending ? "正在保存…" : "确认 Story Map 并进入 Ripple"}
              </button>
            </>
          )}
        </div>
      </div>

      {refinementState.needsRefinement ? (
        <section className="refinement-banner" aria-label="未精修提示">
          <div>
            <strong>未精修 · 可随时进入精修模式</strong>
            <p>
              这份 Story Map 尚未完成必要核对；带“待核对”角标的节点与结局可能影响涟漪质量。
              之后的每一次修正都会创建新的不可变 revision。
            </p>
          </div>
          <button
            className="secondary-button compact-button"
            onClick={() => setViewMode("review")}
            type="button"
          >
            进入精修模式
          </button>
        </section>
      ) : null}

      {storyMap.status === "draft" ? (
        <StoryMapReadiness readiness={derivedReview.readiness} />
      ) : null}

      {result && !result.ok ? (
        <p className="workspace-action-error" role="alert">
          {result.error}
        </p>
      ) : null}

      {viewMode === "review" ? (
        <div className="review-workspace-grid guided-review-grid">
          <StoryMapReviewQueue
            derivedReview={derivedReview}
            onChooseTool={selectTool}
            onSelect={selectQueueItem}
            selectedItemId={
              selection.kind === "queue" ? selection.item.id : null
            }
          />
          <SourceReader
            activeEvidence={selectedEvidence}
            normalizedText={source.normalizedText}
            sections={source.sections}
            selectedEvent={selectedEvent}
            title={source.title}
          />
          <StoryMapReviewEditor
            artifact={artifact}
            evidenceOptions={evidenceOptions}
            normalizedText={source.normalizedText}
            onLocateEvidence={setActiveEvidence}
            onRevise={revise}
            pending={pending}
            selection={selection}
          />
        </div>
      ) : (
        <div className="review-workspace-grid">
          <SourceReader
            activeEvidence={selectedEvidence}
            normalizedText={source.normalizedText}
            sections={source.sections}
            selectedEvent={selectedEvent}
            title={source.title}
          />

          <section className="map-panel">
            <div className="map-toolbar">
              <div>
                <span className="panel-kicker">
                  Story Map · {visibleEvents.length}/{storyMap.events.length} 个事件
                </span>
                <h2>故事因果地图</h2>
              </div>
              <label>
                <span>角色过滤</span>
                <select
                  aria-label="按角色筛选"
                  onChange={(event) => filterByCharacter(event.target.value)}
                  value={characterFilter}
                >
                  <option value="">全部角色</option>
                  {storyMap.characters.map((character) => (
                    <option key={character.id} value={character.id}>
                      {character.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <StoryMapCanvas
              characterId={characterFilter || null}
              needsReviewEdgeIds={refinementState.edgeIds}
              needsReviewEventIds={refinementState.eventIds}
              onSelectEvent={selectEvent}
              uncertainEdgeIds={artifact.review.uncertainEdgeIds}
              selectedEventId={selectedEvent.id}
              storyMap={storyMap}
            />
            <div className="map-footer">
              <span>完整图用于浏览；修正请返回核对队列</span>
              <span>拖动只改变当前视图位置</span>
            </div>
          </section>

          {activeWorldline && activeImpactPlanArtifact ? (
            <WorldlineContinuationPanel
              acceptedImpactPlanArtifact={activeImpactPlanArtifact}
              initialContinuation={activeContinuation!}
              initialBookmarks={initialWorldlineBookmarks.filter(
                (bookmark) => bookmark.worldlineId === activeWorldline.id,
              )}
              initialCharacterStatusOverrides={initialCharacterStatusOverrides.filter(
                (override) => override.worldlineId === activeWorldline.id,
              )}
              autoRootDirections={{
                loading:
                  rootDirectionsState === null ||
                  rootDirectionsState.status === "loading",
                error:
                  rootDirectionsState?.status === "error"
                    ? rootDirectionsState.error
                    : null,
              }}
              key={`${activeWorldline.id}:${rootDirectionsState?.artifact?.id ?? "no-root"}:continuation`}
              onClose={() => setActiveWorldlineId(null)}
              onRetryRootDirections={() => {
                void requestRootDirections(activeWorldline.id);
              }}
              projectId={projectId}
              storyMapArtifact={artifact}
              worldline={activeWorldline}
            />
          ) : rippleOpen ? (
            <RippleSimulatorPanel
              key={`${artifact.id}:${selectedEvent.id}:ripple`}
              artifact={artifact}
              needsReviewEndingIds={refinementState.endingIds}
              onAccepted={(worldline, acceptedArtifact) => {
                setWorldlines((current) => [
                  worldline,
                  ...current.filter((item) => item.id !== worldline.id),
                ]);
                setImpactPlanArtifacts((current) => [
                  acceptedArtifact,
                  ...current.filter((item) => item.id !== acceptedArtifact.id),
                ]);
              }}
              onClose={() => setRippleOpen(false)}
              onEnterWorldline={(worldlineId) => {
                enterWorldline(worldlineId);
              }}
              onRetrySuggestions={() => {
                void requestSuggestions(artifact.id);
              }}
              onRefreshSuggestions={(idempotencyKey) =>
                requestSuggestions(artifact.id, idempotencyKey)
              }
              projectId={projectId}
              selectedEvent={selectedEvent}
              suggestionBatchLimit={rippleSuggestionBatchLimit}
              suggestionBatches={activeSuggestions?.batches ?? []}
              suggestionsError={activeSuggestions?.error ?? null}
              suggestionsLoading={activeSuggestions?.loading ?? false}
            />
          ) : (
            <StoryMapDetails
              key={`${artifact.id}:${selectedEvent.id}`}
              artifact={artifact}
              needsReviewEdgeIds={refinementState.edgeIds}
              needsReviewEventIds={refinementState.eventIds}
              normalizedText={source.normalizedText}
              onLocateEvidence={setActiveEvidence}
              onRevise={revise}
              pending={pending}
              selectedEvent={selectedEvent}
            />
          )}
        </div>
      )}
    </section>
  );
}

function withRootDirections(
  view: ContinuationTreeView,
  artifact: ContinuationDirectionsArtifact | null,
): ContinuationTreeView {
  return artifact ? appendContinuationArtifact(view, artifact) : view;
}

/** 建议批次只追加：同一 id 幂等替换，按 batchIndex 稳定排序。 */
function mergeSuggestionBatch(
  batches: RippleSuggestionsArtifact[],
  next: RippleSuggestionsArtifact,
): RippleSuggestionsArtifact[] {
  const byId = new Map(batches.map((batch) => [batch.id, batch]));
  byId.set(next.id, next);
  return [...byId.values()].sort(
    (left, right) =>
      left.batchIndex - right.batchIndex ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

function selectDefaultReviewItem(
  derivedReview: DerivedStoryMapReview,
): ReviewEditorSelection {
  const item =
    derivedReview.queue.find((candidate) => candidate.status === "pending") ??
    derivedReview.queue.find((candidate) => candidate.status === "advisory");
  return item
    ? { kind: "queue", item }
    : { kind: "tool", tool: "character" };
}

function eventIdForSelection(
  selection: ReviewEditorSelection,
  artifact: StoryMapArtifact,
): string | null {
  if (selection.kind === "event") {
    return artifact.storyMap.events.some(
      (event) => event.id === selection.eventId,
    )
      ? selection.eventId
      : artifact.storyMap.events[0]?.id ?? null;
  }
  if (selection.kind === "tool") return artifact.storyMap.events[0]?.id ?? null;
  const { item } = selection;
  if (item.targetKind === "event") return item.targetId;
  if (item.targetKind === "edge") {
    return (
      artifact.storyMap.edges.find((edge) => edge.id === item.targetId)?.from ??
      null
    );
  }
  if (item.targetKind === "ending") {
    return (
      artifact.storyMap.endingCandidates.find(
        (ending) => ending.id === item.targetId,
      )?.targetEventId ?? null
    );
  }
  return (
    artifact.storyMap.events.find((event) =>
      event.participants.includes(item.targetId),
    )?.id ?? null
  );
}

function evidenceForSelection(
  selection: ReviewEditorSelection,
  artifact: StoryMapArtifact,
): SourceReference | null {
  if (selection.kind === "event") {
    return (
      artifact.storyMap.events.find(
        (event) => event.id === selection.eventId,
      )?.evidence[0] ?? null
    );
  }
  if (selection.kind === "tool") return null;
  const { item } = selection;
  if (item.targetKind === "event") {
    return (
      artifact.storyMap.events.find((event) => event.id === item.targetId)
        ?.evidence[0] ?? null
    );
  }
  if (item.targetKind === "edge") {
    return (
      artifact.storyMap.edges.find((edge) => edge.id === item.targetId)
        ?.evidence[0] ?? null
    );
  }
  if (item.targetKind === "ending") {
    return (
      artifact.storyMap.endingCandidates.find(
        (ending) => ending.id === item.targetId,
      )?.evidence[0] ?? null
    );
  }
  return null;
}
