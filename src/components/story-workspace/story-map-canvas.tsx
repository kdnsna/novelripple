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
import { Graph, layout } from "@dagrejs/dagre";
import { useEffect, useMemo, useState } from "react";

import type { Event, StoryMap } from "@/domain/schemas";

type StoryMapCanvasProps = {
  storyMap: StoryMap;
  selectedEventId: string;
  onSelectEvent: (event: Event) => void;
  characterId?: string | null;
};

const nodeWidth = 184;
const nodeHeight = 108;

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
  characterId = null,
}: StoryMapCanvasProps) {
  const [lastDraggedNodeId, setLastDraggedNodeId] = useState("");
  const visibleEvents = useMemo(
    () =>
      characterId
        ? storyMap.events.filter((event) =>
            event.participants.includes(characterId),
          )
        : storyMap.events,
    [characterId, storyMap.events],
  );
  const visibleEventIds = useMemo(
    () => new Set(visibleEvents.map((event) => event.id)),
    [visibleEvents],
  );
  const visibleStoryEdges = useMemo(
    () =>
      storyMap.edges.filter(
        (edge) =>
          visibleEventIds.has(edge.from) && visibleEventIds.has(edge.to),
      ),
    [storyMap.edges, visibleEventIds],
  );
  const computedNodes = useMemo<Node[]>(() => {
    const graph = new Graph({ multigraph: true })
      .setDefaultEdgeLabel(() => ({}))
      .setGraph({
        rankdir: "LR",
        ranksep: 76,
        nodesep: 42,
        edgesep: 22,
        marginx: 24,
        marginy: 24,
      });
    visibleEvents.forEach((event) =>
      graph.setNode(event.id, { width: nodeWidth, height: nodeHeight }),
    );
    visibleStoryEdges.forEach((edge) =>
      graph.setEdge(edge.from, edge.to, {}, edge.id),
    );
    layout(graph);

    return visibleEvents.map((event) => {
      const position = graph.node(event.id) as { x: number; y: number };
      return {
        id: event.id,
        position: {
          x: position.x - nodeWidth / 2,
          y: position.y - nodeHeight / 2,
        },
        initialWidth: nodeWidth,
        initialHeight: nodeHeight,
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
            </div>
          ),
        },
        draggable: true,
        selectable: true,
        className: "story-map-node",
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      };
    });
  }, [visibleEvents, visibleStoryEdges]);
  const [nodes, setNodes, onNodesChange] = useNodesState(computedNodes);

  useEffect(() => {
    setNodes(computedNodes);
  }, [computedNodes, setNodes]);

  useEffect(() => {
    setNodes((currentNodes) =>
      currentNodes.map((node) => ({
        ...node,
        selected: node.id === selectedEventId,
      })),
    );
  }, [selectedEventId, setNodes]);

  const computedEdges = useMemo<Edge[]>(
    () =>
      visibleStoryEdges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        type: "smoothstep",
        animated: edge.from === selectedEventId,
        label:
          edge.type === "causes"
            ? "导致"
            : edge.type === "enables"
              ? "使能"
              : "伏笔",
        style: {
          stroke: edgeColors[edge.type],
          strokeWidth: edge.from === selectedEventId ? 2.4 : 1.25,
          opacity: edge.from === selectedEventId ? 1 : 0.56,
        },
        labelStyle: { fill: "var(--ink-soft)", fontSize: 11, fontWeight: 700 },
        labelBgStyle: { fill: "var(--paper)", fillOpacity: 0.94 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: edgeColors[edge.type],
          width: 14,
          height: 14,
        },
      })),
    [selectedEventId, visibleStoryEdges],
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(computedEdges);
  const nodeIds = useMemo(
    () => visibleEvents.map((event) => event.id),
    [visibleEvents],
  );

  useEffect(() => {
    setEdges(computedEdges);
  }, [computedEdges, setEdges]);

  return (
    <div
      aria-label="故事地图"
      className="story-map-canvas"
      data-edge-count={edges.length}
      data-last-dragged-node={lastDraggedNodeId}
      data-node-count={nodes.length}
    >
      <ReactFlow
        colorMode="light"
        defaultEdgeOptions={{ selectable: false }}
        edges={edges}
        fitViewOptions={{ padding: 0.18, minZoom: 0.52, maxZoom: 1 }}
        maxZoom={1.35}
        minZoom={0.35}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => {
          const event = storyMap.events.find((item) => item.id === node.id);
          if (event) onSelectEvent(event);
        }}
        onNodeDragStop={(_, node) => setLastDraggedNodeId(node.id)}
        onNodesChange={onNodesChange}
        panOnScroll
        proOptions={{ hideAttribution: true }}
      >
        <GraphInitializer nodeIds={nodeIds} />
        <Background color="var(--line)" gap={24} size={1} />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
