"use client";

import type { StoryMapReviewQueueItem } from "@/domain/review/derive-story-map-review";
import type {
  StoryMapArtifact,
  StoryMapRevisionChange,
  SourceReference,
} from "@/domain/schemas";
import type { EvidencePickerOption } from "@/components/story-workspace/evidence-unit-picker";

import { CharacterEditor } from "./character-editor";
import { EdgeEditor, AddEdgeEditor } from "./edge-editor";
import { EventEditor, AddEventEditor } from "./event-editor";
import { EndingEditor } from "./ending-editor";
import { ReorderEditor } from "./reorder-editor";

export type ReviewEditorSelection =
  | { kind: "queue"; item: StoryMapReviewQueueItem }
  | { kind: "event"; eventId: string }
  | {
      kind: "tool";
      tool: "character" | "add_event" | "reorder" | "add_edge";
    };

type StoryMapReviewEditorProps = {
  artifact: StoryMapArtifact;
  evidenceOptions: EvidencePickerOption[];
  normalizedText: string;
  onLocateEvidence: (evidence: SourceReference) => void;
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
  selection: ReviewEditorSelection;
};

export function StoryMapReviewEditor({
  artifact,
  evidenceOptions,
  normalizedText,
  onLocateEvidence,
  onRevise,
  pending,
  selection,
}: StoryMapReviewEditorProps) {
  if (selection.kind === "event") {
    return (
      <EventEditor
        artifact={artifact}
        eventId={selection.eventId}
        normalizedText={normalizedText}
        onLocateEvidence={onLocateEvidence}
        onRevise={onRevise}
        pending={pending}
      />
    );
  }

  if (selection.kind === "tool") {
    if (selection.tool === "character") {
      return (
        <CharacterEditor
          artifact={artifact}
          characterIds={artifact.storyMap.characters.map(
            (character) => character.id,
          )}
          onRevise={onRevise}
          pending={pending}
          showMerge
        />
      );
    }
    if (selection.tool === "add_event") {
      return (
        <AddEventEditor
          artifact={artifact}
          evidenceOptions={evidenceOptions}
          onRevise={onRevise}
          pending={pending}
        />
      );
    }
    if (selection.tool === "reorder") {
      return <ReorderEditor artifact={artifact} onRevise={onRevise} pending={pending} />;
    }
    return (
      <AddEdgeEditor
        artifact={artifact}
        evidenceOptions={evidenceOptions}
        onRevise={onRevise}
        pending={pending}
      />
    );
  }

  const { item } = selection;
  if (item.targetKind === "character") {
    return (
      <CharacterEditor
        artifact={artifact}
        characterIds={[item.targetId, ...item.relatedTargetIds]}
        onRevise={onRevise}
        pending={pending}
        showMerge={item.category === "identity_merge_risk"}
      />
    );
  }
  if (item.targetKind === "ending") {
    return (
      <EndingEditor
        artifact={artifact}
        endingId={item.targetId}
        onLocateEvidence={onLocateEvidence}
        onRevise={onRevise}
        pending={pending}
      />
    );
  }
  if (item.targetKind === "edge") {
    return (
      <EdgeEditor
        artifact={artifact}
        edgeId={item.targetId}
        evidenceOptions={evidenceOptions}
        normalizedText={normalizedText}
        onLocateEvidence={onLocateEvidence}
        onRevise={onRevise}
        pending={pending}
      />
    );
  }
  return (
    <EventEditor
      artifact={artifact}
      eventId={item.targetId}
      normalizedText={normalizedText}
      onLocateEvidence={onLocateEvidence}
      onRevise={onRevise}
      pending={pending}
    />
  );
}
