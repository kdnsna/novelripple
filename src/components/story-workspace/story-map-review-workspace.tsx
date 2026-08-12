"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import {
  confirmStoryMapAction,
  reviseStoryMapAction,
  type StoryMapActionResult,
} from "@/app/projects/actions";
import type { EvidencePickerOption } from "@/components/story-workspace/evidence-unit-picker";
import type {
  DerivedStoryMapReview,
  StoryMapReviewQueueItem,
} from "@/domain/review/derive-story-map-review";
import type {
  ContinuationArtifact,
  Event,
  ImpactPlanArtifact,
  Source,
  SourceReference,
  StoryMapArtifact,
  StoryMapRevisionChange,
  Worldline,
} from "@/domain/schemas";
import { RippleSimulatorPanel } from "./ripple-simulator-panel";
import { SourceReader } from "./source-reader";
import { StoryMapCanvas } from "./story-map-canvas";
import { StoryMapDetails } from "./story-map-details";
import { StoryMapReadiness } from "./story-map-readiness";
import {
  StoryMapReviewEditor,
  type ReviewEditorSelection,
} from "./story-map-review-editor";
import { StoryMapReviewQueue } from "./story-map-review-queue";
import { WorldlineContinuationPanel } from "./worldline-continuation-panel";

type StoryMapReviewWorkspaceProps = {
  projectId: string;
  source: Source;
  artifact: StoryMapArtifact;
  derivedReview: DerivedStoryMapReview;
  evidenceOptions: EvidencePickerOption[];
  initialWorldlines: Worldline[];
  initialImpactPlanArtifacts: ImpactPlanArtifact[];
  initialContinuationArtifacts: ContinuationArtifact[];
};

export function StoryMapReviewWorkspace({
  projectId,
  source,
  artifact,
  derivedReview,
  evidenceOptions,
  initialWorldlines,
  initialImpactPlanArtifacts,
  initialContinuationArtifacts,
}: StoryMapReviewWorkspaceProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const storyMap = artifact.storyMap;
  const defaultSelection = selectDefaultReviewItem(derivedReview);
  const [selection, setSelection] = useState<ReviewEditorSelection>(defaultSelection);
  const [viewMode, setViewMode] = useState<"review" | "graph">(
    searchParams.get("ripple") === "opened" ? "graph" : "review",
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
    storyMap.status === "confirmed" && searchParams.get("ripple") === "opened",
  );
  const [worldlines, setWorldlines] = useState(initialWorldlines);
  const [impactPlanArtifacts, setImpactPlanArtifacts] = useState(
    initialImpactPlanArtifacts,
  );
  const [activeWorldlineId, setActiveWorldlineId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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
  const selectedEvidence = selectedEvent.evidence.some(
    (evidence) => evidenceKey(evidence) === evidenceKey(activeEvidence),
  )
    ? activeEvidence
    : activeEvidence ?? selectedEvent.evidence[0] ?? null;
  const activeWorldlines = worldlines.filter(
    (worldline) => worldline.status === "active",
  );
  const activeWorldline = activeWorldlines.find(
    (worldline) => worldline.id === activeWorldlineId,
  );
  const activeImpactPlanArtifact = activeWorldline?.acceptedImpactPlanId
    ? impactPlanArtifacts.find(
        (impactPlan) => impactPlan.id === activeWorldline.acceptedImpactPlanId,
      )
    : null;

  function selectEvent(event: Event): void {
    setSelectedEventId(event.id);
    setActiveEvidence(event.evidence[0] ?? null);
    setSelection({
      kind: "queue",
      item: {
        id: `graph_event:${event.id}`,
        category: "validator_advisory",
        priority: 8,
        targetKind: "event",
        targetId: event.id,
        relatedTargetIds: [],
        title: event.title,
        reason: "从完整图打开的 Event。",
        status: "advisory",
      },
    });
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
      ? storyMap.events.filter((event) => event.participants.includes(characterId))
      : storyMap.events;
    const nextEvent =
      filteredEvents.find((event) => event.id === selectedEventId) ??
      filteredEvents[0];
    if (!nextEvent) return;
    setSelectedEventId(nextEvent.id);
    setActiveEvidence(nextEvent.evidence[0] ?? null);
  }

  function openArtifact(artifactId: string, openRipple = false): void {
    const query = new URLSearchParams(searchParams.toString());
    query.set("source", source.id);
    query.set("artifact", artifactId);
    query.delete("generated");
    if (openRipple) query.set("ripple", "opened");
    else query.delete("ripple");
    router.replace(`${pathname}?${query}`);
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
      if (response.ok) openArtifact(response.artifactId);
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
      if (response.ok) openArtifact(response.artifactId, true);
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
            <button
              className="primary-button compact-button"
              disabled={pending || !derivedReview.readiness.readyForRipple}
              onClick={confirm}
              type="button"
            >
              {pending ? "正在保存…" : "确认 Story Map 并进入 Ripple"}
            </button>
          )}
        </div>
      </div>

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
              onSelectEvent={selectEvent}
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
              initialArtifacts={initialContinuationArtifacts.filter(
                (continuation) => continuation.worldlineId === activeWorldline.id,
              )}
              key={`${activeWorldline.id}:continuation`}
              onClose={() => setActiveWorldlineId(null)}
              projectId={projectId}
              storyMapArtifact={artifact}
              worldline={activeWorldline}
            />
          ) : rippleOpen ? (
            <RippleSimulatorPanel
              key={`${artifact.id}:${selectedEvent.id}:ripple`}
              artifact={artifact}
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
                setRippleOpen(false);
                setActiveWorldlineId(worldlineId);
              }}
              projectId={projectId}
              selectedEvent={selectedEvent}
            />
          ) : (
            <StoryMapDetails
              key={`${artifact.id}:${selectedEvent.id}`}
              artifact={artifact}
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
  if (selection.kind === "tool") return artifact.storyMap.events[0]?.id ?? null;
  const { item } = selection;
  if (item.targetKind === "event") return item.targetId;
  if (item.targetKind === "edge") {
    return artifact.storyMap.edges.find((edge) => edge.id === item.targetId)?.from ?? null;
  }
  if (item.targetKind === "ending") {
    return artifact.storyMap.endingCandidates.find(
      (ending) => ending.id === item.targetId,
    )?.targetEventId ?? null;
  }
  return artifact.storyMap.events.find((event) =>
    event.participants.includes(item.targetId),
  )?.id ?? null;
}

function evidenceForSelection(
  selection: ReviewEditorSelection,
  artifact: StoryMapArtifact,
): SourceReference | null {
  if (selection.kind === "tool") return null;
  const { item } = selection;
  if (item.targetKind === "event") {
    return artifact.storyMap.events.find((event) => event.id === item.targetId)
      ?.evidence[0] ?? null;
  }
  if (item.targetKind === "edge") {
    return artifact.storyMap.edges.find((edge) => edge.id === item.targetId)
      ?.evidence[0] ?? null;
  }
  if (item.targetKind === "ending") {
    return artifact.storyMap.endingCandidates.find(
      (ending) => ending.id === item.targetId,
    )?.evidence[0] ?? null;
  }
  return null;
}

function evidenceKey(evidence: SourceReference | null): string {
  if (!evidence) return "";
  return [
    evidence.sourceId,
    evidence.sectionId,
    evidence.start,
    evidence.end,
    evidence.excerptHash,
  ].join(":");
}
