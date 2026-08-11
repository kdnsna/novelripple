"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import type {
  ImpactPlan,
  SourceSection,
  StoryEvent,
  StoryMap,
  Worldline,
} from "@/domain/schemas";
import { RipplePanel } from "./ripple-panel";
import { SourceReader } from "./source-reader";
import { StoryMapCanvas } from "./story-map-canvas";

type StoryWorkspaceProps = {
  source: {
    title: string;
    normalizedText: string;
    sections: SourceSection[];
  };
  storyMap: StoryMap;
  impactPlans: ImpactPlan[];
  initialWorldlines: Worldline[];
};

export function StoryWorkspace({
  source,
  storyMap,
  impactPlans,
  initialWorldlines,
}: StoryWorkspaceProps) {
  const benchmarkEvent = storyMap.events.find((event) => event.id === "event_07");
  const characterNames = useMemo(
    () =>
      Object.fromEntries(
        storyMap.characters.map((character) => [character.id, character.name]),
      ),
    [storyMap.characters],
  );
  const [selectedEventId, setSelectedEventId] = useState(
    benchmarkEvent?.id ?? storyMap.events[0].id,
  );
  const [selectedPlanId, setSelectedPlanId] = useState(impactPlans[0].id);
  const selectedEvent = useMemo<StoryEvent>(
    () =>
      storyMap.events.find((event) => event.id === selectedEventId) ??
      storyMap.events[0],
    [selectedEventId, storyMap.events],
  );

  return (
    <main className="workspace-shell">
      <header className="workspace-header">
        <Link className="brand-lockup compact-brand" href="/">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <span>
            <strong>NovelRipple</strong>
            <small>故事涟漪</small>
          </span>
        </Link>

        <div className="project-title">
          <span>基准故事 / ripple-001</span>
          <h1>《{storyMap.title}》</h1>
        </div>

        <div className="header-actions">
          <span className="confirmed-map-badge">
            <i /> Story Map v{storyMap.version} 已确认
          </span>
          <Link className="quiet-link" href="/">
            退出体验
          </Link>
        </div>
      </header>

      <div className="journey-strip" aria-label="First Ripple 进度">
        <span className="journey-complete">01 导入作品</span>
        <i />
        <span className="journey-complete">02 确认地图</span>
        <i />
        <span className="journey-current">03 改变节点</span>
        <i />
        <span>04 预览涟漪</span>
        <i />
        <span>05 创建世界线</span>
      </div>

      <div className="workspace-grid">
        <SourceReader
          normalizedText={source.normalizedText}
          sections={source.sections}
          selectedEvent={selectedEvent}
          title={source.title}
        />

        <section className="map-panel">
          <div className="map-toolbar">
            <div>
              <span className="panel-kicker">Story Map · {storyMap.events.length} 个事件</span>
              <h2>故事因果地图</h2>
            </div>
            <div className="edge-legend" aria-label="边类型图例">
              <span className="legend-causes">导致</span>
              <span className="legend-enables">使能</span>
              <span className="legend-foreshadows">伏笔</span>
            </div>
          </div>
          <StoryMapCanvas
            onSelectEvent={(event) => setSelectedEventId(event.id)}
            selectedEventId={selectedEvent.id}
            storyMap={storyMap}
          />
          <div className="map-footer">
            <span>点击事件查看原文证据</span>
            <span>节点位置仅用于阅读，不改变剧情语义</span>
          </div>
        </section>

        <RipplePanel
          characterNames={characterNames}
          impactPlans={impactPlans}
          initialWorldlines={initialWorldlines}
          onSelectBenchmarkEvent={() => {
            if (benchmarkEvent) setSelectedEventId(benchmarkEvent.id);
          }}
          onSelectPlan={setSelectedPlanId}
          selectedEvent={selectedEvent}
          selectedPlanId={selectedPlanId}
        />
      </div>
    </main>
  );
}
