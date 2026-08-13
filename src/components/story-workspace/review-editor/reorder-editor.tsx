"use client";

import { useMemo, useState } from "react";

import type {
  StoryMapArtifact,
  StoryMapRevisionChange,
} from "@/domain/schemas";

type ReorderEditorProps = {
  artifact: StoryMapArtifact;
  onRevise: (change: StoryMapRevisionChange) => void;
  pending: boolean;
};

/**
 * 顺序调整在本地缓冲，只在用户明确保存时创建一次 revision，
 * 避免每次上/下移都写一条不可变 revision。
 */
export function ReorderEditor({
  artifact,
  onRevise,
  pending,
}: ReorderEditorProps) {
  const ordered = useMemo(
    () =>
      [...artifact.storyMap.events].sort(
        (left, right) => left.sequence - right.sequence,
      ),
    [artifact.storyMap.events],
  );
  const originalIds = useMemo(() => ordered.map((event) => event.id), [ordered]);
  const [orderIds, setOrderIds] = useState<string[]>(originalIds);
  const [feedback, setFeedback] = useState<string | null>(null);

  // artifact 更新（保存 revision 或外部导航）后重新同步顺序基线；
  // 使用“渲染期状态调整”模式避免在 effect 内 setState。
  const [syncedKey, setSyncedKey] = useState(originalIds.join(":"));
  if (syncedKey !== originalIds.join(":")) {
    setSyncedKey(originalIds.join(":"));
    setOrderIds(originalIds);
    setFeedback(null);
  }

  const dirty =
    orderIds.length !== originalIds.length ||
    orderIds.some((id, index) => id !== originalIds[index]);
  const eventsById = useMemo(
    () => new Map(ordered.map((event) => [event.id, event])),
    [ordered],
  );

  function move(index: number, direction: -1 | 1): void {
    const target = index + direction;
    if (target < 0 || target >= orderIds.length) return;
    setOrderIds((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  function save(): void {
    if (!dirty) return;
    onRevise({ type: "reorder_events", eventIds: orderIds });
  }

  function cancel(): void {
    setOrderIds(originalIds);
    setFeedback("顺序调整已取消，没有创建 revision。");
  }

  return (
    <aside className="workspace-panel review-editor-panel">
      <div className="panel-heading">
        <div>
          <span className="panel-kicker">Chronology</span>
          <h2>调整 Event 顺序</h2>
        </div>
        <span className="queue-count">{dirty ? "未保存" : "无改动"}</span>
      </div>
      <ol className="event-reorder-list">
        {orderIds.map((eventId, index) => {
          const event = eventsById.get(eventId);
          if (!event) return null;
          return (
            <li key={event.id}>
              <span>{index + 1}</span>
              <strong>{event.title}</strong>
              <button
                aria-label={`上移 ${event.title}`}
                disabled={pending || index === 0}
                onClick={() => move(index, -1)}
                type="button"
              >
                ↑
              </button>
              <button
                aria-label={`下移 ${event.title}`}
                disabled={pending || index === orderIds.length - 1}
                onClick={() => move(index, 1)}
                type="button"
              >
                ↓
              </button>
            </li>
          );
        })}
      </ol>
      {feedback ? (
        <p className="workspace-action-error" role="status">
          {feedback}
        </p>
      ) : null}
      <div className="correction-actions">
        <button
          className="secondary-button"
          disabled={pending || !dirty}
          onClick={cancel}
          type="button"
        >
          取消调整
        </button>
        <button
          className="primary-button"
          disabled={pending || !dirty}
          onClick={save}
          type="button"
        >
          {pending ? "正在保存…" : "保存顺序 revision"}
        </button>
      </div>
    </aside>
  );
}
