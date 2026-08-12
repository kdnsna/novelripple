"use client";

import { useState } from "react";

import type { SourceReference } from "@/domain/schemas";

export type EvidencePickerOption = {
  id: string;
  sectionId: string;
  sectionTitle: string;
  start: number;
  end: number;
  text: string;
  reference: SourceReference;
};

type EvidenceUnitPickerProps = {
  options: EvidencePickerOption[];
  selected: SourceReference | null;
  onSelect: (reference: SourceReference) => void;
};

export function EvidenceUnitPicker({
  options,
  selected,
  onSelect,
}: EvidenceUnitPickerProps) {
  const [optionId, setOptionId] = useState(options[0]?.id ?? "");
  const option = options.find((candidate) => candidate.id === optionId);
  const selectedOption = options.find(
    (candidate) =>
      candidate.reference.start === selected?.start &&
      candidate.reference.end === selected?.end &&
      candidate.reference.excerptHash === selected?.excerptHash,
  );

  return (
    <section className="evidence-picker" aria-labelledby="evidence-picker-heading">
      <div className="subsection-heading">
        <span id="evidence-picker-heading">先选择 Source Evidence</span>
        <small>{selectedOption ? "已选择" : "必填"}</small>
      </div>
      <label>
        原文自然段
        <select
          aria-label="原文 Evidence"
          onChange={(event) => setOptionId(event.target.value)}
          value={optionId}
        >
          {options.map((candidate, index) => (
            <option key={candidate.id} value={candidate.id}>
              Evidence {index + 1} · {candidate.sectionTitle}
            </option>
          ))}
        </select>
      </label>
      {option ? (
        <blockquote>{truncate(option.text, 180)}</blockquote>
      ) : (
        <p>当前 Source 没有可选自然段。</p>
      )}
      <button
        className="secondary-button"
        disabled={!option}
        onClick={() => option && onSelect(option.reference)}
        type="button"
      >
        {selectedOption?.id === option?.id
          ? "已选择这段 Evidence"
          : "选择这段 Evidence"}
      </button>
    </section>
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
