import {
  isEdgeEvidenceConfirmed,
  isEdgeMarkedUncertain,
  isLowConfidenceEdge,
} from "@/domain/review/derive-story-map-review";
import type { StoryEdge, StoryMapArtifact } from "@/domain/schemas";

/**
 * “不确定”因果关系的两种来源：
 * - `marked_uncertain`：读者显式标记（`review.uncertainEdgeIds`）；
 * - `unreviewed_low_confidence`：低于现有阈值，且 Evidence 尚未人工确认。
 *
 * 规则本身复用 `derive-story-map-review` 的常量与 helper，避免和 readiness
 * 各维护一套阈值。
 */
export type UncertainEdgeReason =
  | "marked_uncertain"
  | "unreviewed_low_confidence";

export type UncertainCausalEdge = {
  edge: StoryEdge;
  reason: UncertainEdgeReason;
};

export type CausalEdgeClassification = {
  established: StoryEdge[];
  uncertain: UncertainCausalEdge[];
};

export function classifyStoryMapEdges(
  artifact: StoryMapArtifact,
): CausalEdgeClassification {
  const established: StoryEdge[] = [];
  const uncertain: UncertainCausalEdge[] = [];

  for (const edge of artifact.storyMap.edges) {
    if (isEdgeMarkedUncertain(artifact, edge.id)) {
      uncertain.push({ edge, reason: "marked_uncertain" });
      continue;
    }
    if (
      isLowConfidenceEdge(edge) &&
      !isEdgeEvidenceConfirmed(artifact, edge)
    ) {
      uncertain.push({ edge, reason: "unreviewed_low_confidence" });
      continue;
    }
    established.push(edge);
  }

  // 输入按 Story Map 边顺序遍历，输出顺序因此是确定性的。
  return { established, uncertain };
}
