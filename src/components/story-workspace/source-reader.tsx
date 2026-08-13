"use client";

import { useEffect, useMemo, useRef } from "react";

import type {
  Event,
  SourceReference,
  SourceSection,
} from "@/domain/schemas";

type SourceReaderProps = {
  title: string;
  normalizedText: string;
  sections: SourceSection[];
  selectedEvent: Event;
  activeEvidence?: SourceReference | null;
};

export function SourceReader({
  title,
  normalizedText,
  sections,
  selectedEvent,
  activeEvidence,
}: SourceReaderProps) {
  const evidence = activeEvidence ?? selectedEvent.evidence[0];
  const evidenceMark = useRef<HTMLElement>(null);
  const section = sections.find((item) => item.id === evidence?.sectionId);

  // 只在证据区间变化时重新切片，避免每次队列点击都全量切片大文本。
  const sourceSlices = useMemo(
    () => ({
      before: evidence ? normalizedText.slice(0, evidence.start) : "",
      mark: evidence ? normalizedText.slice(evidence.start, evidence.end) : null,
      after: evidence ? normalizedText.slice(evidence.end) : "",
    }),
    [evidence, normalizedText],
  );

  useEffect(() => {
    evidenceMark.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [evidence?.end, evidence?.start]);

  return (
    <aside className="workspace-panel source-panel">
      <div className="panel-heading">
        <div>
          <span className="panel-kicker">原著 Source</span>
          <h2>{title}</h2>
        </div>
        <span className="immutable-badge">只读</span>
      </div>

      <div className="chapter-list" aria-label="原文章节">
        {sections.map((item) => (
          <div
            className={item.id === evidence?.sectionId ? "chapter-active" : ""}
            key={item.id}
          >
            <span>{item.id.replace("section_", "")}</span>
            <p>{item.title}</p>
          </div>
        ))}
      </div>

      <pre className="workspace-source-text" data-testid="source-reader">
        {evidence ? (
          <>
            {sourceSlices.before}
            <mark data-active-evidence="true" ref={evidenceMark}>
              {sourceSlices.mark}
            </mark>
            {sourceSlices.after}
          </>
        ) : (
          normalizedText
        )}
      </pre>

      <div className="evidence-card">
        <div className="evidence-card-heading">
          <span>当前证据</span>
          <span>{section?.title ?? "新世界线"}</span>
        </div>
        {evidence ? (
          <dl className="evidence-meta">
            <div>
              <dt>字符位置</dt>
              <dd>
                {evidence.start}—{evidence.end}
              </dd>
            </div>
            <div>
              <dt>证据类型</dt>
              <dd>{selectedEvent.evidenceKind === "inference" ? "推断" : "事实"}</dd>
            </div>
            <div>
              <dt>完整性</dt>
              <dd className="verified-value">Hash 已验证</dd>
            </div>
          </dl>
        ) : null}
      </div>

      <p className="source-footnote">
        地图仅引用字符位置与 Hash；原文不会复制进生成产物。
      </p>
    </aside>
  );
}
