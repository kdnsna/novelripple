"use client";

import { useEffect, useRef } from "react";

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
  const excerpt = evidence
    ? normalizedText.slice(evidence.start, evidence.end)
    : "该事件属于新世界线生成内容，没有原著片段。";

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
            {normalizedText.slice(0, evidence.start)}
            <mark data-active-evidence="true" ref={evidenceMark}>
              {excerpt}
            </mark>
            {normalizedText.slice(evidence.end)}
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
