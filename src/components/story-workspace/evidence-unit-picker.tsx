"use client";

import { useId, useMemo, useState } from "react";

import {
  sourceReferenceKey,
  type SourceReference,
  type StoryMapArtifact,
} from "@/domain/schemas";
import {
  rankEvidenceForEdge,
  rankEvidenceForEvent,
  type RankedEvidenceCandidate,
} from "@/domain/review/rank-evidence-units";

export type EvidencePickerOption = {
  id: string;
  sectionId: string;
  sectionTitle: string;
  start: number;
  end: number;
  text: string;
  reference: SourceReference;
};

export type EvidencePickerRanking =
  | { kind: "edge"; fromEventId: string; toEventId: string }
  | { kind: "event"; eventId: string };

type EvidenceUnitPickerProps = {
  options: EvidencePickerOption[];
  selected: SourceReference | null;
  onSelect: (reference: SourceReference) => void;
  /** 提供 Story Map 上下文后启用确定性排序；缺省时保持原文顺序。 */
  artifact?: StoryMapArtifact;
  ranking?: EvidencePickerRanking;
};

const DEFAULT_VISIBLE_CANDIDATES = 8;

export function EvidenceUnitPicker({
  options,
  selected,
  onSelect,
  artifact,
  ranking,
}: EvidenceUnitPickerProps) {
  const [showAll, setShowAll] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const groupName = useId();
  const ranked = useMemo(
    () => rankOptions(options, artifact, ranking),
    [artifact, options, ranking],
  );
  const visible = showAll
    ? ranked
    : ranked.slice(0, DEFAULT_VISIBLE_CANDIDATES);
  const selectedOption = options.find((candidate) =>
    selected ? isSameReference(candidate.reference, selected) : false,
  );

  return (
    <section
      className="evidence-picker"
      aria-labelledby="evidence-picker-heading"
      data-testid="evidence-picker"
    >
      <div className="subsection-heading">
        <span id="evidence-picker-heading">先选择 Source Evidence</span>
        <small>{selectedOption ? "已选择" : "必选"}</small>
      </div>
      <p className="evidence-picker-hint">{rankingHint(ranking, options.length)}</p>

      {options.length === 0 ? (
        <p>当前 Source 没有可选自然段。</p>
      ) : (
        <fieldset className="evidence-picker-list">
          <legend>按推荐顺序排列的原文自然段</legend>
          {visible.map((item) => (
            <EvidenceCandidateRow
              expanded={expandedId === item.candidate.id}
              groupName={groupName}
              item={item}
              key={item.candidate.id}
              onExpand={() =>
                setExpandedId((current) =>
                  current === item.candidate.id ? null : item.candidate.id,
                )
              }
              onSelect={onSelect}
              options={options}
              selected={Boolean(
                selected &&
                  isSameReference(item.candidate.reference, selected),
              )}
            />
          ))}
        </fieldset>
      )}

      {ranked.length > DEFAULT_VISIBLE_CANDIDATES ? (
        <div className="evidence-picker-toggle">
          <span>
            当前显示 {visible.length}/{ranked.length} 段
          </span>
          <button
            className="secondary-button compact-button"
            onClick={() => setShowAll((current) => !current)}
            type="button"
          >
            {showAll ? "只显示前 8 段" : "显示全部段落"}
          </button>
        </div>
      ) : null}

      {selectedOption ? (
        <blockquote className="evidence-picker-selected">
          {truncate(selectedOption.text, 180)}
        </blockquote>
      ) : null}
    </section>
  );
}

