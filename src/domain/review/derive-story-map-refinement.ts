import type {
  DerivedStoryMapReview,
  StoryMapReviewQueueItem,
} from "@/domain/review/derive-story-map-review";
import type { StoryMapArtifact } from "@/domain/schemas";

export type StoryMapRefinementState = {
  /** 当前 confirmed revision 是通过“直接开始涟漪”确认的。 */
  quickConfirmed: boolean;
  /**
   * confirmed 但 readiness 尚未满足：界面显示“未精修”。正常确认要求 readiness，
   * 所以这只会来自快速开始；不依赖最新 operation type，后续 revision 也不会丢失该提示。
   */
  needsRefinement: boolean;
  /** 需要人工核对的 Event / Edge / Ending 项目，沿用 review queue 的顺序。 */
  pendingItems: StoryMapReviewQueueItem[];
  eventIds: string[];
  edgeIds: string[];
  endingIds: string[];
};

/**
 * “未精修”与待核对角标都是 deriveStoryMapReview 的纯派生视图：
 * 不引入第二套置信度、分数或持久化状态。待核对目标只取 pending 队列中
 * 指向 Event / Edge / Ending Candidate 的项目，character 由精修队列单独呈现。
 */
export function deriveStoryMapRefinementState(
  artifact: StoryMapArtifact,
  derivedReview: DerivedStoryMapReview,
): StoryMapRefinementState {
  const quickConfirmed =
    artifact.storyMap.status === "confirmed" &&
    artifact.review.operation?.type === "quick_confirm_story_map";
  const pendingItems = derivedReview.queue.filter(
    (item) => item.status === "pending" && item.targetKind !== "character",
  );

  return {
    quickConfirmed,
    needsRefinement:
      artifact.storyMap.status === "confirmed" &&
      !derivedReview.readiness.readyForRipple,
    pendingItems,
    eventIds: uniqueSorted(
      pendingItems
        .filter((item) => item.targetKind === "event")
        .map((item) => item.targetId),
    ),
    edgeIds: uniqueSorted(
      pendingItems
        .filter((item) => item.targetKind === "edge")
        .map((item) => item.targetId),
    ),
    endingIds: uniqueSorted(
      pendingItems
        .filter((item) => item.targetKind === "ending")
        .map((item) => item.targetId),
    ),
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
