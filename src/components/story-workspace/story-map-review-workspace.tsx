"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import {
  confirmStoryMapAction,
  reviseStoryMapAction,
  type StoryMapActionResult,
} from "@/app/projects/actions";
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
import { WorldlineContinuationPanel } from "./worldline-continuation-panel";

type StoryMapReviewWorkspaceProps = {
  projectId: string;
  source: Source;
  artifact: StoryMapArtifact;
  initialWorldlines: Worldline[];
  initialImpactPlanArtifacts: ImpactPlanArtifact[];
  initialContinuationArtifacts: ContinuationArtifact[];
};

export function StoryMapReviewWorkspace({
  projectId,
  source,
  artifact,
  initialWorldlines,
  initialImpactPlanArtifacts,
  initialContinuationArtifacts,
}: StoryMapReviewWorkspaceProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const storyMap = artifact.storyMap;
  const [selectedEventId, setSelectedEventId] = useState(storyMap.events[0].id);
  const [characterFilter, setCharacterFilter] = useState("");
  const [activeEvidence, setActiveEvidence] = useState<SourceReference | null>(
    storyMap.events[0].evidence[0] ?? null,
  );
  const [result, setResult] = useState<StoryMapActionResult | null>(null);
  const [rippleOpen, setRippleOpen] = useState(false);
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

  function selectEvent(event: Event): void {
    setSelectedEventId(event.id);
    setActiveEvidence(event.evidence[0] ?? null);
    setResult(null);
    setActiveWorldlineId(null);
    setRippleOpen(false);
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

  function openArtifact(artifactId: string): void {
    const query = new URLSearchParams(searchParams.toString());
    query.set("source", source.id);
    query.set("artifact", artifactId);
    query.delete("generated");
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
      if (response.ok) openArtifact(response.artifactId);
    });
  }

  return (
    <section className="review-workspace" aria-label="Story Workspace">
      <div className="review-workspace-toolbar">
        <div>
          <span className="panel-kicker">人工确认 · 不覆盖 AI 原始版本</span>
          <strong>
            Story Map v{artifact.version} · {storyMap.status}
          </strong>
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
        <div className="review-confirmation">
          {storyMap.status === "confirmed" ? (
            <>
              <span className="ripple-gate-open">
                已通过 Ripple 前置确认门
              </span>
              <span>
                {childWorldlineCount === 0
                  ? "尚未创建子 Worldline"
                  : `已创建 ${childWorldlineCount} 条子 Worldline`}
              </span>
              {activeWorldlines[0] ? (
                <button
                  className="secondary-button compact-button"
                  onClick={() => {
                    setRippleOpen(false);
                    setActiveWorldlineId(activeWorldlines[0]!.id);
                  }}
                  type="button"
                >
                  继续最近 Worldline
                </button>
              ) : null}
            </>
          ) : (
            <span>确认前不能进入 Ripple</span>
          )}
          <button
            className="primary-button compact-button"
            disabled={pending || storyMap.status === "confirmed"}
            onClick={confirm}
            type="button"
          >
            {pending ? "正在保存…" : "确认 Story Map"}
          </button>
          {storyMap.status === "confirmed" ? (
            <button
              className="primary-button compact-button"
              onClick={() => {
                setActiveWorldlineId(null);
                setRippleOpen(true);
              }}
              type="button"
            >
              为所选事件创建 Ripple
            </button>
          ) : null}
        </div>
      </div>

      {result && !result.ok ? (
        <p className="workspace-action-error" role="alert">
          {result.error}
        </p>
      ) : null}

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
            <div className="edge-legend" aria-label="边类型图例">
              <span className="legend-causes">导致</span>
              <span className="legend-enables">使能</span>
              <span className="legend-foreshadows">伏笔</span>
            </div>
          </div>
          <StoryMapCanvas
            characterId={characterFilter || null}
            onSelectEvent={selectEvent}
            selectedEventId={selectedEvent.id}
            storyMap={storyMap}
          />
          <div className="map-footer">
            <span>点击事件查看详情和原文 Evidence</span>
            <span>拖动只改变当前视图位置</span>
          </div>
        </section>

        {activeWorldline && activeImpactPlanArtifact ? (
          <WorldlineContinuationPanel
            acceptedImpactPlanArtifact={activeImpactPlanArtifact}
            initialArtifacts={initialContinuationArtifacts.filter(
              (continuation) =>
                continuation.worldlineId === activeWorldline.id,
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
    </section>
  );
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