function EvidenceCandidateRow({
  expanded,
  groupName,
  item,
  onExpand,
  onSelect,
  options,
  selected,
}: {
  expanded: boolean;
  groupName: string;
  item: RankedEvidenceCandidate<EvidencePickerOption>;
  onExpand: () => void;
  onSelect: (reference: SourceReference) => void;
  options: EvidencePickerOption[];
  selected: boolean;
}) {
  const candidate = item.candidate;
  const previous = options[item.sourceIndex - 1];
  const next = options[item.sourceIndex + 1];
  const optionDomId = `${groupName}-${item.sourceIndex}`;

  return (
    <article
      className={`evidence-candidate${selected ? " selected" : ""}`}
      data-evidence-distance={item.distance ?? ""}
      data-evidence-name-matches={item.nameMatches}
      data-evidence-unit-id={candidate.id}
      data-testid="evidence-candidate"
    >
      <div className="evidence-candidate-main">
        <input
          aria-label={`选择第 ${item.sourceIndex + 1} 段 Evidence`}
          checked={selected}
          id={optionDomId}
          name={groupName}
          onChange={() => onSelect(candidate.reference)}
          type="radio"
        />
        <label htmlFor={optionDomId}>
          <strong>
            第 {item.sourceIndex + 1} 段 · {candidate.sectionTitle}
            {selected ? <em className="review-badge">已选择</em> : null}
          </strong>
          <small>
            {candidate.id} · {candidate.start}—{candidate.end}
            {item.distance === null
              ? ""
              : ` · 距离 ${item.distance} 段`}
          </small>
          <span className="evidence-candidate-excerpt">
            {truncate(candidate.text, 110)}
          </span>
        </label>
      </div>
      <button
        aria-controls={`${optionDomId}-context`}
        aria-expanded={expanded}
        className="text-button"
        onClick={onExpand}
        type="button"
      >
        {expanded ? "收起上下文" : "预览上下文"}
      </button>
      {expanded ? (
        <div
          className="evidence-context-preview"
          data-testid="evidence-context-preview"
          id={`${optionDomId}-context`}
        >
          <ContextLine label="上一段" option={previous} />
          <ContextLine label="当前段" option={candidate} />
          <ContextLine label="下一段" option={next} />
        </div>
      ) : null}
    </article>
  );
}

function ContextLine({
  label,
  option,
}: {
  label: string;
  option: EvidencePickerOption | undefined;
}) {
  return (
    <div>
      <strong>{label}</strong>
      {option ? (
        <>
          <small>
            {option.id} · {option.start}—{option.end}
          </small>
          <p>{truncate(option.text, 260)}</p>
        </>
      ) : (
        <p>没有更多段落。</p>
      )}
    </div>
  );
}

function rankOptions(
  options: EvidencePickerOption[],
  artifact: StoryMapArtifact | undefined,
  ranking: EvidencePickerRanking | undefined,
): RankedEvidenceCandidate<EvidencePickerOption>[] {
  if (!artifact || !ranking) {
    return options.map((candidate, sourceIndex) => ({
      candidate,
      sourceIndex,
      distance: null,
      nameMatches: 0,
    }));
  }
  if (ranking.kind === "edge") {
    return rankEvidenceForEdge({
      candidates: options,
      events: artifact.storyMap.events,
      fromEventId: ranking.fromEventId,
      toEventId: ranking.toEventId,
    });
  }
  return rankEvidenceForEvent({
    candidates: options,
    event:
      artifact.storyMap.events.find((event) => event.id === ranking.eventId) ??
      null,
    characters: artifact.storyMap.characters,
  });
}

function rankingHint(
  ranking: EvidencePickerRanking | undefined,
  total: number,
): string {
  if (!ranking) {
    return `共 ${total} 段；选择后只会把这一段 Source Reference 保存到 revision。`;
  }
  if (ranking.kind === "edge") {
    return `按与两端 Event 现有 Evidence Unit 的最小距离排序；距离相同按原文顺序。共 ${total} 段。`;
  }
  return `先按与该 Event 现有 Evidence 的距离，再按参与人物姓名/别名的命中数排序。共 ${total} 段。`;
}

function isSameReference(
  left: SourceReference,
  right: SourceReference,
): boolean {
  return sourceReferenceKey(left) === sourceReferenceKey(right);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
