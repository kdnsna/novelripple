"use client";

import {
  Background,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useUpdateNodeInternals,
} from "@xyflow/react";
import { useEffect, useMemo } from "react";

import type { StoryEvent, StoryMap } from "@/domain/schemas";

type StoryMapCanvasProps = {
  storyMap: StoryMap;
  selectedEventId: string;
  onSelectEvent: (event: StoryEvent) => void;
};

const edgeColors = {
  causes: "#c95d3e",
  enables: "#58766e",
  foreshadows: "#9a7b55",
} as const;

function GraphInitializer({ nodeIds }: { nodeIds: string[] }) {
  const updateNodeInternals = useUpdateNodeInternals();
  const { fitView } = useReactFlow();

  useEffect(() => {
    let fitFrame = 0;
    const measureFrame = window.requestAnimationFrame(() => {
      updateNodeInternals(nodeIds);
      fitFrame = window.requestAnimationFrame(() => {
        void fitView({ padding: 0.18, minZoom: 0.35, maxZoom: 0.9 });
      });
    });

    return () => {
      window.cancelAnimationFrame(measureFrame);
      if (fitFrame) window.cancelAnimationFrame(fitFrame);
    };
  }, [fitView, nodeIds, updateNodeInternals]);

  return null;
}

export function StoryMapCanvas({
  storyMap,
  selectedEventId,
  onSelectEvent,
}: StoryMapCanvasProps) {
  const computedNodes = useMemo<Node[]>(
    () =>
      storyMap.events.map((event) => {
        const column = (event.sequence - 1) % 4;
        const row = Math.floor((event.sequence - 1) / 4);
        const isSelected = event.id === selectedEventId;
        const isDivergence = event.id === "event_07";

        return {
          id: event.id,
          position: { x: column * 248, y: row * 184 },
          initialWidth: 184,
          initialHeight: 108,
          data: {
            label: (
              <div
                className="map-node-content"
                data-testid={`event-node-${event.id}`}
              >
                <div className="map-node-kicker">
                  <span>{String(event.sequence).padStart(2, "0")}</span>
                  <span>{event.evidenceKind === "inference" ? "推断" : "事实"}</span>
                </div>
                <strong>{event.title}</strong>
                <small>{event.participants.length} 位人物 · 可追溯</small>
                {isDivergence ? <em>推荐分歧点</em> : null}
              </div>
            ),
          },
          draggable: false,
          selectable: true,
          className: [
            "story-map-node",
            isSelected ? "story-map-node-selected" : "",
            isDivergence ? "story-map-node-divergence" : "",
          ]
            .filter(Boolean)
            .join(" "),
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
        };
      }),
    [selectedEventId, storyMap.events],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(computedNodes);

  useEffect(() => {
    setNodes((currentNodes) =>
      computedNodes.map((nextNode) => {
        const currentNode = currentNodes.find((item) => item.id === nextNode.id);
        return {
          ...nextNode,
          measured: currentNode?.measured,
          width: currentNode?.width,
          height: currentNode?.height,
        };
      }),
    );
  }, [computedNodes, setNodes]);

  const computedEdges = useMemo<Edge[]>(
    () =>
      storyMap.edges.map((edge) => ({
        id: edge.id,
        source: edge.sourceEventId,
        target: edge.targetEventId,
        type: "smoothstep",
        animated: edge.sourceEventId === selectedEventId,
        label:
          edge.type === "causes"
            ? "导致"
            : edge.type === "enables"
              ? "使能"
              : "伏笔",
        style: {
          stroke: edgeColors[edge.type],
          strokeWidth: edge.sourceEventId === selectedEventId ? 2.4 : 1.25,
          opacity: edge.sourceEventId === selectedEventId ? 1 : 0.56,
        },
        labelStyle: { fill: "#776e63", fontSize: 9, fontWeight: 700 },
        labelBgStyle: { fill: "#f3efe7", fillOpacity: 0.94 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: edgeColors[edge.type],
          width: 14,
          height: 14,
        },
      })),
    [selectedEventId, storyMap.edges],
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(computedEdges);
  const nodeIds = useMemo(
    () => storyMap.events.map((event) => event.id),
    [storyMap.events],
  );

  useEffect(() => {
    setEdges(computedEdges);
  }, [computedEdges, setEdges]);

  return (
    <div
      aria-label="故事地图"
      className="story-map-canvas"
      data-edge-count={edges.length}
      data-node-count={nodes.length}
    >
      <ReactFlow
        colorMode="light"
        defaultEdgeOptions={{ selectable: false }}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.18, minZoom: 0.52, maxZoom: 1 }}
        maxZoom={1.35}
        minZoom={0.35}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable={false}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => {
          const event = storyMap.events.find((item) => item.id === node.id);
          if (event) onSelectEvent(event);
        }}
        onNodesChange={onNodesChange}
        panOnScroll
        proOptions={{ hideAttribution: true }}
      >
        <GraphInitializer nodeIds={nodeIds} />
        <Background color="#d8d0c3" gap={24} size={1} />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
