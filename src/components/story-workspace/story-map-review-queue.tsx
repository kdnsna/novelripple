import type {
  DerivedStoryMapReview,
  StoryMapReviewQueueItem,
} from "@/domain/review/derive-story-map-review";

type StoryMapReviewQueueProps = {
  derivedReview: DerivedStoryMapReview;
  selectedItemId: string | null;
  onSelect: (item: StoryMapReviewQueueItem) => void;
  onChooseTool: (tool: "character" | "add_event" | "reorder" | "add_edge") => void;
};

const categoryLabels: Record<StoryMapReviewQueueItem["category"], string> = {
  inference_event: "推断 Event",
  low_confidence_event: "低置信度 Event",
  low_confidence_edge: "低置信度 Edge",
  alias_rich_character: "多别名人物",
  identity_merge_risk: "Identity 风险",
  ending_candidate: "Ending Candidate",
  high_leverage_divergence: "高杠杆分叉",
  unconfirmed_evidence: "待核 Evidence",
  validator_advisory: "建议核对",
};

export function StoryMapReviewQueue({
  derivedReview,
  selectedItemId,
  onSelect,
  onChooseTool,
}: StoryMapReviewQueueProps) {
  const pending = derivedReview.queue.filter((item) => item.status === "pending");
  const advisory = derivedReview.queue.filter((item) => item.status === "advisory");
  const reviewedCount = derivedReview.queue.filter(
    (item) => item.status === "reviewed",
  ).length;

  return (
    <aside className="workspace-panel review-queue-panel">
      <div className="panel-heading">
        <div>
          <span className="panel-kicker">Guided Review</span>
          <h2>优先核对队列</h2>
        </div>
        <span className="queue-count">{pending.length} 待核</span>
      </div>
      <p className="queue-intro">
        先处理会影响人物身份、因果和结局的项目；系统不使用不可解释总分。
      </p>

      <div className="review-tool-grid" aria-label="Story Map 修正工具">
        <button onClick={() => onChooseTool("character")} type="button">
          人物修正
        </button>
        <button onClick={() => onChooseTool("add_event")} type="button">
          补充 Event
        </button>
        <button onClick={() => onChooseTool("reorder")} type="button">
          调整顺序
        </button>
        <button onClick={() => onChooseTool("add_edge")} type="button">
          新增 Edge
        </button>
      </div>

      <QueueItems
        items={pending}
        onSelect={onSelect}
        selectedItemId={selectedItemId}
      />

      {advisory.length > 0 ? (
        <details className="advisory-queue">
          <summary>{advisory.length} 项分叉建议与软提示</summary>
          <QueueItems
            items={advisory}
            onSelect={onSelect}
            selectedItemId={selectedItemId}
          />
        </details>
      ) : null}

      <p className="reviewed-count">已核对 {reviewedCount} 项</p>
    </aside>
  );
}

function QueueItems({
  items,
  selectedItemId,
  onSelect,
}: {
  items: StoryMapReviewQueueItem[];
  selectedItemId: string | null;
  onSelect: (item: StoryMapReviewQueueItem) => void;
}) {
  if (items.length === 0) {
    return <p className="queue-empty">当前没有待核项目。</p>;
  }
  return (
    <div className="review-queue-list">
      {items.map((item) => (
        <button
          className={item.id === selectedItemId ? "active" : ""}
          data-testid={`review-queue-item-${item.id}`}
          key={item.id}
          onClick={() => onSelect(item)}
          type="button"
        >
          <span>{categoryLabels[item.category]}</span>
          <strong>{item.title}</strong>
          <small>{item.reason}</small>
        </button>
      ))}
    </div>
  );
}
